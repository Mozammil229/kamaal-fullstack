'use strict';

// 4D (PWA cookie auth) — the Kamaal app on web, SAME app users as Android
// (User model, username/password). Do NOT confuse with the patcher-site
// WebUser system (src/controllers/webAuthController.js) — different product.
//
// Sessions:
//   - Short-lived access JWT (15 min, same claims as generateToken plus
//     typ:'pwa-access') in httpOnly cookie `kamaal_access` (Path=/api).
//   - Opaque rotating refresh token in httpOnly cookie `kamaal_refresh`
//     (Path=/api/pwa/auth). Only its SHA-256 hash is stored, in a family
//     (familyId) so reuse of an already-rotated token revokes the whole
//     family.
//   - Double-submit CSRF token in cookie `kamaal_csrf` (NOT httpOnly,
//     Path=/), checked by src/middleware/csrfGuard.js.
// NO token value is ever returned in a response body, and NO token value
// is ever logged. The stored Android token (User.token) is stripped from
// the PWA login/refresh user object — the web client must never see it.
//
// Handlers are built by createPwaAuthHandlers(deps) so tests can inject a
// stub model + stub DB gate (same pattern as webAuthController). The routes
// file uses the defaults (real models, real DB).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serverError } = require('../utils/serverError');
const { connectToDatabase, isDbConnected } = require('../config/db');
const DefaultUser = require('../models/User');
const DefaultRefreshToken = require('../models/RefreshToken');
const authController = require('./authController');
const { revokeToken } = require('../middleware/auth');
const {
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    CSRF_COOKIE,
    parseCookies,
    setCookie,
    clearCookie
} = require('../utils/pwaCookies');

const GENERIC_LOGIN_ERROR = 'Invalid credentials.';
const GENERIC_SESSION_ERROR = 'Invalid or expired session.';

