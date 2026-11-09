'use strict';

// PATCHER SITE — web auth (2026-11-09).
//
// Public web accounts for the patcher site. COMPLETELY separate from the
// app auth system (src/controllers/authController.js + User model):
//   - own collection (WebUser / 'webusers'), own JWT (type:'web'),
//   - own middleware (src/middleware/webAuth.js),
//   - the app User model is never read or written here, and vice versa.
// Passwords: bcrypt (salt rounds 10, same as the app). Passwords and
// hashes are NEVER logged and NEVER returned in any response.
// Login failures always answer the SAME generic message (unknown email,
// wrong password, disabled account) — no user enumeration.
// Tokens: JWT, 7-day expiry, enforced on verify. Secret is WEB_JWT_SECRET
// when set in the server env, else the app JWT_SECRET (the type:'web'
// claim + WebUser-only lookup still keep app/web tokens from ever mixing;
// setting a dedicated WEB_JWT_SECRET in Vercel is recommended).
// Handlers are built by createWebAuthHandlers(deps) so tests can inject a
// stub model + stub DB gate (same pattern as flowController's
// createGenerateFlowHandler). The routes file uses the defaults (real
// model, real DB).

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { connectToDatabase, isDbConnected } = require('../config/db');
const DefaultWebUser = require('../models/WebUser');

const WEB_TOKEN_TTL = '7d';
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LEN = 8;

function getWebJwtSecret() {
    if (process.env.WEB_JWT_SECRET && String(process.env.WEB_JWT_SECRET).trim()) {
        return String(process.env.WEB_JWT_SECRET).trim();
    }
    // Lazy require: ../config/env throws at load when JWT_SECRET is unset;
    // web handlers only need the secret at sign/verify time.
    return require('../config/env').JWT_SECRET;
}

function validateWebEmail(email) {
    return typeof email === 'string' && EMAIL_RE.test(email.trim().toLowerCase());
}

function validateWebPassword(password) {
    return typeof password === 'string' && password.length >= MIN_PASSWORD_LEN;
}

function signWebToken(webUser) {
    return jwt.sign(
        { type: 'web', sub: String(webUser._id), email: webUser.email },
        getWebJwtSecret(),
        { expiresIn: WEB_TOKEN_TTL }
    );
}

function verifyWebToken(token) {
    return jwt.verify(token, getWebJwtSecret());
}

// SECURITY: explicit allowlist for web-user objects sent to clients.
// NEVER includes passwordHash (also select:false in the schema).
function toSafeWebUser(u) {
    if (!u) return null;
    return {
        id: u._id ? u._id.toString() : undefined,
        email: u.email,
        status: u.status,
        lastLoginAt: u.lastLoginAt || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt
    };
}

