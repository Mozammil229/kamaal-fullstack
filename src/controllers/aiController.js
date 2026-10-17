const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { generateWithUserKeyFirst } = require('../services/geminiService');
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
    if (username) {
        // NOTE: customGeminiKey is select:false — explicitly include it.
        const user = await User.findOne({ username }).select('+customGeminiKey');
        if (user) {
            if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Suspended.' });
            if (user.customPrompt?.trim()) effectivePrompt = user.customPrompt.trim();
            userGeminiKey = user.customGeminiKey || '';
        }
    }

    const modelToUse = conf?.currentModel || 'gemini-3.8-flash';
    try {
        const reply = await generateWithUserKeyFirst(userGeminiKey, message, effectivePrompt, modelToUse);
        return res.json({ success: true, reply, model: modelToUse });
    } catch (e) {
        // Never fabricate an AI reply on failure. Surface a clear, client-safe error.
        const status = e.code === 'GEMINI_KEY_MISSING' ? 503 : 500;
        return res.status(status).json({ success: false, error: e.message, code: e.code || 'GEMINI_ERROR' });
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

module.exports = {
    chat,
    getSystemPrompt
};
