// ============================================================================
// PHASE D — "Dost lao, credits pao" (VIRAL LOOP).
//
// Deterministic referral code per user: "KML-" + first 6 of
// SHA-256(username + "|" + kamalDisplayId), uppercased. The Android client
// derives the SAME code locally with the identical formula, so the Account
// screen can show it even before /api/referral/my is deployed.
//
// Reward: 20 credits to the referrer + 20 credits to the referred user,
// granted server-side only. One referral per Kamal ID (unique index on
// Referral.referredKamalId) is the fraud guard against farming.
//
// GRACEFUL DEGRADATION: the Android app treats these endpoints as
// not-deployed-yet — share-via-WhatsApp always works, apply fails soft with
// a human message, and the counter shows local/empty honestly. No fake data.
// ============================================================================
const crypto = require('crypto');
const { connectToDatabase } = require('../config/db');
const User = require('../models/User');
const Referral = require('../models/Referral');
const Transaction = require('../models/Transaction');
const { bumpEarnedAndRetag } = require('../services/socialTagService');

// Fixed reward per spec: 20 to the referrer, 20 to the newcomer.
const REFERRAL_REWARD_CREDITS = 20;

/**
 * Deterministic code: "KML-" + first 6 hex chars of
 * SHA-256(username + "|" + kamalDisplayId), uppercased.
 * MUST stay in sync with ReferralManager.deriveCode() on Android.
 */
function deriveReferralCode(username, kamalDisplayId) {
    const clean = String(username || '').trim().toLowerCase();
    const kid = String(kamalDisplayId || '').trim();
    const hex = crypto.createHash('sha256')
        .update(clean + '|' + kid, 'utf8')
        .digest('hex')
        .slice(0, 6)
        .toUpperCase();
    return 'KML-' + hex;
}

/**
 * Lazy migration: old random "KAM-XXXX-NNNN" codes (and empty ones) become
 * the deterministic KML- code on first read. Saves only when changed.
 */
async function getOrAssignCode(user) {
    if (user.referralCode && /^KML-[0-9A-F]{6}$/.test(user.referralCode)) {
        return user.referralCode;
    }
    const code = deriveReferralCode(user.username, user.displayKamalId || '');
    user.referralCode = code;
    try { await user.save(); } catch (_) { /* best-effort */ }
    return code;
}

/**
 * Look up the code owner. Matches the deterministic KML- codes; also honors
 * legacy "KAM-XXXX-NNNN" codes still stored on old accounts.
 */
async function findReferrer(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) return null;
    return await User.findOne({ referralCode: code })
        || await User.findOne({ referralCode: code.toUpperCase() });
}

/**
 * Core apply logic shared by the register hook and POST /api/referral/apply.
 * Returns { ok, error, status, referrerUsername, creditsAdded }.
 * NEVER throws on referral failure — a referral problem must not fail
 * registration or crash the endpoint; callers decide the HTTP shape.
 */
