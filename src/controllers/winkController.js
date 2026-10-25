'use strict';
// v66 — Wink AI video enhancer endpoints. Stateless JSON proxy only: the
// server NEVER receives video bytes (the app uploads directly to Qiniu).
// All endpoints are JWT-gated; the username comes ONLY from the verified
// JWT (never the request body). FREE at launch — no credit touch anywhere
// (see v66-ledger.md: a charge later is a server constant, not an app change).

const winkService = require('../services/winkService');
const { WinkError } = winkService;

// Per-user in-memory throttle, same best-effort pattern as loginRateLimit
// in authRoutes (Vercel serverless instances each keep their own bucket;
// a cold start resets it — documented, accepted: the guard is against
// one user hammering Wink through us, not a billing control).
const buckets = new Map();
function winkRateLimit(max, windowMs) {
    return (req, res, next) => {
        const username = req.user && req.user.username ? String(req.user.username) : 'unknown';
        const now = Date.now();
        const key = `${username}`;
        let entry = buckets.get(key);
        if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
        entry.count += 1;
        buckets.set(key, entry);
        if (buckets.size > 5000) buckets.clear();
        if (entry.count > max) {
            return res.status(429).json({
                success: false,
                error: 'Too many enhance requests. Try again later.',
            });
        }
        next();
    };
}
const startLimit = winkRateLimit(20, 60 * 60 * 1000); // 20 job-starts / hour / user
const pollLimit = winkRateLimit(300, 60 * 60 * 1000); // 300 polls / hour / user

function sendWinkError(res, err) {
    if (err instanceof WinkError) {
        return res.status(err.status).json({ success: false, error: err.message, code: err.code });
    }
    return res.status(502).json({ success: false, error: 'Wink service error.', code: 'wink_error' });
}

function bodyOf(req) {
    return req.body && typeof req.body === 'object' ? req.body : {};
}

// POST /api/wink/sign — fresh gnum + maat sign. Starts a job.
async function sign(req, res) {
    try {
        const gnum = winkService.newGnum();
        const signData = await winkService.getMaatSign(gnum);
        return res.json({ success: true, gnum, sign: signData });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// POST /api/wink/policy — Qiniu upload policy for a sign. Body: { gnum, sign }.
async function policy(req, res) {
    try {
        const { gnum, sign } = bodyOf(req);
        const qiniu = await winkService.getUploadPolicy(gnum, sign);
        return res.json({ success: true, qiniu });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// POST /api/wink/video-info — body: { gnum, file_key }.
async function videoInfo(req, res) {
    try {
        const { gnum, file_key } = bodyOf(req);
        const data = await winkService.getVideoInfo(gnum, file_key);
        return res.json({ success: true, data });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// POST /api/wink/transcode/start — body: { gnum, file_key }.
async function transcodeStart(req, res) {
    try {
        const { gnum, file_key } = bodyOf(req);
        const id = await winkService.startTranscode(gnum, file_key);
        return res.json({ success: true, id });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// GET /api/wink/transcode/status?gnum=...&id=...
async function transcodeStatus(req, res) {
    try {
        const data = await winkService.queryTranscode(req.query.gnum, req.query.id);
        return res.json({ success: true, data });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// POST /api/wink/delivery — body: { gnum, source_url, video_transcoded, task_name }.
async function delivery(req, res) {
    try {
        const { gnum, source_url, video_transcoded, task_name } = bodyOf(req);
        const out = await winkService.createDelivery(gnum, { source_url, video_transcoded, task_name });
        return res.json({ success: true, msg_id: out.msg_id, prepare_msg_id: out.prepare_msg_id });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

// GET /api/wink/result?gnum=...&msg_ids=...
async function result(req, res) {
    try {
        const data = await winkService.queryBatch(req.query.gnum, req.query.msg_ids);
        return res.json({ success: true, data });
    } catch (e) {
        return sendWinkError(res, e);
    }
}

module.exports = {
    sign,
    policy,
    videoInfo,
    transcodeStart,
    transcodeStatus,
    delivery,
    result,
    startLimit,
    pollLimit,
};
