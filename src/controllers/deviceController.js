const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { connectToDatabase, isDbConnected } = require('../config/db');
const Device = require('../models/Device');
const User = require('../models/User');

/**
 * PHASE B — Kamal ID device endpoints (blueprint §4, §7).
 *
 * POST /api/device/register {deviceHash, displayId, model, appVersion}
 *   Auth: none on first register (a fresh install has no token yet); when a
 *   valid Bearer JWT IS present, the device binds to the user from the
 *   VERIFIED token — never to a client-supplied username (BYOK lesson).
 *   Idempotent upsert on deviceHash; always safe to retry.
 *
 * POST /api/device/resolve {deviceHash} -> {bound, displayId, username?}
 *   Reinstall-restore lookup. Read-only-ish: it returns whether the device
 *   is bound and to which username, but issues NO tokens. The full restore
 *   (short-lived restore token + password confirm) arrives in Phase C.
 *   Brute-forcing deviceHash is infeasible (64-hex SHA-256), and only the
 *   device owner knows their own hash, so returning the username is safe.
 */

function cleanStr(v, max) {
    return String(v == null ? '' : v).slice(0, max);
}

async function registerDevice(req, res) {
    await connectToDatabase();
    const body = req.body || {};
    const deviceHash = cleanStr(body.deviceHash, 128).trim();
    if (!deviceHash) {
        return res.status(400).json({ success: false, error: 'deviceHash is required.' });
    }
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Device registration requires database connection.' });
    }

    // Optional auth: bind to the JWT identity when the caller is logged in.
    let userId = null;
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
        try {
            const decoded = jwt.verify(token, env.JWT_SECRET);
            const username = decoded && (decoded.username || decoded.sub);
            if (username) {
                const user = await User.findOne({ username: String(username).trim() });
                if (user) userId = user._id;
            }
        } catch (_) {
            // Invalid/expired token: register the device unbound. No error —
            // the local Kamal ID remains authoritative on the device.
        }
    }

    try {
        const now = new Date();
        const update = {
            displayId: cleanStr(body.displayId, 32),
            model: cleanStr(body.model, 128),
            appVersion: cleanStr(body.appVersion, 32),
            lastSeenAt: now
        };
        if (userId) update.userId = userId;
        const device = await Device.findOneAndUpdate(
            { deviceHash },
            { $set: update, $setOnInsert: { deviceHash, firstSeenAt: now } },
            { upsert: true, new: true }
        );
        return res.json({ success: true, displayId: device.displayId, bound: !!device.userId });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Device registration failed.' });
    }
}

async function resolveDevice(req, res) {
    await connectToDatabase();
    const deviceHash = cleanStr((req.body || {}).deviceHash, 128).trim();
    if (!deviceHash) {
        return res.status(400).json({ success: false, error: 'deviceHash is required.' });
    }
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Device lookup requires database connection.' });
    }

    try {
        const device = await Device.findOne({ deviceHash });
        if (device && device.userId) {
            const user = await User.findById(device.userId);
            if (user && user.status === 'active') {
                return res.json({
                    success: true,
                    bound: true,
                    displayId: device.displayId || user.displayKamalId || '',
                    username: user.username
                });
            }
        }
        // Legacy fallback: pre-Phase-B per-user deviceId binding.
        const legacy = await User.findOne({ deviceId: deviceHash, status: 'active' });
        if (legacy) {
            return res.json({
                success: true,
                bound: true,
                displayId: legacy.displayKamalId || '',
                username: legacy.username
            });
        }
        return res.json({ success: true, bound: false, displayId: '', username: null });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Device lookup failed.' });
    }
}

module.exports = { registerDevice, resolveDevice };
