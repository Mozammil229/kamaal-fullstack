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
router.get('/donut/refresh', cronOrAdminAuth, donutController.refreshFeed);
router.post('/donut/refresh', cronOrAdminAuth, donutController.refreshFeed);

module.exports = router;
