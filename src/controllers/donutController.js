const axios = require('axios');
const env = require('../config/env');
const { isDbConnected } = require('../config/db');
const DonutFeedCache = require('../models/DonutFeedCache');

// Donut feed backend (plan §3): the nightly server-side YouTube Data API v3
// fetch + the cache-only feed endpoint the app reads.
//
// BOUNDARY (plan R4): the FEED uses the official YouTube API only.
// EXTRACTION stays yt-dlp / NewPipe / backend /api/extract, untouched.
// The feed never extracts and the extractor never feeds rows.
//
// QUOTA (plan §3.2, granular buckets since 2026-06-01):
//   search.list — own bucket, 100 calls/day. This run uses 7.
//   everything else — shared pool, 10,000 units/day; videos.list = 1 unit.
//   This run uses 8 units (1 chart + 7 enrichment calls).
//   Old model (search.list = 100 units from the shared pool): 7*100 + 8 =
//   708 of 10,000 — still fits. Either model fits.
// Hard rules, code-enforced:
//   - nightly search.list calls capped at 30 (MAX_SEARCH_CALLS_PER_RUN);
//   - NO retry on HTTP 403 quotaExceeded (a retry loop on a bad request
//     eats quota — every request costs >= 1 unit even when it errors);
//   - retries only on 5xx / network errors, max 2, with backoff;
//   - page 1 only per query (maxResults=50, no pagination).
// Quota resets at midnight Pacific Time; the 12 AM PKT run (19:00 UTC)
// sits comfortably inside the fresh PT day.

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_RESULTS = 50;
const MAX_SEARCH_CALLS_PER_RUN = 30;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 8000;
// Vercel maxDuration is 60 s. Stop starting new sections after 50 s so the
// handler always answers inside the limit; sections already fetched stay
// saved, the rest keep yesterday's cache.
const RUN_DEADLINE_MS = 50 * 1000;
const RETRY_BACKOFF_MS = [600, 1500];
// The app treats a feed as stale when fetchedAt is older than 36 h.
const STALE_MS = 36 * 60 * 60 * 1000;

// Fixed server order. The app shows Trending -> Dramas -> Films first, then
// picks interest rows (naat / cricket / cooking / tech) from the rest
// on-device (§4). The exact query list is a tuning item; the CAP (30) is
// fixed. Trending uses videos.list chart=mostPopular (1 unit, NO search
// call — the cheapest trending source).
const SECTIONS = [
    { sectionId: 'trending', title: 'Trending', kind: 'trending', type: 'chart' },
    { sectionId: 'dramas', title: 'Dramas', kind: 'genre', query: 'Pakistani drama' },
    { sectionId: 'films', title: 'Films', kind: 'genre', query: 'new movie trailer' },
    { sectionId: 'pakistani-films', title: 'Pakistani Films', kind: 'genre', query: 'Pakistani film' },
    { sectionId: 'naat', title: 'Naat', kind: 'genre', query: 'naat' },
    { sectionId: 'cricket', title: 'Cricket Highlights', kind: 'genre', query: 'cricket highlights' },
    { sectionId: 'cooking', title: 'Cooking', kind: 'genre', query: 'cooking recipe Urdu' },
    { sectionId: 'tech', title: 'Tech News', kind: 'genre', query: 'tech news' }
];

// YouTube durations are ISO 8601 (PT4M13S, PT1H2M3S). Unparseable -> 0.
function parseDuration(iso) {
    if (!iso || typeof iso !== 'string') return 0;
    const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
    if (!m) return 0;
    const days = parseInt(m[1] || '0', 10);
    const hours = parseInt(m[2] || '0', 10);
    const mins = parseInt(m[3] || '0', 10);
    const secs = parseFloat(m[4] || '0');
    return days * 86400 + hours * 3600 + mins * 60 + Math.round(secs);
}

function pickThumbnail(thumbnails) {
    if (!thumbnails) return '';
    return (thumbnails.medium && thumbnails.medium.url)
        || (thumbnails.high && thumbnails.high.url)
        || (thumbnails.default && thumbnails.default.url)
        || '';
}

function isQuotaExceededError(err) {
    if (!err || !err.response) return false;
    if (err.response.status !== 403) return false;
    const data = err.response.data || {};
    const errors = Array.isArray(data.error && data.error.errors) ? data.error.errors : [];
    if (errors.some((e) => e && e.reason === 'quotaExceeded')) return true;
    const msg = String((data.error && data.error.message) || '');
    return msg.indexOf('quotaExceeded') !== -1;
}

