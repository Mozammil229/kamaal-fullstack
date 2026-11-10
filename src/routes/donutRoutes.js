const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const donutController = require('../controllers/donutController');
const { authenticateUser, requireAdminAuth } = require('../middleware/auth');
const env = require('../config/env');

// Donut feed routes (plan §3.4).
// GET /api/donut/feed — cache-only, JWT (authenticateUser, D9 recommended).
router.get('/donut/feed', authenticateUser, donutController.getFeed);

// Refresh auth: EITHER the Vercel Cron secret OR admin auth.
// Vercel Cron sends GET with `Authorization: Bearer <CRON_SECRET>` —
// Vercel auto-provisions CRON_SECRET when a `crons` entry deploys. The
// admin manual refresh (POST, ADMIN_JWT) is the only manual trigger; the
// app never triggers a fetch. Timing-safe compare so the secret cannot be
// probed byte-by-byte. If CRON_SECRET is unset, the cron path is closed
// and only admin auth works.
function cronOrAdminAuth(req, res, next) {
    const secret = (env.CRON_SECRET || '').trim();
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

// GET  /api/donut/refresh — Vercel Cron (nightly 12 AM PKT, 19:00 UTC).
// POST /api/donut/refresh — admin manual re-run (ADMIN_JWT).
// 4E F-03: the GET used to accept cookie-presented admin auth too — but
// GET /donut/refresh is STATE-CHANGING (YouTube Data API calls + DB
// writes), and a top-level GET navigation SENDS Lax cookies, so any site
// could trigger a refresh by getting an admin to visit a link (a GET
// CSRF the csrfGuard cannot cover — it only guards POST/PUT/DELETE/
// PATCH). The GET therefore accepts ONLY the cron secret now; cookie
// auth is never accepted on it. The POST keeps cronOrAdminAuth (admin
// manual re-run, CSRF-guarded when cookie-authenticated). Vercel Cron
// invokes by GET with `Authorization: Bearer <CRON_SECRET>` — unchanged.
function cronOnlyAuth(req, res, next) {
    const secret = (env.CRON_SECRET || '').trim();
    const auth = req.headers['authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (secret && token && token.length === secret.length) {
        try {
            if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
                return next();
            }
        } catch (_) {
            // Lengths are equal-checked above; fall through to 401.
        }
    }
    return res.status(401).json({ success: false, error: 'Unauthorized: cron secret required.' });
}

router.get('/donut/refresh', cronOnlyAuth, donutController.refreshFeed);
router.post('/donut/refresh', cronOrAdminAuth, donutController.refreshFeed);

module.exports = router;
