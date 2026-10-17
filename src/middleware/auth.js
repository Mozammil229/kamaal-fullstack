const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');
const RevokedToken = require('../models/RevokedToken');
const { isDbConnected } = require('../config/db');

// In-memory fallback revocation cache for resilience if DB connection is intermittent
const localRevocationSet = new Set();

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
                localRevocationSet.add(thash);
                return true;
            }
        } catch (e) {
            console.warn('Revoked token check error:', e.message);
        }
    }
    return false;
}

async function revokeToken(token, reason = 'logout') {
    if (!token) return;
    const thash = hashToken(token);
    localRevocationSet.add(thash);

    if (isDbConnected()) {
        try {
            await RevokedToken.create({ tokenHash: thash, reason });
        } catch (e) {
            console.warn('Persistent token revocation error:', e.message);
        }
    }
}

// User JWT Auth Middleware
async function authenticateUser(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ success: false, error: 'Authorization header required.' });
    }

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
        return res.status(401).json({ success: false, error: 'Token missing.' });
    }

    if (await isTokenRevoked(token)) {
        return res.status(401).json({ success: false, error: 'Session token has been revoked.' });
    }

    try {
        const decoded = jwt.verify(token, env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
}

// Admin Auth Middleware (Requires either valid signed admin JWT or verified admin credential)
async function requireAdminAuth(req, res, next) {
    const rawToken = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
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
    if (env.ADMIN_PASS && token === env.ADMIN_PASS) {
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
    isTokenRevoked
};