async function applyReferralFor({ code, user, kamalId }) {
    const referrer = await findReferralFor(code);
    if (!referrer) {
        return { ok: false, status: 404, error: 'Yeh referral code ghalat hai. Code dobara check karo.' };
    }
    if (String(referrer._id) === String(user._id)) {
        return { ok: false, status: 400, error: 'Apna khud ka referral code use nahi kar sakte.' };
    }
    const kid = String(kamalId || user.displayKamalId || '').trim();
    if (!kid) {
        return { ok: false, status: 400, error: 'Device identity missing hai — referral apply nahi ho saka.' };
    }
    // Fraud guard: one referral per Kamal ID, ever.
    const already = await Referral.findOne({ referredKamalId: kid });
    if (already) {
        return { ok: false, status: 409, error: 'Is device par referral pehle hi use ho chuka hai.' };
    }

    // Create the row FIRST: the unique index makes this atomic against races.
    let row;
    try {
        row = await Referral.create({
            code: referrer.referralCode,
            referrerUserId: referrer._id,
            referrerUsername: referrer.username,
            referredUserId: user._id,
            referredUsername: user.username,
            referredKamalId: kid,
            status: 'applied',
            creditsAwarded: REFERRAL_REWARD_CREDITS * 2
        });
    } catch (e) {
        if (e && e.code === 11000) {
            return { ok: false, status: 409, error: 'Is device par referral pehle hi use ho chuka hai.' };
        }
        return { ok: false, status: 500, error: 'Referral save nahi ho saka. Thodi der baad try karo.' };
    }

    // Award 20 + 20 server-side.
    referrer.credits = (referrer.credits || 0) + REFERRAL_REWARD_CREDITS;
    bumpEarnedAndRetag(referrer, REFERRAL_REWARD_CREDITS);
    await referrer.save();
    user.credits = (user.credits || 0) + REFERRAL_REWARD_CREDITS;
    bumpEarnedAndRetag(user, REFERRAL_REWARD_CREDITS);
    await user.save();

    try {
        await Transaction.create([
            {
                username: referrer.username,
                type: 'referral_bonus',
                creditsChange: REFERRAL_REWARD_CREDITS,
                newBalance: referrer.credits,
                description: `Referral reward: ${user.username} joined with your code ${referrer.referralCode}`,
                adminUser: 'referral-system'
            },
            {
                username: user.username,
                type: 'referral_bonus',
                creditsChange: REFERRAL_REWARD_CREDITS,
                newBalance: user.credits,
                description: `Welcome bonus: joined with ${referrer.username}'s code ${referrer.referralCode}`,
                adminUser: 'referral-system'
            }
        ]);
    } catch (_) { /* telemetry only; credits already granted */ }

    return {
        ok: true,
        status: 200,
        referrerUsername: referrer.username,
        creditsAdded: REFERRAL_REWARD_CREDITS,
        newBalance: user.credits,
        referralId: String(row._id)
    };
}

// Named alias kept for readability at call sites.
async function findReferralFor(code) { return findReferrer(code); }

// POST /api/referral/apply { code } — JWT identity from the VERIFIED token only.
async function applyReferral(req, res) {
    await connectToDatabase();
    try {
        const tokenUser = req.user && (req.user.username || req.user.sub);
        if (!tokenUser) {
            return res.status(401).json({ success: false, error: 'Session invalid hai. Dobara login karo.' });
        }
        const user = await User.findOne({ username: String(tokenUser).toLowerCase() });
        if (!user) {
            return res.status(404).json({ success: false, error: 'Account nahi mila.' });
        }
        const { code } = req.body || {};
        if (!code || !String(code).trim()) {
            return res.status(400).json({ success: false, error: 'Referral code likho.' });
        }
        const result = await applyReferralFor({ code, user, kamalId: user.displayKamalId });
        if (!result.ok) {
            return res.status(result.status).json({ success: false, error: result.error });
        }
        return res.json({
            success: true,
            message: `Mubarak! ${result.creditsAdded} credits mil gaye — ${result.referrerUsername} ko bhi ${result.creditsAdded} mile.`,
            creditsAdded: result.creditsAdded,
            newBalance: result.newBalance,
            referrerUsername: result.referrerUsername
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Kuch ghalat ho gaya. Thodi der baad try karo.' });
    }
}

// GET /api/referral/my — { code, count, creditsEarned }. JWT identity only.
async function myReferrals(req, res) {
    await connectToDatabase();
    try {
        const tokenUser = req.user && (req.user.username || req.user.sub);
        if (!tokenUser) {
            return res.status(401).json({ success: false, error: 'Session invalid hai. Dobara login karo.' });
        }
        const user = await User.findOne({ username: String(tokenUser).toLowerCase() });
        if (!user) {
            return res.status(404).json({ success: false, error: 'Account nahi mila.' });
        }
        const code = await getOrAssignCode(user);
        const count = await Referral.countDocuments({ referrerUserId: user._id, status: 'applied' });
        return res.json({
            success: true,
            code,
            count,
            creditsEarned: count * REFERRAL_REWARD_CREDITS
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Kuch ghalat ho gaya. Thodi der baad try karo.' });
    }
}

module.exports = {
    REFERRAL_REWARD_CREDITS,
    deriveReferralCode,
    getOrAssignCode,
    applyReferralFor,
    applyReferral,
    myReferrals
};
