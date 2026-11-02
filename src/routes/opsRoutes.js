const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const opsController = require('../controllers/opsController');
// MULTI-AGENT P2 — task coordination routes (same auth + rate limit as P1).
const opsTasksController = require('../controllers/opsTasksController');
const { requireAdminAuth } = require('../middleware/auth');
const env = require('../config/env');

// MULTI-AGENT P1 — ops audit trail routes.
// POST /api/ops/audit — log one agent action (append-only).
// GET  /api/ops/audit — read the trail (future Mission Control UI).
//
// AUTH: internal key OR admin JWT — same dual pattern as donutRoutes'
// cronOrAdminAuth. The internal key is sent as
// `Authorization: Bearer <OPS_INTERNAL_KEY>` and compared timing-safe so it
// cannot be probed byte-by-byte. The admin-JWT path lets the future
// admin.html Mission Control section read/write behind its existing auth.
// If OPS_INTERNAL_KEY is unset, the key path is closed and only admin auth
// works. NEVER log or print the key anywhere.
function opsAuth(req, res, next) {
    const secret = (env.OPS_INTERNAL_KEY || '').trim();
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (secret && token && token.length === secret.length) {
        try {
            if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
                return next();
            }
        } catch (_) {
            // Lengths are equal-checked above; fall through to admin auth.
        }
    }
    return requireAdminAuth(req, res, next);
}

// Light per-IP rate limit (same best-effort in-memory bucket pattern as
// newsRoutes.js / aiRoutes.js — each Vercel instance keeps its own).
const opsBuckets = new Map();
function opsRateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 120; // 120 ops writes/reads per min per IP — internal use
    let entry = opsBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    opsBuckets.set(key, entry);
    if (opsBuckets.size > 5000) opsBuckets.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}

router.post('/ops/audit', opsRateLimit, opsAuth, opsController.postAuditEvent);
router.get('/ops/audit', opsRateLimit, opsAuth, opsController.getAuditEvents);

// MULTI-AGENT P2 — task coordination (same opsAuth + opsRateLimit; the /api
// mount stays BEFORE socialRoutes in app.js — untouched).
router.post('/ops/tasks', opsRateLimit, opsAuth, opsTasksController.postTask);
router.get('/ops/tasks', opsRateLimit, opsAuth, opsTasksController.getTasks);
router.get('/ops/tasks/:id', opsRateLimit, opsAuth, opsTasksController.getTask);
router.patch('/ops/tasks/:id', opsRateLimit, opsAuth, opsTasksController.patchTask);
router.get('/ops/inbox/:agent', opsRateLimit, opsAuth, opsTasksController.getInbox);

module.exports = router;
