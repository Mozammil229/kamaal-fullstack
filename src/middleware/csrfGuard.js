'use strict';

// 4D (PWA cookie auth) — CSRF guard (double-submit cookie pattern).
//
// Enforces ONLY when the request is cookie-authenticated (the
// `kamaal_access` cookie is present). Bearer-authenticated requests carry
// no cookie the browser would attach cross-site, so they are naturally
// CSRF-resistant and SKIP the check — the Android app never sends the
// header and must never 403. Requests with no cookie at all also skip:
// unauthenticated public routes are unaffected.
//
// Exempt (session-establishing, no authenticated session exists yet):
//   POST /api/pwa/auth/login, POST /api/pwa/auth/refresh,
//   POST /api/admin/login, POST /api/auth/login, POST /api/login.
// Everything else state-changing (POST/PUT/DELETE/PATCH) under /api with
// an access cookie requires header X-CSRF-Token to equal the
// `kamaal_csrf` cookie value (compared on SHA-256 digests, timing-safe).

const crypto = require('crypto');
const { parseCookies, ACCESS_COOKIE, CSRF_COOKIE } = require('../utils/pwaCookies');

const STATE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// req.path inside a router mounted at /api is the path after /api.
const EXEMPT_PATHS = new Set([
    'POST /pwa/auth/login',
    'POST /pwa/auth/refresh',
    'POST /admin/login',
    'POST /auth/login',
    'POST /login'
]);

function csrfGuard(req, res, next) {
    if (!STATE_METHODS.has(req.method)) return next();
    const cookies = parseCookies(req);
    if (!cookies[ACCESS_COOKIE]) return next(); // Bearer / anonymous: skip.
    if (EXEMPT_PATHS.has(`${req.method} ${req.path}`)) return next();

    const header = req.headers['x-csrf-token'];
    const cookie = cookies[CSRF_COOKIE];
    const fail = () => res.status(403).json({
        success: false,
        error: 'CSRF token missing or invalid.',
        errorCode: 'CSRF_INVALID'
    });
    if (typeof header !== 'string' || !header || typeof cookie !== 'string' || !cookie) return fail();
    const h = crypto.createHash('sha256').update(header).digest();
    const c = crypto.createHash('sha256').update(cookie).digest();
    if (!crypto.timingSafeEqual(h, c)) return fail();
    return next();
}

module.exports = { csrfGuard };