// Retryable = network error (no response at all) or a 5xx. 4xx (incl. 403
// quotaExceeded, 400 bad request) is NEVER retried — every YouTube request
// costs quota even when it errors.
function isRetryableError(err) {
    if (!err) return false;
    if (!err.response) return true;
    const status = err.response.status;
    return status >= 500 && status < 600;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One YouTube Data API call with the quota rules above. `counters` is
// mutated: search.list bumps searchCalls, videos.list bumps units (1 each).
// Throws QuotaExceededError (err.isQuotaExceeded = true) on 403
// quotaExceeded — the caller aborts the whole run on it.
async function ytGet(apiKey, path, params, counters) {
    const url = `${YT_API_BASE}/${path}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (path === 'search/list') counters.searchCalls += 1;
            else counters.units += 1;
            const res = await axios.get(url, {
                params: { ...params, key: apiKey },
                timeout: REQUEST_TIMEOUT_MS
            });
            return res.data;
        } catch (err) {
            lastErr = err;
            if (isQuotaExceededError(err)) {
                err.isQuotaExceeded = true;
                throw err;
            }
            if (attempt < MAX_RETRIES && isRetryableError(err)) {
                await sleep(RETRY_BACKOFF_MS[attempt] || 1500);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

// Enrich a list of video ids with duration + viewCount in ONE batched
// videos.list call (50 ids max per call). Returns a Map videoId -> { durationSeconds, viewCount }.
async function enrichVideos(apiKey, videoIds, counters) {
    const out = new Map();
    const batch = videoIds.slice(0, MAX_RESULTS);
    if (batch.length === 0) return out;
    const data = await ytGet(apiKey, 'videos/list', {
        part: 'contentDetails,statistics',
        id: batch.join(',')
    }, counters);
    for (const v of (data.items || [])) {
        out.set(v.id, {
            durationSeconds: parseDuration(v.contentDetails && v.contentDetails.duration),
            viewCount: parseInt((v.statistics && v.statistics.viewCount) || '0', 10) || 0
        });
    }
    return out;
}

// Fetch one section's items (page 1 only, max 50). Returns the item array.
async function fetchSection(apiKey, section, counters) {
    let rawItems = [];
    if (section.type === 'chart') {
        const data = await ytGet(apiKey, 'videos/list', {
            part: 'snippet,contentDetails,statistics',
            chart: 'mostPopular',
            regionCode: 'PK',
            maxResults: MAX_RESULTS
        }, counters);
        rawItems = (data.items || []).map((v) => ({
            videoId: v.id,
            title: (v.snippet && v.snippet.title) || '',
            channelTitle: (v.snippet && v.snippet.channelTitle) || '',
            thumbnailUrl: pickThumbnail(v.snippet && v.snippet.thumbnails),
            durationSeconds: parseDuration(v.contentDetails && v.contentDetails.duration),
            viewCount: parseInt((v.statistics && v.statistics.viewCount) || '0', 10) || 0,
            publishedAt: (v.snippet && v.snippet.publishedAt) ? new Date(v.snippet.publishedAt) : null
        }));
    } else {
        // Hard cap: never exceed MAX_SEARCH_CALLS_PER_RUN search.list calls
        // in one night, even if the section list grows later.
        if (counters.searchCalls >= MAX_SEARCH_CALLS_PER_RUN) {
            throw new Error('SEARCH_CALL_CAP_REACHED');
        }
        const data = await ytGet(apiKey, 'search/list', {
            part: 'snippet',
            q: section.query,
            type: 'video',
            regionCode: 'PK',
            maxResults: MAX_RESULTS
        }, counters);
        const found = [];
        const ids = [];
        for (const v of (data.items || [])) {
            const videoId = v.id && v.id.videoId;
            if (!videoId) continue;
            found.push({
                videoId,
                title: (v.snippet && v.snippet.title) || '',
                channelTitle: (v.snippet && v.snippet.channelTitle) || '',
                thumbnailUrl: pickThumbnail(v.snippet && v.snippet.thumbnails),
                publishedAt: (v.snippet && v.snippet.publishedAt) ? new Date(v.snippet.publishedAt) : null
            });
            ids.push(videoId);
        }
        const enriched = await enrichVideos(apiKey, ids, counters);
        rawItems = found.map((f) => ({
            ...f,
            durationSeconds: (enriched.get(f.videoId) || {}).durationSeconds || 0,
            viewCount: (enriched.get(f.videoId) || {}).viewCount || 0
        }));
    }
    // Dedupe by videoId, keep API order, cap at 50.
    const seen = new Set();
    const items = [];
    for (const it of rawItems) {
        if (!it.videoId || seen.has(it.videoId)) continue;
        seen.add(it.videoId);
        items.push(it);
        if (items.length >= MAX_RESULTS) break;
    }
    return items;
}

// Nightly refresh. Idempotent: re-running the same night overwrites the
// same section docs (upsert by _id), never duplicates. A failed section
// keeps yesterday's items — only successfully fetched sections are
// overwritten. The meta doc records this run's quota use + lastError.
async function refreshFeed(req, res) {
    const apiKey = (env.YOUTUBE_API_KEY || '').trim();
    if (!apiKey) {
        // Pre-first-run state: the user has not created the key yet (his
        // step, plan §3.1). Honest 503, nothing touched.
        return res.status(503).json({
            success: false,
            error: 'YOUTUBE_API_KEY_NOT_CONFIGURED',
            message: 'YouTube API key is not set in the server environment yet. The nightly feed cannot run until it is.'
        });
    }
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }

    const startedAt = Date.now();
    const deadline = startedAt + RUN_DEADLINE_MS;
    const counters = { searchCalls: 0, units: 0 };
    const updated = [];
    let lastError = '';
    let quotaHit = false;

    for (const section of SECTIONS) {
        if (Date.now() > deadline) {
            lastError = 'RUN_DEADLINE_EXCEEDED: stopped starting new sections after 50s; updated sections are saved, the rest keep the previous cache.';
            break;
        }
        try {
            const items = await fetchSection(apiKey, section, counters);
            const now = new Date();
            await DonutFeedCache.findOneAndUpdate(
                { _id: section.sectionId },
                { sectionId: section.sectionId, title: section.title, kind: section.kind, items, fetchedAt: now },
                { upsert: true, new: true }
            );
            updated.push(section.sectionId);
        } catch (err) {
            if (err && err.isQuotaExceeded) {
                quotaHit = true;
                lastError = 'QUOTA_EXCEEDED: YouTube quota bucket exhausted for today; the previous cache is still served. No retries were made.';
                break;
            }
            // One bad section must not kill the whole night: record it and
            // keep going with the remaining sections.
            lastError = `SECTION_FAILED ${section.sectionId}: ${(err && err.message) || 'unknown error'}`;
            console.warn('[Donut] section fetch failed:', section.sectionId, (err && err.message) || err);
        }
    }

    const now = new Date();
    const metaUpdate = {
        searchCallsUsed: counters.searchCalls,
        unitsUsed: counters.units,
        lastError
    };
    // fetchedAt on the meta doc moves only when at least one section was
    // refreshed this run — a fully failed run leaves it (and the cache) old.
    if (updated.length > 0) metaUpdate.fetchedAt = now;
    await DonutFeedCache.findOneAndUpdate(
        { _id: 'meta' },
        { $set: metaUpdate, $setOnInsert: { sectionId: 'meta', title: '', kind: 'meta', items: [] } },
        { upsert: true, new: true }
    );

    return res.json({
        success: true,
        sectionsUpdated: updated,
        sectionsTotal: SECTIONS.length,
        searchCallsUsed: counters.searchCalls,
        unitsUsed: counters.units,
        quotaExceeded: quotaHit,
        fetchedAt: updated.length > 0 ? now.toISOString() : null,
        lastError,
        partial: updated.length < SECTIONS.length
    });
}

// GET /api/donut/feed — cache ONLY. ZERO YouTube calls: reads MongoDB and
// nothing else. The nightly cron is the only thing that ever calls YouTube.
// Privacy (§4.2): no per-user data is read, written, or logged here — the
// feed is identical for every user and the server must not log per-user
// feed requests for profiling.
async function getFeed(req, res) {
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }
    try {
        const docs = await DonutFeedCache.find({
            _id: { $in: SECTIONS.map((s) => s.sectionId) }
        }).lean();
        const meta = await DonutFeedCache.findOne({ _id: 'meta' }).lean();
        const byId = new Map(docs.map((d) => [d._id, d]));
        const sections = SECTIONS.map((s) => {
            const d = byId.get(s.sectionId);
            return {
                sectionId: s.sectionId,
                title: s.title,
                kind: s.kind,
                items: (d && d.items) || [],
                fetchedAt: d && d.fetchedAt ? new Date(d.fetchedAt).toISOString() : null
            };
        });
        const fetchedAt = meta && meta.fetchedAt ? new Date(meta.fetchedAt) : null;
        const stale = !fetchedAt || (Date.now() - fetchedAt.getTime() > STALE_MS);
        return res.json({
            success: true,
            sections,
            fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
            stale,
            lastError: (meta && meta.lastError) || ''
        });
    } catch (err) {
        console.warn('[Donut] feed read error:', err.message);
        return res.status(503).json({ success: false, error: 'Feed cache unavailable.' });
    }
}

module.exports = {
    getFeed,
    refreshFeed,
    // Exported for tests only (not routes).
    _test: { parseDuration, isQuotaExceededError, isRetryableError, SECTIONS, MAX_SEARCH_CALLS_PER_RUN, STALE_MS }
};
