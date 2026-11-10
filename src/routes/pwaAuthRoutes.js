'use strict';

// 4D (PWA cookie auth) — POST /api/pwa/auth/*.
// Mounted BEFORE socialRoutes in app.js on purpose: socialRoutes' blanket
// router.use(authenticateUser) would 401 the unauthenticated login/refresh
// calls before these handlers ever run (same trap as donut/news/ops/web).

const express = require('express');
const router = express.Router();
const pwaAuthController = require('../controllers/pwaAuthController');
const { authenticateUser } = require('../middleware/auth');
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
router.post('/refresh', pwaAuthController.refresh);
router.post('/logout', authenticateUser, pwaAuthController.logout);
router.post('/logout-everywhere', authenticateUser, pwaAuthController.logoutEverywhere);

module.exports = router;
