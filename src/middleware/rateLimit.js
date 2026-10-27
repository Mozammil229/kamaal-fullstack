'use strict';

// v91 — shared in-memory rate limiter (BugHunter backend F15).
// Best-effort per-instance buckets, same pattern as the existing limiters
// (aiRoutes/login). On Vercel the bucket is per-instance, not per-user —
// it stops casual abuse, not a distributed attack. DB-backed limiting is
// a future step, not this hotfix.

function rateLimit({ windowMs, max, keyFn, message }) {
    const buckets = new Map();
    return function (req, res, next) {
        const key = (keyFn ? keyFn(req) : null) || req.user?.username || req.ip || 'unknown';
        const now = Date.now();
        let entry = buckets.get(key);
        if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
        entry.count += 1;
        buckets.set(key, entry);
        if (buckets.size > 5000) buckets.clear();
        if (entry.count > max) {
            return res.status(429).json({ success: false, error: message || 'Too many requests. Please slow down.' });
        }
        next();
    };
}

module.exports = { rateLimit };
