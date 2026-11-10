const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');
const RevokedToken = require('../models/RevokedToken');
const { isDbConnected } = require('../config/db');
const { parseCookies, ACCESS_COOKIE, ADMIN_COOKIE } = require('../utils/pwaCookies');

// In-memory fallback revocation cache for resilience if DB connection is intermittent.
// 4A (F-01 residual): the set was unbounded — cap it (FIFO evict oldest) so a
// long-lived process cannot grow memory without limit. The DB check is the
// source of truth; this cache is only a fast path.
const MAX_LOCAL_REVOCATIONS = 10000;
const localRevocationSet = new Set();
function addLocalRevocation(thash) {
    if (localRevocationSet.has(thash)) return;
    if (localRevocationSet.size >= MAX_LOCAL_REVOCATIONS) {
        const oldest = localRevocationSet.values().next().value;
        localRevocationSet.delete(oldest);
    }
    localRevocationSet.add(thash);
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token).trim()).digest('hex');
}

async function isTokenRevoked(token) {
    const thash = hashToken(token);
    if (localRevocationSet.has(thash)) return true;

    if (isDbConnected()) {
        try {
            const found = await RevokedToken.findOne({ tokenHash: thash });
            if (found) {
                addLocalRevocation(thash);
                return true;
            }
        } catch (e) {
            // v91 (BugHunter backend F26): fail CLOSED when the DB is up but
            // the revocation lookup itself errors — a logged-out token must
            // not slip through on a transient query failure. When the DB is
            // down entirely the in-memory set above is the only check.
            console.warn('Revoked token check error (failing closed):', e.message);
            return true;
        }
    }
    return false;
}

async function revokeToken(token, reason = 'logout') {
    if (!token) return;
    const thash = hashToken(token);
    addLocalRevocation(thash);

    if (isDbConnected()) {
        try {
            await RevokedToken.create({ tokenHash: thash, reason });
        } catch (e) {
            console.warn('Persistent token revocation error:', e.message);
        }
    }
}

// User JWT Auth Middleware.
// 4D (PWA cookie auth): accepts EITHER a valid Authorization: Bearer
// header (existing behaviour FIRST, untouched — Android 30d tokens keep
// working byte-for-byte) OR the `kamaal_access` cookie. The cookie path
// runs the SAME checks: revocation, jwt.verify with JWT_SECRET, banned
// check. Cookie tokens must additionally carry typ:'pwa-access' — an
// Android 30d token placed in a cookie is NOT accepted as a cookie
// session (the two transports stay separate). The opaque refresh token
// is not a JWT, so jwt.verify fails on it -> 401, which is correct.
async function authenticateUser(req, res, next) {
    const authHeader = req.headers['authorization'];
    let token = null;
    let viaCookie = false;
    if (authHeader && typeof authHeader === 'string' && authHeader.trim()) {
        // Bearer header present -> it owns the request (existing behaviour:
        // a present-but-empty Bearer answers 'Token missing.', never falls
        // back to the cookie).
        token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (!token) {
            return res.status(401).json({ success: false, error: 'Token missing.' });
        }
    } else {
        // No Bearer header at all -> try the PWA access cookie.
        const cookieToken = parseCookies(req)[ACCESS_COOKIE];
        if (cookieToken) {
            token = String(cookieToken).trim();
            viaCookie = true;
        }
    }
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authorization header required.' });
    }

    if (await isTokenRevoked(token)) {
        return res.status(401).json({ success: false, error: 'Session token has been revoked.' });
    }

    try {
        const decoded = jwt.verify(token, env.JWT_SECRET);
        if (viaCookie && decoded.typ !== 'pwa-access') {
            return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
        }
        req.user = decoded;
        // v91 (BugHunter backend F11): banned users kept nearly full API
        // access because only a few handlers checked status. The check now
        // lives here, once, for every JWT route. A DB-lookup failure fails
        // OPEN (the DB is required by the handlers anyway — they 503 without
        // it) so a transient blip cannot lock out every user.
        if (decoded && decoded.username) {
            try {
                const User = require('../models/User');
                const u = await User.findOne({ username: decoded.username }).select('status').lean();
                if (u && u.status === 'banned') {
                    return res.status(403).json({ success: false, error: 'Account banned.' });
                }
            } catch (e) {
                console.warn('Banned check lookup failed (failing open):', e.message);
            }
        }
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
}

// Admin Auth Middleware (Requires either valid signed admin JWT or verified admin credential)
// 4D: ALSO accepts the `kamaal_admin` cookie (the admin JWT the admin
// login sets). A cookie token is verified as an admin JWT ONLY — the
// ADMIN_PASS direct-credential fallback applies to header tokens only,
// never to a cookie value. Admin and user tokens never mix: an admin JWT
// is verified here against ADMIN_JWT_SECRET only, and a user token is
// never accepted by this middleware (nor an admin token by
// authenticateUser, which verifies against JWT_SECRET only).
async function requireAdminAuth(req, res, next) {
    const headerToken = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    let rawToken = headerToken;
    let viaCookie = false;
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
        const cookieToken = parseCookies(req)[ADMIN_COOKIE];
        if (cookieToken) {
            rawToken = cookieToken;
            viaCookie = true;
        }
    }
    if (!rawToken || typeof rawToken !== 'string') {
        return res.status(401).json({ success: false, error: 'Unauthorized: Admin authentication token required.' });
    }

    const token = rawToken.trim();

    // Check revocation
    if (await isTokenRevoked(token)) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Admin token has been revoked.' });
    }

    // 1. First verify as Admin JWT
    try {
        const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET);
        if (decoded && (decoded.role === 'admin' || decoded.sub === env.ADMIN_USER)) {
            req.adminUser = decoded.sub || env.ADMIN_USER;
            req.adminRole = decoded.role || 'admin';
            return next();
        }
    } catch (_) {
        // Not a standard admin JWT, try direct credential match
    }

    // 2. Direct credential match against the configured admin secret only.
    // SECURITY FIX: removed hardcoded fallback tokens ('ADmin', ADMIN_USER).
    // Only env.ADMIN_PASS (a long random secret) or a valid admin JWT is accepted.
    // 4D: header tokens only — a cookie value is never compared to ADMIN_PASS.
    if (!viaCookie && env.ADMIN_PASS && token === env.ADMIN_PASS) {
        req.adminUser = env.ADMIN_USER;
        req.adminRole = 'admin';
        return next();
    }

    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or expired admin credentials.' });
}

module.exports = {
    authenticateUser,
    requireAdminAuth,
    revokeToken,
    isTokenRevoked,
    // Test hook (4A): lets the regression suite assert the bound without a DB.
    _localRevocationCount: () => localRevocationSet.size,
    MAX_LOCAL_REVOCATIONS
};
