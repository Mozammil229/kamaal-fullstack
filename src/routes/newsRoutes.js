const express = require('express');
const router = express.Router();
const newsController = require('../controllers/newsController');

// NEWS MODE N1 + N2 — public headline endpoints (no JWT; see controller).
// Light per-IP rate limit so one client cannot churn the RSS fetch path.
// Same best-effort in-memory bucket pattern as aiRoutes.js (each Vercel
// instance keeps its own).
const newsBuckets = new Map();
function newsRateLimit(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 60; // 60 news reads/min per IP — generous, headlines are cheap
    let entry = newsBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    newsBuckets.set(key, entry);
    if (newsBuckets.size > 5000) newsBuckets.clear();
    if (entry.count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)))); // 4D (W4): every 429 carries Retry-After (seconds until this bucket resets).
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}

// GET /api/news — top Pakistan headlines.
router.get('/news', newsRateLimit, newsController.getTopHeadlines);
// GET /api/news/search?q=<topic> — topic search (q required, 400 if missing).
router.get('/news/search', newsRateLimit, newsController.searchNews);

module.exports = router;
