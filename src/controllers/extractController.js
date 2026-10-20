// ============================================================================
// ALL-IN-ONE DOWNLOADER — /api/extract (2026-10-20, user-approved API list)
// ----------------------------------------------------------------------------
// ONE input (a shared/pasted link) -> platform detected by hostname -> the
// ONE approved provider for that platform is called SERVER-SIDE (the app
// never talks to providers directly) -> normalized format list returned.
//
// APPROVED PROVIDER MAP (live-verified by Mozammil 2026-10-20 ~5:35 PM PKT):
//   TikTok    -> TikWM direct API (Omega has no TikTok downloader; it wraps
//                TikWM itself) — HD / no-watermark / watermark / MP3 + sizes
//   YouTube   -> Omega /api/download/yt-dl (qualities list; per-quality URL
//                fetched lazily at tap time via /api/extract/resolve)
//                Audio -> Omega /api/download/savefrom (data.audioUrl)
//   Facebook  -> Omega /api/download/Facebook action=resolve (hd|sd, lazy)
//   X         -> Omega /api/download/X action=download (schema-only —
//                defensive media-URL digging from the JSON)
//   Instagram -> Omega /api/Stalk/Instagram action=url (schema-only —
//                defensive digging)
//   MediaFire -> Omega /api/download/Mediafire action=get (defensive)
//   Direct file links (path ends .mp4/.mp3/.zip/...) need no provider.
// FORBIDDEN (verified broken, never wired): Omega All-downloader-v2,
// All-downloader-v3, valore, aio, all.
//
// Failure discipline (user order): a provider failure NEVER reaches the user
// as a raw error — one retry on 5xx, then a plain-words message. Nothing in
// here throws past the handlers.
// ============================================================================

const OMEGA = 'https://api.omegatech.app';
const PROVIDER_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Small fetch helper: JSON GET with a hard timeout; retries ONCE on network
// error or HTTP 5xx (per user instruction). Returns parsed JSON or null.
// ---------------------------------------------------------------------------
async function fetchJsonOnce(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
                'Accept': 'application/json',
            },
        });
        if (res.status >= 500) {
            const err = new Error('HTTP ' + res.status);
            err.retryable = true;
            throw err;
        }
        const text = await res.text();
        try { return JSON.parse(text); } catch (_) { return null; }
    } finally {
        clearTimeout(timer);
    }
}

async function fetchJson(url, timeoutMs = PROVIDER_TIMEOUT_MS) {
    try {
        return await fetchJsonOnce(url, timeoutMs);
    } catch (e) {
        if (e && (e.retryable || e.name === 'AbortError' || e.code === 'ECONNRESET' || e.cause)) {
            // one retry — providers are flaky free services
            return await fetchJsonOnce(url, timeoutMs);
        }
        throw e;
    }
}

const enc = (s) => encodeURIComponent(s);

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------
const DIRECT_VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m3u8', '.avi'];
const DIRECT_AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.opus'];
const DIRECT_FILE_EXT = ['.zip', '.rar', '.7z', '.apk', '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif'];

function detectPlatform(parsed) {
    const host = (parsed.hostname || '').toLowerCase();
    const path = (parsed.pathname || '').toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) return 'youtube';
    if (/(^|\.)facebook\.com$/.test(host) || host === 'fb.watch') return 'facebook';
    if (host === 'x.com' || /(^|\.)twitter\.com$/.test(host)) return 'x';
    if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)mediafire\.com$/.test(host)) return 'mediafire';
    if (DIRECT_VIDEO_EXT.some((e) => path.endsWith(e))) return 'direct-video';
    if (DIRECT_AUDIO_EXT.some((e) => path.endsWith(e))) return 'direct-audio';
    if (DIRECT_FILE_EXT.some((e) => path.endsWith(e))) return 'direct-file';
    return null;
}

function fileNameFromUrl(parsed) {
    try {
        const seg = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'file');
        return seg || 'file';
    } catch (_) {
        return 'file';
    }
}

