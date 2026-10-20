const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { generateAIReply } = require('../services/aiProviderChain');
const aiUsage = require('../services/aiUsageService');
const { connectToDatabase } = require('../config/db');

// AI Chat Controller (/api/chat)
async function chat(req, res) {
    await connectToDatabase();
    const conf = await AppConfig.findOne({ key: 'global_config' });
    if (conf?.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message });
    }

    const { message } = req.body;
    // SECURITY FIX (#6): the quota-burning identity is the verified JWT user,
    // never a client-supplied username (otherwise anyone could burn the
    // victim's personal Gemini key quota).
    const username = req.user?.username;
    if (!message) return res.status(400).json({ success: false, error: 'Message required.' });

    let effectivePrompt = conf?.systemPrompt || 'You are Kammal AI, video optimization specialist.';
    let userGeminiKey = '';
    let dbUser = null;
    if (username) {
        // NOTE: customGeminiKey is select:false — explicitly include it.
        const user = await User.findOne({ username }).select('+customGeminiKey');
        if (user) {
            dbUser = user;
            if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Suspended.' });
            if (user.customPrompt?.trim()) effectivePrompt = user.customPrompt.trim();
            userGeminiKey = user.customGeminiKey || '';
        }
    }

    // DAILY FREE-AI TIME BUDGET (user order 2026-10-20): AI conversation
    // costs NO credits and is NEVER blocked by credit balance — but FREE
    // users share a 20-minute/day ONLINE AI pool (tracked via
    // /api/ai/usage/report). Once the pool is empty the server refuses
    // new turns until midnight Asia/Karachi. PAID/PRO are unlimited.
    if (username && dbUser && !aiUsage.isUnlimited(dbUser)) {
        const left = await aiUsage.hasBudgetLeft(username, dbUser);
        if (!left) {
            return res.status(429).json({
                success: false,
                code: 'AI_DAILY_LIMIT',
                error: 'Aaj ke free 20 minute khatam ho gaye hain. Kal phir milein ge — ya Pro lein, phir koi limit nahi.',
            });
        }
    }

    const modelToUse = conf?.currentModel || 'gemini-3.8-flash';
    try {
        // PHASE H: multi-provider free fallback chain — Groq -> Gemini pool
        // (user's own key first, then shared pool) -> OpenRouter :free.
        // AI CONVERSATION IS CREDIT-FREE (user order 2026-10-20): this
        // endpoint NEVER checks or deducts credits; any balance (incl. 0)
        // is served. The only limits are the 20/min rate limit and the
        // FREE-tier daily 20-minute time pool enforced above.
        const reply = await generateAIReply(message, effectivePrompt, userGeminiKey, modelToUse);
        // Contract unchanged: { success: true, reply, model } — the app's
        // /api/ai/chat and /api/chat callers see no shape change.
        return res.json({ success: true, reply, model: modelToUse });
    } catch (e) {
        // Never fabricate an AI reply on failure. Surface a clear, client-safe error.
        const status = (e.code === 'GEMINI_KEY_MISSING' || e.code === 'AI_KEY_MISSING') ? 503 : 500;
        return res.status(status).json({ success: false, error: e.message, code: e.code || 'AI_ERROR' });
    }
}

// AI System Prompt Info (/api/ai/system-prompt)
async function getSystemPrompt(req, res) {
    await connectToDatabase();
    try {
        const conf = await AppConfig.findOne({ key: 'global_config' });
        return res.json({
            success: true,
            systemPrompt: conf?.systemPrompt,
            currentModel: conf?.currentModel || 'gemini-3.8-flash',
            featureFlags: conf?.featureFlags
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// GET /api/ai/usage — remaining daily ONLINE-AI seconds for the JWT user.
// { success, unlimited, limitSeconds, secondsUsed, remainingSeconds }
async function getUsage(req, res) {
    await connectToDatabase();
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Login required.' });
    try {
        const user = await User.findOne({ username });
        const u = await aiUsage.getUsage(username, user);
        return res.json({ success: true, ...u });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// POST /api/ai/usage/report { seconds } — the app reports elapsed ONLINE-AI
// time at session end (and periodically); the server adds it to today's
// pool and returns the fresh remaining balance. This is the enforcement
// record — client-side timers are display only.
async function reportUsage(req, res) {
    await connectToDatabase();
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Login required.' });
    try {
        const user = await User.findOne({ username });
        const u = await aiUsage.addUsage(username, user?.displayKamalId || '', req.body?.seconds, user);
        return res.json({ success: true, ...u });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    chat,
    getSystemPrompt,
    getUsage,
    reportUsage
};