function createWebAuthHandlers(deps = {}) {
    const WebUserModel = deps.WebUserModel || DefaultWebUser;
    const db = deps.db || { connect: connectToDatabase, isConnected: isDbConnected };

    async function ensureDb(res) {
        await db.connect();
        if (!db.isConnected()) {
            res.status(503).json({ success: false, error: 'Database offline. Please try again.', errorCode: 'DB_OFFLINE' });
            return false;
        }
        return true;
    }

    async function register(req, res) {
        try {
            if (!(await ensureDb(res))) return;
            const body = req.body || {};
            const email = String(body.email || '').trim().toLowerCase();
            const password = body.password;
            if (!validateWebEmail(email)) {
                return res.status(400).json({ success: false, error: 'A valid email address is required.', errorCode: 'EMAIL_INVALID' });
            }
            if (!validateWebPassword(password)) {
                return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`, errorCode: 'PASSWORD_WEAK' });
            }
            const existing = await WebUserModel.findOne({ email });
            if (existing) {
                return res.status(409).json({ success: false, error: 'An account with this email already exists.', errorCode: 'EMAIL_EXISTS' });
            }
            const passwordHash = bcrypt.hashSync(String(password), 10);
            const created = await WebUserModel.create({ email, passwordHash });
            // Log email + outcome only — never the password or its hash.
            console.log(`[web-auth] register ok email=${email}`);
            return res.status(201).json({ success: true, token: signWebToken(created), user: toSafeWebUser(created) });
        } catch (e) {
            console.error('[web-auth] register error:', e.message);
            return res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
        }
    }

    async function login(req, res) {
        try {
            if (!(await ensureDb(res))) return;
            const body = req.body || {};
            const email = String(body.email || '').trim().toLowerCase();
            const password = body.password;
            if (!email || !password) {
                return res.status(400).json({ success: false, error: 'Email and password are required.', errorCode: 'MISSING_FIELDS' });
            }
            // Generic failure for every credential problem (unknown email,
            // wrong password, disabled account) — no user enumeration.
            if (!validateWebEmail(email)) {
                return res.status(401).json({ success: false, error: GENERIC_LOGIN_ERROR, errorCode: 'INVALID_CREDENTIALS' });
            }
            const user = await WebUserModel.findOne({ email }).select('+passwordHash');
            if (!user || user.status !== 'active' || !bcrypt.compareSync(String(password), user.passwordHash || '')) {
                console.log(`[web-auth] login failed email=${email}`);
                return res.status(401).json({ success: false, error: GENERIC_LOGIN_ERROR, errorCode: 'INVALID_CREDENTIALS' });
            }
            if (typeof user.save === 'function') {
                try { user.lastLoginAt = new Date(); await user.save(); } catch (_) { /* last-login is best-effort */ }
            }
            console.log(`[web-auth] login ok email=${email}`);
            return res.json({ success: true, token: signWebToken(user), user: toSafeWebUser(user) });
        } catch (e) {
            console.error('[web-auth] login error:', e.message);
            return res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
        }
    }

    // GET /api/web/me — the site gate calls this to verify a stored token.
    async function getMe(req, res) {
        return res.json({ success: true, user: toSafeWebUser(req.webUser) });
    }

    // --- Site admin (admin panel "Site" section; admin JWT only) ---

    async function listWebUsers(req, res) {
        try {
            if (!(await ensureDb(res))) return;
            const docs = await WebUserModel.find({}).sort({ createdAt: -1 });
            const users = docs.map(toSafeWebUser);
            return res.json({ success: true, users, count: users.length });
        } catch (e) {
            console.error('[web-auth] list error:', e.message);
            return res.status(500).json({ success: false, error: 'Could not list web users.' });
        }
    }

    async function updateWebUser(req, res) {
        try {
            if (!(await ensureDb(res))) return;
            const id = String(req.params.id || '');
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ success: false, error: 'Invalid user id.', errorCode: 'INVALID_ID' });
            }
            const disabled = req.body && req.body.disabled;
            if (typeof disabled !== 'boolean') {
                return res.status(400).json({ success: false, error: 'Field "disabled" (true/false) is required.', errorCode: 'INVALID_BODY' });
            }
            const doc = await WebUserModel.findByIdAndUpdate(
                id,
                { status: disabled ? 'disabled' : 'active' },
                { new: true }
            );
            if (!doc) {
                return res.status(404).json({ success: false, error: 'Web user not found.', errorCode: 'NOT_FOUND' });
            }
            return res.json({ success: true, user: toSafeWebUser(doc) });
        } catch (e) {
            console.error('[web-auth] update error:', e.message);
            return res.status(500).json({ success: false, error: 'Could not update web user.' });
        }
    }

    async function deleteWebUser(req, res) {
        try {
            if (!(await ensureDb(res))) return;
            const id = String(req.params.id || '');
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ success: false, error: 'Invalid user id.', errorCode: 'INVALID_ID' });
            }
            const doc = await WebUserModel.findByIdAndDelete(id);
            if (!doc) {
                return res.status(404).json({ success: false, error: 'Web user not found.', errorCode: 'NOT_FOUND' });
            }
            console.log(`[web-auth] deleted web user email=${doc.email}`);
            return res.json({ success: true, message: 'Web user deleted.' });
        } catch (e) {
            console.error('[web-auth] delete error:', e.message);
            return res.status(500).json({ success: false, error: 'Could not delete web user.' });
        }
    }

    return { register, login, getMe, listWebUsers, updateWebUser, deleteWebUser };
}

module.exports = {
    createWebAuthHandlers,
    validateWebEmail,
    validateWebPassword,
    signWebToken,
    verifyWebToken,
    getWebJwtSecret,
    toSafeWebUser,
    WEB_TOKEN_TTL,
    GENERIC_LOGIN_ERROR
};
