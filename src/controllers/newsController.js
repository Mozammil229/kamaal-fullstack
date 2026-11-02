// News backend — NEWS MODE N1 + N2 (user order 2026-11-02).
//
// Server-side Google News RSS (free, keyless, no API key). Endpoints:
//   GET /api/news          — top Pakistan headlines
//   GET /api/news/search   — topic search (?q= required)
//
// BOUNDARY (explicit per the 2026-11-02 order): the feed uses the official
// Google News RSS endpoints ONLY. x.com / Twitter is NOT scraped (ToS
// violation) and has no free API — it is out of scope, honestly.
// The user's "Google se" ask is satisfied by news.google.com/rss.
//
// AUTH: these routes are OPEN (no JWT) — headlines are public data, the
// upstream is keyless, and per-request cost to us is ~zero. Abuse is capped
// by (a) the per-IP rate limit in newsRoutes.js, (b) the 10-min in-memory
// cache below, and (c) Google's own serving. The app's Retrofit client may
// still send its JWT — open routes simply ignore it.
//
// NO new dependencies: RSS is parsed with a small defensive hand-rolled
// parser (Google News RSS has a stable, simple <item> shape). Adding
// xml2js/fast-xml-parser would pull new packages into a frozen lockfile
// for no real gain — documented choice.
const axios = require('axios');

const NEWS_RSS_SEARCH_URL = (q) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-PK&gl=PK&ceid=PK:en`;
const NEWS_RSS_TOP_PK =
    'https://news.google.com/rss?gl=PK&hl=en-PK&ceid=PK:en';

const MAX_ITEMS = 10;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — don't hammer Google per call
const REQUEST_TIMEOUT_MS = 8000;
const MAX_QUERY_LEN = 200;

// Test hook (documented): NEWS_RSS_OVERRIDE replaces the fetch URL for the
// top-headlines endpoint; NEWS_RSS_SEARCH_OVERRIDE replaces the search URL
// template (must contain '{q}' for the encoded query). Used by local tests
// to prove the honest-error path without faking the internet.
function topUrls() {
    if (process.env.NEWS_RSS_OVERRIDE) return [process.env.NEWS_RSS_OVERRIDE];
    return [NEWS_RSS_SEARCH_URL('Pakistan'), NEWS_RSS_TOP_PK];
}
function searchUrl(q) {
    if (process.env.NEWS_RSS_SEARCH_OVERRIDE) {
        return process.env.NEWS_RSS_SEARCH_OVERRIDE.replace('{q}', encodeURIComponent(q));
    }
    return NEWS_RSS_SEARCH_URL(q);
}

// ---- In-memory cache (per Vercel instance; same pattern as the repo's
// aiChatBuckets — best-effort, each serverless instance keeps its own) ----
const cache = new Map();
function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return entry;
}
function setCache(key, items) {
    if (cache.size > 500) cache.clear();
    cache.set(key, { items, fetchedAt: Date.now() });
}

// ---- Minimal RSS parsing ----
function decodeEntities(s) {
    if (!s) return '';
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&amp;/g, '&');
}

function parseRssItems(xml) {
    const items = [];
    if (!xml || typeof xml !== 'string') return items;
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    const pick = (block, re) => {
        const mm = re.exec(block);
        return mm ? decodeEntities(mm[1]).trim() : '';
    };
    while ((m = itemRe.exec(xml)) && items.length < MAX_ITEMS) {
        const block = m[1];
        const title = pick(block, /<title>([\s\S]*?)<\/title>/i);
        if (!title) continue;
        const link = pick(block, /<link>([\s\S]*?)<\/link>/i);
        const source = pick(block, /<source[^>]*>([\s\S]*?)<\/source>/i);
        const pubRaw = pick(block, /<pubDate>([\s\S]*?)<\/pubDate>/i);
        let publishedAt = null;
        if (pubRaw) {
            const d = new Date(pubRaw);
            if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
        }
        items.push({ title, source, publishedAt, url: link });
    }
    return items;
}

async function fetchRss(url) {
    const resp = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        maxContentLength: 2 * 1024 * 1024,
        headers: { 'User-Agent': 'KamaalApp/1.0 (server news fetch)' }
    });
    return resp.data;
}

function fetchErrorJson(err) {
    // Honest error: never leak stack traces in production; keep the
    // message useful in dev. Follows the repo's global error convention.
    const detail = process.env.NODE_ENV === 'production'
        ? undefined
        : (err && err.message ? String(err.message).slice(0, 200) : undefined);
    return { success: false, error: 'News fetch failed. Please try again.', ...(detail ? { detail } : {}) };
}

// GET /api/news — top Pakistan headlines (cache-first).
async function getTopHeadlines(req, res) {
    try {
        const hit = getCache('top');
        if (hit) {
            return res.json({
                success: true, cached: true, fetchedAt: hit.fetchedAt,
                headlines: hit.items
            });
        }
        let xml = null;
        let lastErr = null;
        for (const url of topUrls()) {
            try { xml = await fetchRss(url); break; }
            catch (e) { lastErr = e; }
        }
        if (!xml) return res.status(502).json(fetchErrorJson(lastErr));
        const items = parseRssItems(xml);
        setCache('top', items);
        return res.json({
            success: true, cached: false, fetchedAt: Date.now(),
            headlines: items
        });
    } catch (err) {
        return res.status(502).json(fetchErrorJson(err));
    }
}

// GET /api/news/search?q=<topic> — topic search (cache-first).
async function searchNews(req, res) {
    try {
        const q = (req.query.q || '').toString().trim();
        if (!q) {
            return res.status(400).json({
                success: false, error: 'Missing required query param: q'
            });
        }
        if (q.length > MAX_QUERY_LEN) {
            return res.status(400).json({
                success: false, error: `Query too long (max ${MAX_QUERY_LEN} chars).`
            });
        }
        const key = 'search:' + q.toLowerCase();
        const hit = getCache(key);
        if (hit) {
            return res.json({
                success: true, cached: true, query: q, fetchedAt: hit.fetchedAt,
                headlines: hit.items
            });
        }
        let xml;
        try {
            xml = await fetchRss(searchUrl(q));
        } catch (err) {
            return res.status(502).json(fetchErrorJson(err));
        }
        const items = parseRssItems(xml);
        setCache(key, items);
        return res.json({
            success: true, cached: false, query: q, fetchedAt: Date.now(),
            headlines: items
        });
    } catch (err) {
        return res.status(502).json(fetchErrorJson(err));
    }
}

module.exports = { getTopHeadlines, searchNews, parseRssItems, decodeEntities };
