const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const User = require('../models/User');
const AppConfig = require('../models/AppConfig');
const { connectToDatabase } = require('../config/db');

function hashPassword(password) {
    return crypto.createHash('sha256').update(String(password)).digest('hex');
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
            user: newUser
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

    const pHash = hashPassword(password);
    const token = generateToken(identifier);

    try {
        const user = await User.findOne({
            $or: [{ username: identifier }, { email: identifier }, { phone: identifier }]
        });

        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid credentials: User not found.' });
        }

        const isPassValid = (user.passwordHash === pHash) || (user.password === password) || (user.passwordHash === password);
        if (!isPassValid) {
            return res.status(401).json({ success: false, error: 'Invalid password. Access denied.' });
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
            user
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Verify Controller
async function verify(req, res) {
    await connectToDatabase();
    const username = req.query.username || req.body?.username || req.user?.username;
    if (!username) {
        return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    try {
        const user = await User.findOne({ username: String(username).trim() });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ success: false, error: `Account suspended: ${user.banReason || 'Banned'}` });

        user.lastActiveAt = new Date();
        await user.save();
        return res.json({ success: true, user });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    register,
    login,
    verify
};