function accessTtlMinutes() {
    const n = Number(require('../config/env').PWA_ACCESS_TTL_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : 15;
}

function refreshTtlDays() {
    const n = Number(require('../config/env').PWA_REFRESH_TTL_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function signAccessToken(user) {
    return jwt.sign(
        { username: user.username, sub: user.username, role: 'user', typ: 'pwa-access' },
        require('../config/env').JWT_SECRET,
        { expiresIn: `${accessTtlMinutes()}m` }
    );
}

// Safe user shape, exactly as app login — minus ANY token value.
function toSafePwaUser(u) {
    const safe = authController.toSafeUser(u);
    if (safe) delete safe.token;
    return safe;
}

function setSessionCookies(res, req, accessToken, refreshToken, csrfToken) {
    const accessMs = accessTtlMinutes() * 60 * 1000;
    const refreshMs = refreshTtlDays() * 24 * 60 * 60 * 1000;
    setCookie(res, req, ACCESS_COOKIE, accessToken, '/api', accessMs, true);
    setCookie(res, req, REFRESH_COOKIE, refreshToken, '/api/pwa/auth', refreshMs, true);
    // CSRF cookie lives as long as the refresh session; its VALUE is
    // rotated on every login/refresh alongside the tokens.
    setCookie(res, req, CSRF_COOKIE, csrfToken, '/', refreshMs, false);
}

function clearSessionCookies(res, req) {
    clearCookie(res, req, ACCESS_COOKIE, '/api', true);
    clearCookie(res, req, REFRESH_COOKIE, '/api/pwa/auth', true);
    clearCookie(res, req, CSRF_COOKIE, '/', false);
}

function createPwaAuthHandlers(deps = {}) {
    const UserModel = deps.UserModel || DefaultUser;
    const RefreshTokenModel = deps.RefreshTokenModel || DefaultRefreshToken;
    const db = deps.db || { connect: connectToDatabase, isConnected: isDbConnected };

    async function issueSession(res, req, user, familyId) {
        const refreshValue = crypto.randomBytes(32).toString('hex');
        const csrfValue = crypto.randomBytes(32).toString('hex');
        const accessToken = signAccessToken(user);
        const now = new Date();
        await RefreshTokenModel.create({
            tokenHash: sha256Hex(refreshValue),
            userId: user._id,
            familyId,
            expiresAt: new Date(now.getTime() + refreshTtlDays() * 24 * 60 * 60 * 1000),
            revokedAt: null,
            replacedByHash: null,
            createdAt: now
        });
        setSessionCookies(res, req, accessToken, refreshValue, csrfValue);
    }

    // POST /api/pwa/auth/login — same credential semantics as app login
    // (username/email/phone lookup, bcrypt + legacy fallback + transparent
    // migration, same generic failure message, no user enumeration).
    async function login(req, res) {
        await db.connect();
        let conf;
        try {
            const { getActiveConfig } = require('./configController');
            conf = await getActiveConfig();
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        if (conf?.maintenance?.enabled) {
            return res.status(503).json({ success: false, error: conf.maintenance.message });
        }

        const { email, username, password } = req.body || {};
        const rawIdentifier = String(email || username || req.body?.phone || '').trim();
        if (!rawIdentifier || !password) {
            return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
        }
        const identifier = authController.normalizeLoginIdentifier(rawIdentifier);
        let plainPassword;
        try {
            plainPassword = authController.maybeDecryptPassword(password, req.body.passwordEncrypted);
        } catch (e) {
            return res.status(e.status || 500).json({ success: false, error: e.message || 'Password error.' });
        }

        if (!db.isConnected()) {
            return res.status(503).json({ success: false, error: 'Database offline. User login requires database connection.' });
        }

        try {
            const user = await UserModel.findOne({
                $or: [{ username: identifier }, { email: identifier }, { phone: identifier }]
            }).select('+passwordHash');

            if (!user) {
                return res.status(401).json({ success: false, error: GENERIC_LOGIN_ERROR });
            }

            const { ok, migrate, legacyRejected } = authController.verifyPassword(plainPassword, user);
            if (legacyRejected) {
                return res.status(403).json({ success: false, error: 'Password reset required. Please reset your password.', passwordResetRequired: true });
            }
            if (!ok) {
                return res.status(401).json({ success: false, error: GENERIC_LOGIN_ERROR });
            }

            if (user.status === 'banned') {
                return res.status(403).json({ success: false, error: `Account Suspended: ${user.banReason || 'Policy violation'}` });
            }

            // PWA login does NOT touch the Android hardware binding
            // (deviceId) and does NOT overwrite User.token — the Android
            // client's stored 30d token must keep working untouched.
            const set = { lastActiveAt: new Date() };
            if (migrate) set.passwordHash = authController.hashPassword(plainPassword);
            await UserModel.updateOne({ _id: user._id }, { $set: set });

            await issueSession(res, req, user, crypto.randomUUID());
            return res.json({ success: true, user: toSafePwaUser(user) });
        } catch (e) {
            return serverError(res, e);
        }
    }

    // POST /api/pwa/auth/refresh — rotate the refresh token. No CSRF check
    // (cookie-to-cookie rotation; standard exemption — see csrfGuard).
    async function refresh(req, res) {
        await db.connect();
        if (!db.isConnected()) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        const presented = parseCookies(req)[REFRESH_COOKIE];
        if (!presented) {
            return res.status(401).json({ success: false, error: GENERIC_SESSION_ERROR });
        }
        try {
            const oldHash = sha256Hex(presented);
            const row = await RefreshTokenModel.findOne({ tokenHash: oldHash });
            if (!row || (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now())) {
                return res.status(401).json({ success: false, error: GENERIC_SESSION_ERROR });
            }
            // REUSE DETECTED: this token was already rotated away. Revoke
            // the WHOLE family — the token was likely stolen.
            if (row.revokedAt || row.replacedByHash) {
                const now = new Date();
                await RefreshTokenModel.updateMany(
                    { familyId: row.familyId },
                    { $set: { revokedAt: now } }
                );
                return res.status(401).json({ success: false, error: GENERIC_SESSION_ERROR });
            }

            const user = await UserModel.findById(row.userId);
            if (!user || user.status === 'banned') {
                return res.status(401).json({ success: false, error: GENERIC_SESSION_ERROR });
            }

            const newValue = crypto.randomBytes(32).toString('hex');
            const newHash = sha256Hex(newValue);
            const now = new Date();
            await RefreshTokenModel.updateOne(
                { tokenHash: oldHash },
                { $set: { revokedAt: now, replacedByHash: newHash } }
            );
            await RefreshTokenModel.create({
                tokenHash: newHash,
                userId: row.userId,
                familyId: row.familyId,
                expiresAt: new Date(now.getTime() + refreshTtlDays() * 24 * 60 * 60 * 1000),
                revokedAt: null,
                replacedByHash: null,
                createdAt: now
            });
            const csrfValue = crypto.randomBytes(32).toString('hex');
            setSessionCookies(res, req, signAccessToken(user), newValue, csrfValue);
            return res.json({ success: true, user: toSafePwaUser(user) });
        } catch (e) {
            return serverError(res, e);
        }
    }

    // Current access token, from Bearer header (Android-style) or cookie.
    function currentAccessToken(req) {
        const bearer = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
        if (bearer && typeof bearer === 'string' && bearer.trim()) return bearer.trim();
        const cookie = parseCookies(req)[ACCESS_COOKIE];
        return cookie || null;
    }

    // POST /api/pwa/auth/logout — requires auth (route middleware).
    // Revokes this session's refresh token + the access token, clears cookies.
    async function logout(req, res) {
        await db.connect();
        try {
            const presented = parseCookies(req)[REFRESH_COOKIE];
            if (presented) {
                await RefreshTokenModel.updateOne(
                    { tokenHash: sha256Hex(presented) },
                    { $set: { revokedAt: new Date() } }
                );
            }
            const access = currentAccessToken(req);
            if (access) await revokeToken(access, 'pwa_logout');
        } catch (e) {
            console.warn('PWA logout revocation error:', e.message);
        }
        clearSessionCookies(res, req);
        return res.json({ success: true, message: 'Logged out.' });
    }

    // POST /api/pwa/auth/logout-everywhere — requires auth. Revokes ALL
    // refresh-token rows for the user + the current access token.
    async function logoutEverywhere(req, res) {
        await db.connect();
        try {
            const username = req.user?.username;
            const user = username
                ? await UserModel.findOne({ username })
                : null;
            if (user) {
                await RefreshTokenModel.updateMany(
                    { userId: user._id },
                    { $set: { revokedAt: new Date() } }
                );
            }
            const access = currentAccessToken(req);
            if (access) await revokeToken(access, 'pwa_logout_everywhere');
        } catch (e) {
            console.warn('PWA logout-everywhere revocation error:', e.message);
        }
        clearSessionCookies(res, req);
        return res.json({ success: true, message: 'Logged out everywhere.' });
    }

    return { login, refresh, logout, logoutEverywhere };
}

// Default handlers (real models, real DB) — what the routes file uses.
const defaultHandlers = createPwaAuthHandlers();

module.exports = {
    createPwaAuthHandlers,
    ...defaultHandlers,
    GENERIC_LOGIN_ERROR,
    GENERIC_SESSION_ERROR
};
