'use strict';

// 4D (PWA cookie auth) — POST /api/pwa/auth/*.
// Mounted BEFORE socialRoutes in app.js on purpose: socialRoutes' blanket
// router.use(authenticateUser) would 401 the unauthenticated login/refresh
// calls before these handlers ever run (same trap as donut/news/ops/web).

const express = require('express');
const router = express.Router();
const pwaAuthController = require('../controllers/pwaAuthController');
const { rateLimit } = require('../middleware/rateLimit');

// Login throttle: 10/min per IP AND 5/min per username (shared in-memory
// buckets, same pattern as the app login limiter).
const pwaLoginIpLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Too many login attempts. Try again in a minute.'
});
const pwaLoginUserLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    keyFn: (req) => {
        const id = String(req.body?.email || req.body?.username || req.body?.phone || '').trim().toLowerCase();
        return id ? `pwa-login-user:${id}` : null;
    },
    message: 'Too many login attempts for this account. Try again in a minute.'
});

router.post('/login', pwaLoginIpLimit, pwaLoginUserLimit, pwaAuthController.login);
// 4E F-05: refresh had no limiter — a stolen refresh token could be
// hammered forever. 30/min per IP (shared rateLimit, so 429s carry
// Retry-After). Legit clients refresh at most once per 15 min.
const pwaRefreshLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'Too many refresh attempts. Try again in a minute.'
});
router.post('/refresh', pwaRefreshLimit, pwaAuthController.refresh);
// 4E F-01/F-02: GET /api/pwa/auth/csrf — hands the double-submit CSRF
// value to an already-authenticated (cookie) session. GET, so the CSRF
// guard does not apply to it.
router.get('/csrf', pwaAuthController.getCsrfToken);
router.post('/logout', pwaAuthController.logoutAuth, pwaAuthController.logout);
router.post('/logout-everywhere', pwaAuthController.logoutAuth, pwaAuthController.logoutEverywhere);

module.exports = router;
