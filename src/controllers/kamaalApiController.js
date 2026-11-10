const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const KamaalApiKey = require('../models/KamaalApiKey');
const apikeyCrypto = require('../services/apikeyCrypto');
const pool = require('../services/providerKeyPool');
const gemini = require('../services/geminiService');
const { generateAIReply } = require('../services/aiProviderChain');
const { modifyCredits } = require('../services/ledgerService');
const { connectToDatabase } = require('../config/db');

// PUBLIC Kamaal API — Kamaal API track (2026-11-05).
// POST /api/v1/chat — usable from outside the app with a kml_ API key.
// Auth is the kml_ key itself (X-Kamaal-Key header); no user JWT.
//
// CREDIT GATE (user order 2026-11-05 — applies to THIS surface only):
// the AI checks the attached user's credits BEFORE serving: 1 credit per
// call, atomic check-and-deduct at authorize time via ledgerService, ALL
// users incl. PRO. A failed provider attempt still consumes the credit
// (standing credit rule, same as patch authorize). 0 credits -> 402.
// In-app POST /api/chat is UNTOUCHED and stays credit-free (2026-10-20).
//
// BYOK: X-Gemini-Key header with the caller's own Gemini key -> used
// FIRST, pool keys follow, and the credit deduction is SKIPPED (own quota).
// Tier: basic -> gemini-3.5-flash-lite, advance -> gemini-3.6-flash.
// Credit price is 1/call for both tiers (tier pricing is an open owner
// decision — not invented here).

const TIER_MODELS = { basic: 'gemini-3.5-flash-lite', advance: 'gemini-3.6-flash' };
const CREDIT_PRICE = 1;

async function resolveKey(req) {
    const raw = String(req.headers['x-kamaal-key'] || '').trim();
    if (!raw) {
        const err = new Error('X-Kamaal-Key header required.');
        err.status = 401; err.code = 'KEY_REQUIRED';
        throw err;
    }
    // 4E F-09: the findOne DB call used to sit unguarded — a DB-layer
    // failure threw a raw error whose message the chat/status catch
    // returned verbatim (e.message), leaking internals (connection
    // strings, driver errors). DB errors here now throw a sanitised
    // 503 with the generic message, never the raw one.
    let row;
    try {
        row = await KamaalApiKey.findOne({ tokenHash: apikeyCrypto.sha256(raw) }).lean();
    } catch (_) {
        const err = new Error('Database offline. Please try again.');
        err.status = 503; err.code = 'DB_ERROR';
        throw err;
    }
    if (!row) {
        const err = new Error('Invalid API key.');
        err.status = 401; err.code = 'INVALID_KEY';
        throw err;
    }
    if (row.status === 'revoked') {
        const err = new Error('This API key has been revoked.');
        err.status = 401; err.code = 'KEY_REVOKED';
        throw err;
    }
    if (!row.ownerUsername) {
        const err = new Error('This API key is not attached to a user yet. Ask the admin to attach it.');
        err.status = 403; err.code = 'KEY_NOT_ATTACHED';
        throw err;
    }
    return row;
}

async function chat(req, res) {
    await connectToDatabase();
    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
        return res.status(400).json({ success: false, error: 'Message required.' });
    }
    if (String(message).length > 16384) {
        return res.status(400).json({ success: false, error: 'Message is too long (max 16384 characters).' });
    }

    let keyRow;
    try {
        keyRow = await resolveKey(req);
    } catch (e) {
        return res.status(e.status || 401).json({ success: false, code: e.code || 'KEY_ERROR', error: e.message });
    }

    const tier = req.body?.tier === 'advance' || (req.body?.tier !== 'basic' && keyRow.tier === 'advance')
        ? 'advance' : 'basic';
    const modelToUse = TIER_MODELS[tier];
    const ownKey = String(req.headers['x-gemini-key'] || '').trim();
    const useByok = ownKey.length > 10;

    let dbUser = null;
    let creditsRemaining = null;
    if (!useByok) {
        try {
            dbUser = await User.findOne({ username: keyRow.ownerUsername });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        if (!dbUser) {
            return res.status(403).json({ success: false, code: 'OWNER_NOT_FOUND', error: 'The user this key is attached to no longer exists.' });
        }
        if (dbUser.status === 'banned') {
            return res.status(403).json({ success: false, error: 'Suspended.' });
        }
        if ((dbUser.credits || 0) < CREDIT_PRICE) {
            return res.status(402).json({
                success: false,
                code: 'NO_CREDITS',
                error: 'Credits khatam ho gaye hain. Credits khareedein ya admin se rabta karein.',
                creditsRemaining: dbUser.credits || 0
            });
        }
        // Atomic check-and-deduct BEFORE the provider call (authorize-time,
        // same as patch authorize; a failed attempt still consumes 1).
        try {
            const { user } = await modifyCredits({
                username: dbUser.username,
                amount: -CREDIT_PRICE,
                type: 'usage_deduct',
                description: `Kamaal API call (${tier})`,
                adminUser: 'System'
            });
            creditsRemaining = user.credits;
        } catch (e) {
            return res.status(402).json({ success: false, code: 'NO_CREDITS', error: 'Credits khatam ho gaye hain. Credits khareedein ya admin se rabta karein.' });
        }
    }

    let conf = null;
    try {
        conf = await AppConfig.findOne({ key: 'global_config' }).lean();
    } catch (_) { /* default prompt below */ }
    const effectivePrompt = conf?.systemPrompt || 'You are Kammal AI, video optimization specialist.';

    try {
        let reply;
        if (useByok) {
            const poolKeys = await pool.getPoolKeys('gemini');
            reply = await gemini.generateWithKeys([ownKey, ...poolKeys], String(message), effectivePrompt, modelToUse);
        } else {
            reply = await generateAIReply(String(message), effectivePrompt, '', modelToUse);
        }
        // Best-effort usage accounting (never fails the response).
        KamaalApiKey.updateOne(
            { _id: keyRow._id },
            { $inc: { callsUsed: 1 }, $set: { lastUsedAt: new Date() } }
        ).catch(() => {});
        return res.json({ success: true, reply, model: modelToUse, tier, creditsRemaining });
    } catch (e) {
        const status = (e.code === 'GEMINI_KEY_MISSING' || e.code === 'AI_KEY_MISSING') ? 503 : 500;
        return res.status(status).json({ success: false, error: 'Something went wrong. Please try again.', code: e.code || 'AI_ERROR', tier, creditsRemaining });
    }
}

// GET /api/v1/status — key check WITHOUT spending a credit.
// { success, tier, ownerUsername, creditsRemaining, callsUsed }
async function status(req, res) {
    await connectToDatabase();
    let keyRow;
    try {
        keyRow = await resolveKey(req);
    } catch (e) {
        return res.status(e.status || 401).json({ success: false, code: e.code || 'KEY_ERROR', error: e.message });
    }
    let creditsRemaining = null;
    try {
        const dbUser = await User.findOne({ username: keyRow.ownerUsername }).select('credits').lean();
        creditsRemaining = dbUser ? dbUser.credits : null;
    } catch (_) { /* leave null */ }
    return res.json({
        success: true,
        tier: keyRow.tier,
        ownerUsername: keyRow.ownerUsername,
        creditsRemaining,
        callsUsed: keyRow.callsUsed || 0
    });
}

module.exports = { chat, status };