// ---------------------------------------------------------------------------
// Defensive media-URL digger for schema-only providers (X / Instagram /
// MediaFire): walk the JSON, collect plausible media URLs (direct media
// extensions, known media CDNs, or values under download-ish keys), dedupe,
// prefer entries that carry a bitrate (tweet-style variants). Bounded.
// ---------------------------------------------------------------------------
const MEDIA_EXT_RE = /\.(mp4|m3u8|mp3|m4a|jpg|jpeg|png|webp)(\?|#|$)/i;
const MEDIA_HOST_RE = /(video\.twimg\.com|cdninstagram\.com|fbcdn\.net|mediafire\.com|download\d*\.mediafire)/i;
const DOWNLOAD_KEY_RE = /(download|direct|media|video|audio|file|link|src)/i;

function digMediaUrls(root, limit = 8) {
    const found = []; // {url, bitrate}
    const seen = new Set();
    function push(url, bitrate) {
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
        if (seen.has(url) || found.length >= limit * 2) return;
        seen.add(url);
        found.push({ url, bitrate: typeof bitrate === 'number' ? bitrate : 0 });
    }
    function walk(node, keyHint, depth) {
        if (node == null || depth > 6) return;
        if (typeof node === 'string') {
            if (MEDIA_EXT_RE.test(node) || MEDIA_HOST_RE.test(node) || (keyHint && DOWNLOAD_KEY_RE.test(keyHint))) {
                push(node, 0);
            }
            return;
        }
        if (Array.isArray(node)) { node.forEach((v) => walk(v, keyHint, depth + 1)); return; }
        if (typeof node === 'object') {
            // tweet-style variant object: {url, bitrate, content_type}
            if (typeof node.url === 'string' && /video|audio/i.test(String(node.content_type || ''))) {
                push(node.url, node.bitrate);
            }
            for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
        }
    }
    walk(root, '', 0);
    found.sort((a, b) => b.bitrate - a.bitrate);
    return found.slice(0, limit).map((f) => f.url);
}

function kindForUrl(u) {
    if (/\.(mp3|m4a|aac|ogg|wav|flac|opus)(\?|#|$)/i.test(u)) return 'audio';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(u)) return 'image';
    return 'video';
}

// ---------------------------------------------------------------------------
// Providers — each returns {title, thumbnail, durationSeconds, formats[]}
// or throws; handlers convert throws into plain-words errors.
// ---------------------------------------------------------------------------
async function extractTikTok(url) {
    const j = await fetchJson(`https://www.tikwm.com/api/?url=${enc(url)}&hd=1`);
    const d = j && j.data;
    if (!d || (!d.play && !d.hdplay && !d.wmplay && !(Array.isArray(d.images) && d.images.length))) {
        throw new Error('PROVIDER_EMPTY');
    }
    const formats = [];
    if (d.hdplay) formats.push({ id: 'tt-hd', label: 'HD Video', kind: 'video', qualityLabel: 'HD', url: d.hdplay, sizeBytes: d.hd_size || null });
    if (d.play) formats.push({ id: 'tt-nowm', label: 'Video — bina watermark', kind: 'video', qualityLabel: 'Best', url: d.play, sizeBytes: d.size || null });
    if (d.wmplay) formats.push({ id: 'tt-wm', label: 'Video — watermark ke saath', kind: 'video', qualityLabel: 'SD', url: d.wmplay, sizeBytes: d.wm_size || null });
    if (Array.isArray(d.images)) {
        d.images.forEach((img, i) => formats.push({ id: 'tt-img-' + i, label: 'Photo ' + (i + 1), kind: 'image', qualityLabel: 'Photo', url: img, sizeBytes: null }));
    }
    if (d.music) formats.push({ id: 'tt-audio', label: 'Sirf Audio (MP3)', kind: 'audio', qualityLabel: 'MP3', url: typeof d.music === 'string' ? d.music : (d.music_info && d.music_info.play) || null, sizeBytes: null });
    return {
        title: d.title || 'TikTok Video',
        thumbnail: d.cover || d.origin_cover || null,
        durationSeconds: typeof d.duration === 'number' ? d.duration : null,
        formats: formats.filter((f) => f.url),
    };
}

async function extractYouTube(url) {
    const j = await fetchJson(`${OMEGA}/api/download/yt-dl?action=download&url=${enc(url)}`);
    const d = j && j.data;
    if (!j || j.success === false || !d) throw new Error('PROVIDER_EMPTY');
    let qualities = Array.isArray(d.availableQualities) ? d.availableQualities : [];
    qualities = [...new Set(qualities.map((q) => String(q).toUpperCase()))]
        .filter((q) => /^\d+P$/.test(q))
        .sort((a, b) => parseInt(b) - parseInt(a));
    if (!qualities.length) qualities = ['720P', '360P'];
    const formats = qualities.map((q) => ({
        id: 'yt-' + q.toLowerCase(),
        label: 'Video ' + q,
        kind: 'video',
        qualityLabel: q.toLowerCase(),
        url: null, // resolved at tap time — keeps expiring googlevideo links fresh
        sizeBytes: null,
    }));
    formats.push({ id: 'yt-audio', label: 'Sirf Audio (MP3)', kind: 'audio', qualityLabel: 'MP3', url: null, sizeBytes: null });
    return {
        title: d.title || 'YouTube Video',
        thumbnail: d.thumbnail || null,
        durationSeconds: typeof d.durationSeconds === 'number' ? d.durationSeconds : null,
        formats,
    };
}

async function extractFacebook(/* url */) {
    // Facebook provider has no info call — HD/SD are resolved at tap time.
    return {
        title: 'Facebook Video',
        thumbnail: null,
        durationSeconds: null,
        formats: [
            { id: 'fb-hd', label: 'Video HD', kind: 'video', qualityLabel: 'HD', url: null, sizeBytes: null },
            { id: 'fb-sd', label: 'Video SD', kind: 'video', qualityLabel: 'SD', url: null, sizeBytes: null },
        ],
    };
}

async function extractViaDigger(url, providerUrl, fallbackTitle) {
    const j = await fetchJson(providerUrl);
    if (!j || j.success === false) throw new Error('PROVIDER_EMPTY');
    const urls = digMediaUrls(j.data || j);
    if (!urls.length) throw new Error('PROVIDER_EMPTY');
    const data = (j && j.data) || {};
    const formats = urls.map((u, i) => ({
        id: 'dg-' + i,
        label: (kindForUrl(u) === 'audio' ? 'Audio' : kindForUrl(u) === 'image' ? 'Photo' : 'Video') + (urls.length > 1 ? ' ' + (i + 1) : ''),
        kind: kindForUrl(u),
        qualityLabel: kindForUrl(u) === 'audio' ? 'MP3' : '',
        url: u,
        sizeBytes: null,
    }));
    return {
        title: data.title || data.caption || fallbackTitle,
        thumbnail: data.thumbnail || data.cover || null,
        durationSeconds: null,
        formats,
    };
}

// ---------------------------------------------------------------------------
// POST /api/extract  {url}
// ---------------------------------------------------------------------------
const PLAIN = {
    badLink: 'Ye link theek nahi lag raha — link dobara check karke paste karo.',
    unsupported: 'Is site se download abhi nahi ho sakta. TikTok, YouTube, Facebook, X, Instagram ya MediaFire ka link do.',
    providerDown: 'Download service abhi jawab nahi de rahi — thodi dair baad phir koshish karo.',
    nothingFound: 'Is link mein koi video ya file nahi mili — link check karo.',
};

async function extract(req, res) {
    try {
        const raw = (req.body && req.body.url) || '';
        if (typeof raw !== 'string' || !raw.trim()) {
            return res.status(400).json({ success: false, error: PLAIN.badLink });
        }
        let parsed;
        try { parsed = new URL(raw.trim()); } catch (_) {
            return res.status(400).json({ success: false, error: PLAIN.badLink });
        }
        if (!/^https?:$/.test(parsed.protocol)) {
            return res.status(400).json({ success: false, error: PLAIN.badLink });
        }
        const url = parsed.toString();
        const platform = detectPlatform(parsed);

        if (!platform) {
            return res.status(422).json({ success: false, error: PLAIN.unsupported });
        }
        if (platform.startsWith('direct-')) {
            const kind = platform === 'direct-video' ? 'video' : platform === 'direct-audio' ? 'audio' : 'file';
            return res.json({
                success: true,
                platform: 'direct',
                title: fileNameFromUrl(parsed),
                thumbnail: null,
                durationSeconds: null,
                formats: [{ id: 'direct', label: 'Direct file', kind, qualityLabel: '', url, sizeBytes: null }],
            });
        }

        let out;
        try {
            if (platform === 'tiktok') out = await extractTikTok(url);
            else if (platform === 'youtube') out = await extractYouTube(url);
            else if (platform === 'facebook') out = await extractFacebook(url);
            else if (platform === 'x') out = await extractViaDigger(url, `${OMEGA}/api/download/X?action=download&url=${enc(url)}`, 'X Video');
            else if (platform === 'instagram') out = await extractViaDigger(url, `${OMEGA}/api/Stalk/Instagram?action=url&url=${enc(url)}`, 'Instagram Media');
            else if (platform === 'mediafire') out = await extractViaDigger(url, `${OMEGA}/api/download/Mediafire?action=get&url=${enc(url)}`, 'MediaFire File');
        } catch (e) {
            return res.status(502).json({ success: false, error: PLAIN.providerDown });
        }
        if (!out || !out.formats || !out.formats.length) {
            return res.status(422).json({ success: false, error: PLAIN.nothingFound });
        }
        return res.json({
            success: true,
            platform,
            title: out.title,
            thumbnail: out.thumbnail,
            durationSeconds: out.durationSeconds,
            formats: out.formats,
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: PLAIN.providerDown });
    }
}

// ---------------------------------------------------------------------------
// POST /api/extract/resolve  {url, formatId} -> {url}
// For formats whose final URL expires fast (YouTube qualities/audio,
// Facebook HD/SD): fetched fresh at tap time.
// ---------------------------------------------------------------------------
async function resolve(req, res) {
    try {
        const raw = (req.body && req.body.url) || '';
        const formatId = (req.body && req.body.formatId) || '';
        let parsed;
        try { parsed = new URL(String(raw).trim()); } catch (_) {
            return res.status(400).json({ success: false, error: PLAIN.badLink });
        }
        const url = parsed.toString();
        const platform = detectPlatform(parsed);
        let finalUrl = null;
        try {
            if (platform === 'youtube' && /^yt-\d+p$/.test(formatId)) {
                const q = formatId.slice(3); // e.g. "720p"
                const j = await fetchJson(`${OMEGA}/api/download/yt-dl?action=download&url=${enc(url)}&quality=${enc(q)}`);
                finalUrl = (j && j.data && j.data.downloadUrl) || null;
            } else if (platform === 'youtube' && formatId === 'yt-audio') {
                const j = await fetchJson(`${OMEGA}/api/download/savefrom?action=download&url=${enc(url)}`);
                finalUrl = (j && j.data && j.data.audioUrl) || null;
            } else if (platform === 'facebook' && (formatId === 'fb-hd' || formatId === 'fb-sd')) {
                const q = formatId === 'fb-hd' ? 'hd' : 'sd';
                const j = await fetchJson(`${OMEGA}/api/download/Facebook?action=resolve&url=${enc(url)}&quality=${q}`);
                finalUrl = (j && j.data && j.data.directUrl) || null;
            }
        } catch (e) {
            return res.status(502).json({ success: false, error: PLAIN.providerDown });
        }
        if (!finalUrl) {
            return res.status(422).json({ success: false, error: PLAIN.nothingFound });
        }
        return res.json({ success: true, url: finalUrl });
    } catch (e) {
        return res.status(500).json({ success: false, error: PLAIN.providerDown });
    }
}

module.exports = { extract, resolve };
