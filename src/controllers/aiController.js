const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { generateAIReply } = require('../services/aiProviderChain');
const aiUsage = require('../services/aiUsageService');
const personaPrompts = require('../personas/personaPrompts');
const memoryService = require('../services/memoryService');
const memoryCrypto = require('../services/memoryCrypto');
const { connectToDatabase } = require('../config/db');

// PRO PERSONAS (user order 2026-10-20): the prompts live ONLY on the
// server (src/personas/personaPrompts.js, verbatim user-supplied texts).
// The app sends just the persona id; the client-side systemInstruction
// is ignored for these ids exactly like it is for every other request.
// 'normal' / 'evil' / anything else keeps today's behavior untouched.
const PRO_PERSONAS = {
    darkmind: personaPrompts.darkmind,
    mentalist: personaPrompts.mentalist,
    satirist: personaPrompts.satirist,
};

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
    // ROUND 2 (2026-10-21): BYOK fully retired — User.customGeminiKey is no
    // longer read or honored anywhere. Chat always uses the shared provider
    // chain (Groq -> Gemini pool -> OpenRouter). The schema field stays in
    // the User model (harmless, per the Safai decision) but is never read.
    const userGeminiKey = '';
    let dbUser = null;
    if (username) {
        const user = await User.findOne({ username });
        if (user) {
            dbUser = user;
            if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Suspended.' });
            if (user.customPrompt?.trim()) effectivePrompt = user.customPrompt.trim();
        }
    }

    // PRO PERSONA GATE (2026-10-20): darkmind / mentalist / satirist are
    // PRO-only. Non-PRO -> 403 PRO_REQUIRED, no reply is generated.
    const personaId = String(req.body?.persona || '').trim().toLowerCase();
    const isProUser = !!(dbUser && aiUsage.isUnlimited(dbUser));
    if (Object.prototype.hasOwnProperty.call(PRO_PERSONAS, personaId)) {
        if (!isProUser) {
            return res.status(403).json({ success: false, code: 'PRO_REQUIRED', error: 'Ye PRO feature hai.' });
        }
        effectivePrompt = PRO_PERSONAS[personaId];
    }

    // AI MEMORY INJECTION (2026-10-20): PRO users with memory enabled get
    // their decrypted long-term facts appended to the system instruction
    // (works with ANY persona, including normal). Fail-soft: any problem
    // (engine unconfigured, DB hiccup, undecryptable fact) just skips the
    // block — the chat itself never breaks over memory.
    let memoryDoc = null;
    if (username && isProUser && memoryCrypto.isConfigured()) {
        try {
            memoryDoc = await memoryService.loadMemory(username);
            if (memoryService.memoryEnabled(memoryDoc)) {
                const block = memoryService.buildMemoryBlock(memoryDoc);
                if (block) effectivePrompt = `${effectivePrompt}\n\n${block}`;
            }
        } catch (_) { /* memory is best-effort */ }
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

    const modelToUse = conf?.currentModel || 'gemini-2.5-flash';
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
        const sent = res.json({ success: true, reply, model: modelToUse });
        // AI MEMORY EXTRACTION (2026-10-20): fire-and-forget AFTER the
        // reply is sent — never blocks or fails the chat response. Learns
        // durable facts the user stated about themselves (PRO + enabled
        // only; the service re-checks both and fails soft on any error).
        if (username && isProUser && memoryCrypto.isConfigured() && memoryService.memoryEnabled(memoryDoc)) {
            memoryService.extractAndSave({
                username,
                userMessage: message,
                assistantReply: reply,
                userGeminiKey,
            }).catch(() => {});
        }
        return sent;
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
            currentModel: conf?.currentModel || 'gemini-2.5-flash',
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
