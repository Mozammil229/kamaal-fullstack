const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { generateWithKeyPool } = require('../services/geminiService');
const { connectToDatabase } = require('../config/db');

// AI Chat Controller (/api/chat)
async function chat(req, res) {
    await connectToDatabase();
    const conf = await AppConfig.findOne({ key: 'global_config' });
    if (conf?.maintenance?.enabled) {
        return res.status(503).json({ success: false, error: conf.maintenance.message });
    }

    const { username, message } = req.body;
    if (!message) return res.status(400).json({ success: false, error: 'Message required.' });

    let effectivePrompt = conf?.systemPrompt || 'You are Kammal AI, video optimization specialist.';
    if (username) {
        const user = await User.findOne({ username });
        if (user) {
            if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Suspended.' });
            if (user.customPrompt?.trim()) effectivePrompt = user.customPrompt.trim();
        }
    }

    const modelToUse = conf?.currentModel || 'gemini-2.5-flash';
    try {
        const reply = await generateWithKeyPool(message, effectivePrompt, modelToUse);
        return res.json({ success: true, reply, model: modelToUse });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
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

module.exports = {
    chat,
    getSystemPrompt
};
