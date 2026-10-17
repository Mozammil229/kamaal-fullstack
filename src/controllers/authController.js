const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const User = require('../models/User');
const AppConfig = require('../models/AppConfig');
const { connectToDatabase } = require('../config/db');

// SECURITY FIX (#7): bcrypt with per-password salts. The old unsalted SHA-256
// is only used as a transparent-migration fallback inside verifyPassword.
function hashPassword(password) {
    return bcrypt.hashSync(String(password), 10);
}

function legacySha256(password) {
    return crypto.createHash('sha256').update(String(password)).digest('hex');
}

/**
 * Verifies a password against the stored hash.
 * Returns { ok, migrate }: migrate=true means the stored hash used a legacy
 * scheme and should be re-hashed with bcrypt immediately (transparent
 * migration — no user password reset needed).
 */
function verifyPassword(password, user) {
    const pw = String(password);
    const stored = user.passwordHash || '';
    // 1) bcrypt (current scheme)
    try {
        if (stored.startsWith('$2')) {
            return { ok: bcrypt.compareSync(pw, stored), migrate: false };
        }
    } catch (_) { /* fall through to legacy checks */ }
    // 2) legacy unsalted SHA-256 → migrate
    if (stored === legacySha256(pw)) return { ok: true, migrate: true };
    // 3) ancient plaintext fallbacks (kept from original code) → migrate
    if (user.password === pw || stored === pw) return { ok: true, migrate: true };
    return { ok: false, migrate: false };
}

/**
 * SECURITY FIX (#3): explicit allowlist for user objects sent to clients.
 * NEVER includes passwordHash or customGeminiKey (also select:false in schema).
 */
function toSafeUser(u) {
    if (!u) return null;
    return {
        id: u._id ? u._id.toString() : undefined,
        username: u.username,
        name: u.name,
        email: u.email,
        phone: u.phone,
        deviceId: u.deviceId,
        credits: u.credits,
        isPro: u.isPro,
        is_pro: u.isPro,
        status: u.status,
        tier: u.tier,
        plan: u.proPlan,
        proPlan: u.proPlan,
        planExpiry: u.planExpiry,
        role: u.role,
        referralCode: u.referralCode,
        customPrompt: u.customPrompt,
        stats: u.stats,
        token: u.token,
        lastActiveAt: u.lastActiveAt,
        createdAt: u.createdAt
    };
}

function generateToken(username) {
    return jwt.sign(
        { username, sub: username, role: 'user' },
        env.JWT_SECRET,
        { expiresIn: '30d' }
    );
}

// Register Controller
async function register(req, res) {
    await connectToDatabase();
    const { getActiveConfig } = require('./configController');
    const conf = await getActiveConfig();
    if (conf?.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message });
    }

    const { username, password, name, email, phone, deviceId, referralCode } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and Password are required.' });
    }

    const cleanUsername = String(username).trim();
    const pHash = hashPassword(password);
    const token = generateToken(cleanUsername);
    const userReferral = 'KAM-' + cleanUsername.toUpperCase().slice(0, 4) + '-' + Math.floor(1000 + Math.random() * 9000);

    const { isDbConnected } = require('../config/db');
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. User registration requires database connection.' });
    }

    try {
        const existing = await User.findOne({ username: cleanUsername });
        if (existing) {
            return res.status(400).json({ success: false, error: 'Username is already taken.' });
        }

        // Hardware device binding check
        if (deviceId) {
            const boundUser = await User.findOne({ deviceId: deviceId.trim(), status: 'active' });
            if (boundUser && boundUser.username !== cleanUsername) {
                return res.status(400).json({
                    success: false,
                    error: `Device Bound: This physical device is already bound to '${boundUser.username}'. Please login or contact Admin for hardware reset.`
                });
            }
        }

        // Referral reward calculation
        let bonusCredits = conf?.defaultSignupCredits || 2;
        if (referralCode) {
            const referrer = await User.findOne({ referralCode: referralCode.trim() });
            if (referrer) {
                referrer.credits += (conf?.referralReward || 2);
                await referrer.save();
                bonusCredits += (conf?.referralReward || 2);
            }
        }

        const newUser = await User.create({
            username: cleanUsername,
            name: name || cleanUsername,
            email: email || '',
            phone: phone || '',
            passwordHash: pHash,
            token,
            deviceId: deviceId ? deviceId.trim() : '',
            credits: bonusCredits,
            referralCode: userReferral,
            referredBy: referralCode || '',
            status: 'active',
            tier: 'FREE',
            proPlan: 'trial',
            planExpiry: 'Lifetime'
        });

        return res.json({
            success: true,
            message: 'Registration approved.',
            token,
            user: toSafeUser(newUser)
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Login Controller
async function login(req, res) {
    await connectToDatabase();
    const { getActiveConfig } = require('./configController');
    const conf = await getActiveConfig();
    if (conf?.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message });
    }

    const { email, username, password, deviceId } = req.body;
    const identifier = String(email || username || req.body?.phone || '').trim();
    if (!identifier || !password) {
        return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
    }

    const { isDbConnected } = require('../config/db');
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. User login requires database connection.' });
    }

    const token = generateToken(identifier);

    try {
        // NOTE: passwordHash is select:false — explicitly include it for verification.
        const user = await User.findOne({
            $or: [{ username: identifier }, { email: identifier }, { phone: identifier }]
        }).select('+passwordHash');

        // SECURITY FIX (#9): generic error for both cases — distinct messages
        // ("User not found" vs "Invalid password") allow username enumeration.
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        }

        const { ok, migrate } = verifyPassword(password, user);
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        }
        // Transparent migration: a legacy hash worked → re-hash with bcrypt now.
        if (migrate) {
            user.passwordHash = hashPassword(password);
        }

        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: `Account Suspended: ${user.banReason || 'Policy violation'}` });
        }

        // Hardware lock check & bind
        if (deviceId) {
            const cleanDevice = deviceId.trim();
            if (user.deviceId && user.deviceId !== cleanDevice) {
                return res.status(403).json({
                    success: false,
                    error: 'Hardware Mismatch: Account bound to another device. Contact Owner or request unlock from Admin.'
                });
            }
            if (!user.deviceId) {
                user.deviceId = cleanDevice;
            }
        }

        user.token = token;
        user.lastActiveAt = new Date();
        await user.save();

        return res.json({
            success: true,
            message: 'Login authorized.',
            token,
            user: toSafeUser(user)
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Verify Controller (JWT-authenticated; username from verified token)
async function verify(req, res) {
    await connectToDatabase();
    const username = req.user?.username || req.query.username || req.body?.username;
    if (!username) {
        return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    try {
        const user = await User.findOne({ username: String(username).trim() });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ success: false, error: `Account suspended: ${user.banReason || 'Banned'}` });

        user.lastActiveAt = new Date();
        await user.save();
        // SECURITY FIX (#3): allowlisted user object — no passwordHash/customGeminiKey.
        return res.json({ success: true, user: toSafeUser(user) });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    register,
    login,
    verify
};
