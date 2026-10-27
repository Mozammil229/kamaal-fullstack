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
 * PHASE F — opportunistic transport encryption for passwords.
 *
 * When the client fetched GET /api/auth/pubkey successfully, it RSA-OAEP-
 * SHA256-encrypts the password and sends {password: <base64>, passwordEncrypted: true}.
 * This decrypts it back to plaintext BEFORE the normal bcrypt flow runs, so
 * the rest of login/register is unchanged. When passwordEncrypted is falsy,
 * the value passes through untouched (plaintext-over-TLS fallback).
 *
 * Throws {status, message} on misconfiguration so callers can answer 503
 * honestly instead of failing the bcrypt compare with garbage.
 */
function maybeDecryptPassword(password, passwordEncrypted) {
    if (!passwordEncrypted) return password;
    const pem = env.RSA_PRIVATE_KEY_PEM;
    if (!pem) {
        throw { status: 503, message: 'Server encryption key not configured. Please try again later.' };
    }
    try {
        const buf = crypto.privateDecrypt(
            {
                key: pem,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            Buffer.from(String(password), 'base64')
        );
        return buf.toString('utf8');
    } catch (_) {
        throw { status: 400, message: 'Password decryption failed.' };
    }
}

/**
 * PHASE F — GET /api/auth/pubkey (public; needed pre-login).
 * Serves the RSA PUBLIC key (SPKI PEM) derived from the private key in env.
 * The private key never leaves the server.
 */
function serverPubkey(req, res) {
    const pem = env.RSA_PRIVATE_KEY_PEM;
    if (!pem) {
        return res.status(503).json({ success: false, error: 'not-configured' });
    }
    try {
        const pub = crypto.createPublicKey(pem);
        const pubPem = pub.export({ type: 'spki', format: 'pem' });
        return res.json({ success: true, pem: String(pubPem) });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Key error.' });
    }
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
        displayKamalId: u.displayKamalId,
        preferredLanguage: u.preferredLanguage,
        deviceId: u.deviceId,
        credits: u.credits,
        // PHASE E — TAG/LEVEL badge (computed on read from lifetime earned).
        creditsEarned: u.creditsEarned || 0,
        tag: require('../services/socialTagService').computeSocialTag(u.creditsEarned),
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

// v91 (BugHunter DB P0-3 / backend F12): normalize a login identifier the
// same way register stores it — Pakistani phone to +92 form, anything else
// lowercased (usernames are stored lowercase, emails are case-insensitive).
// The old code signed the token from the RAW identifier before the lookup,
// so an email/phone login minted a token whose username matched no user.
function normalizeLoginIdentifier(raw) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('03')) return '+92' + digits.substring(1);
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('92')) return '+' + digits;
    return String(raw).toLowerCase();
}

