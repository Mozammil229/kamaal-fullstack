const express = require('express');
const router = express.Router();
const kamaalApiController = require('../controllers/kamaalApiController');
const apikeyCrypto = require('../services/apikeyCrypto');

// PUBLIC Kamaal API (2026-11-05). Auth is the kml_ key itself — no user
// JWT on these routes. Rate limit: 20/min per key (in-memory buckets,
// same shape as aiRoutes.js aiChatRateLimit).
const buckets = new Map();
function keyRateLimit(req, res, next) {
    const raw = String(req.headers['x-kamaal-key'] || '').trim();
    // Bucket by hash, never by the raw token value.
    const key = raw ? apikeyCrypto.sha256(raw) : (req.ip || 'unknown');
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 20;
    let entry = buckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    buckets.set(key, entry);
    if (buckets.size > 5000) buckets.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}

router.post('/chat', keyRateLimit, kamaalApiController.chat);
router.get('/status', keyRateLimit, kamaalApiController.status);

module.exports = router;