// Register Controller
async function register(req, res) {
    await connectToDatabase();
    // v91 (BugHunter backend F4): getActiveConfig() used to run outside any
    // try/catch — a DB blip or first-create race threw an unhandled rejection
    // and the request hung until Vercel killed it.
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

    // PHASE B: accepts {name, phone, username, password, deviceHash, displayId}
    // (+ optional model/appVersion). Backward compatible: old clients that
    // send only {username, password} still register (name defaults to the
    // username, phone stays empty, no device record beyond deviceId).
    const { username, password, name, email, phone, deviceId, deviceHash, displayId, model, appVersion, referralCode } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and Password are required.' });
    }
    // PHASE F: decrypt an RSA-encrypted password before any length/hash use.
    let plainPassword;
    try {
        plainPassword = maybeDecryptPassword(password, req.body.passwordEncrypted);
    } catch (e) {
        return res.status(e.status || 500).json({ success: false, error: e.message || 'Password error.' });
    }
    if (String(plainPassword).length < 8) {
        return res.status(400).json({ success: false, error: 'Password must be at least 8 characters.' });
    }

    // Username: normalized to lowercase, 3-24 chars, a-z 0-9 _ (blueprint §5).
    const cleanUsername = String(username).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
        return res.status(400).json({ success: false, error: 'Username must be 3-24 characters: lowercase letters, numbers, underscore.' });
    }

    // Name: 2-60 chars when provided; defaults to the username (old clients).
    const cleanName = String(name == null || String(name).trim() === '' ? cleanUsername : name).trim();
    if (cleanName.length < 2 || cleanName.length > 60) {
        return res.status(400).json({ success: false, error: 'Name must be 2-60 characters.' });
    }

    // Phone: Pakistani mobile 03XXXXXXXXX -> +92XXXXXXXXXX. Optional for old
    // clients; when provided it must be valid and unique.
    let cleanPhone = '';
    const rawPhone = String(phone == null ? '' : phone).trim();
    if (rawPhone !== '') {
        const digits = rawPhone.replace(/\D/g, '');
        if (digits.length === 11 && digits.startsWith('03')) {
            cleanPhone = '+92' + digits.substring(1);
        } else if (digits.length === 12 && digits.startsWith('92')) {
            cleanPhone = '+' + digits;
        } else {
            return res.status(400).json({ success: false, error: 'Phone number must be a Pakistani mobile like 03XXXXXXXXX.' });
        }
    }

    // v91 (BugHunter backend F28): email was stored unvalidated and never
    // uniqueness-checked, so email login was ambiguous. Validate format here;
    // uniqueness is checked inside the try block below (needs the DB guard).
    const cleanEmail = String(email == null ? '' : email).trim().toLowerCase();
    if (cleanEmail !== '') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
        }
    }

    const pHash = hashPassword(plainPassword);
    const token = generateToken(cleanUsername);
    // PHASE D — deterministic referral code: "KML-" + first 6 of
    // SHA-256(username + "|" + kamalDisplayId), uppercased. The Android
    // client derives the identical code locally (ReferralManager).
    const { deriveReferralCode } = require('./referralController');
    const userReferral = deriveReferralCode(cleanUsername, displayId);

    const { isDbConnected } = require('../config/db');
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. User registration requires database connection.' });
    }

    try {
        const existing = await User.findOne({ username: cleanUsername });
        if (existing) {
            return res.status(400).json({ success: false, error: 'Username is already taken.' });
        }

        // v91 (BugHunter backend F28): email uniqueness (partial unique index
        // backs this check; legacy '' rows are unaffected).
        if (cleanEmail !== '') {
            const emailTaken = await User.findOne({ email: cleanEmail });
            if (emailTaken) {
                return res.status(400).json({ success: false, error: 'This email is already registered.' });
            }
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

        // PHASE D — the optional referral code is applied AFTER the user row
        // exists (the Referral row's unique referredKamalId fraud guard needs
        // the new _id). Base signup credits only here.
        // v91 (BugHunter DB P2-24): `|| 2` silently overrode an admin-set 0.
        const baseCredits = conf?.defaultSignupCredits ?? 2;
        const pendingReferralCode = referralCode ? String(referralCode).trim() : '';

        // Phone uniqueness (defense in depth alongside the partial unique index).
        if (cleanPhone !== '') {
            const phoneTaken = await User.findOne({ phone: cleanPhone });
            if (phoneTaken) {
                return res.status(400).json({ success: false, error: 'This phone number is already registered.' });
            }
        }

        const newUser = await User.create({
            username: cleanUsername,
            name: cleanName,
            email: cleanEmail,
            phone: cleanPhone,
            passwordHash: pHash,
            token,
            deviceId: deviceId ? deviceId.trim() : '',
            displayKamalId: String(displayId || '').slice(0, 32),
            credits: baseCredits,
            referralCode: userReferral,
            referredBy: referralCode || '',
            status: 'active',
            tier: 'FREE',
            proPlan: 'trial',
            // v91 (BugHunter DB P2-23): trial users no longer report a
            // 'Lifetime' expiry — trial has no expiry string.
            planExpiry: ''
        });

        // PHASE B: create the Kamal ID device binding in the same flow.
        // Best-effort: a device-record failure must never fail registration.
        try {
            const cleanHash = String(deviceHash || '').trim().slice(0, 128);
            if (cleanHash) {
                const Device = require('../models/Device');
                await Device.findOneAndUpdate(
                    { deviceHash: cleanHash },
                    {
                        $set: {
                            displayId: String(displayId || '').slice(0, 32),
                            userId: newUser._id,
                            model: String(model || '').slice(0, 128),
                            appVersion: String(appVersion || '').slice(0, 32),
                            lastSeenAt: new Date()
                        },
                        $setOnInsert: { deviceHash: cleanHash, firstSeenAt: new Date() }
                    },
                    { upsert: true }
                );
            }
        } catch (_) { /* device binding is best-effort */ }

        // PHASE D hook: optional referral code from RegisterScreen.
        // Fraud guard: only when deviceHash/displayId is present and the code
        // is valid does the row get marked 'applied' with 20+20 credits.
        // A referral problem NEVER fails registration.
        let referralApplied = false;
        if (pendingReferralCode) {
            try {
                const { applyReferralFor } = require('./referralController');
                const applied = await applyReferralFor({
                    code: pendingReferralCode,
                    user: newUser,
                    kamalId: String(displayId || '').trim()
                });
                referralApplied = applied.ok === true;
            } catch (_) { /* referral is best-effort */ }
        }

        return res.json({
            success: true,
            message: 'Registration approved.',
            token,
            referralApplied,
            user: toSafeUser(newUser)
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Login Controller
async function login(req, res) {
    await connectToDatabase();
    // v91 (BugHunter backend F4): config load wrapped — see register.
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

    const { email, username, password, deviceId } = req.body;
    const rawIdentifier = String(email || username || req.body?.phone || '').trim();
    if (!rawIdentifier || !password) {
        return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
    }
    // v91 (BugHunter DB P0-3): normalize BEFORE the lookup (phone -> +92,
    // username/email -> lowercase), exactly as register stores them.
    const identifier = normalizeLoginIdentifier(rawIdentifier);
    // PHASE F: decrypt an RSA-encrypted password before verification.
    let plainPassword;
    try {
        plainPassword = maybeDecryptPassword(password, req.body.passwordEncrypted);
    } catch (e) {
        return res.status(e.status || 500).json({ success: false, error: e.message || 'Password error.' });
    }

    const { isDbConnected } = require('../config/db');
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. User login requires database connection.' });
    }

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

        const { ok, migrate } = verifyPassword(plainPassword, user);
        if (!ok) {
            return res.status(401).json({ success: false, error: 'Invalid credentials.' });
        }

        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: `Account Suspended: ${user.banReason || 'Policy violation'}` });
        }

        // Hardware lock check & bind
        let bindDevice = null;
        if (deviceId) {
            const cleanDevice = deviceId.trim();
            if (user.deviceId && user.deviceId !== cleanDevice) {
                return res.status(403).json({
                    success: false,
                    error: 'Hardware Mismatch: Account bound to another device. Contact Owner or request unlock from Admin.'
                });
            }
            if (!user.deviceId) {
                bindDevice = cleanDevice;
            }
        }

        // v91 (BugHunter DB P0-3): the token is signed from the RESOLVED
        // user.username — the old code signed the raw identifier before the
        // lookup, so email/phone logins minted unusable tokens.
        const token = generateToken(user.username);
        // v91 (BugHunter DB P1-13): targeted $set instead of whole-doc save()
        // — save() revalidates every path, so a legacy out-of-enum document
        // made login 500 forever.
        const set = { token, lastActiveAt: new Date() };
        // Transparent migration: a legacy hash worked → re-hash with bcrypt now.
        if (migrate) set.passwordHash = hashPassword(plainPassword);
        if (bindDevice) set.deviceId = bindDevice;
        await User.updateOne({ _id: user._id }, { $set: set });
        user.token = token;
        if (bindDevice) user.deviceId = bindDevice;

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

// Verify Controller (JWT-authenticated; username from verified token ONLY.
// BH-1 FIX: the ?username= / body.username fallback is removed — it let
// anyone verify-as / enumerate any user without a token.)
async function verify(req, res) {
    await connectToDatabase();
    const username = req.user?.username;
    if (!username) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    try {
        const user = await User.findOne({ username: String(username).trim() });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ success: false, error: `Account suspended: ${user.banReason || 'Banned'}` });

        // v91 (BugHunter DB P1-13): targeted $set, not whole-doc save().
        await User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } });
        // SECURITY FIX (#3): allowlisted user object — no passwordHash/customGeminiKey.
        return res.json({ success: true, user: toSafeUser(user) });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// v91 (BugHunter backend F26): user logout — revokes the bearer token so it
// stops working immediately instead of staying valid for up to 30 days.
// The app calls this before clearing its local session (Phase 2).
async function userLogout(req, res) {
    const rawToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (rawToken && typeof rawToken === 'string') {
        const { revokeToken } = require('../middleware/auth');
        await revokeToken(rawToken.trim(), 'user_logout');
    }
    return res.json({ success: true, message: 'Logged out.' });
}

module.exports = {
    register,
    login,
    verify,
    userLogout,
    serverPubkey,
    maybeDecryptPassword
};
