const User = require('../models/User');
const { connectToDatabase } = require('../config/db');
const { testUserKey } = require('../services/geminiService');

// NOTE: never log a raw API key anywhere. Only last4 may appear in logs.

function last4(k) {
    const s = String(k || '');
    return s.length >= 4 ? s.slice(-4) : '';
}

// POST /api/user/gemini-key  { username, key }
// Tests the key with a tiny "hello" (no pool fallback), then stores it on the user.
async function saveGeminiKey(req, res) {
    await connectToDatabase();
    const { username, key } = req.body || {};
    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });
    const cleanKey = String(key || '').trim();
    if (cleanKey.length < 10) return res.status(400).json({ success: false, error: 'Key too short.' });

    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
    if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Suspended.' });

    try {
        await testUserKey(cleanKey);
    } catch (e) {
        return res.status(400).json({
            success: false,
            error: 'Key test failed: ' + (e.message || 'invalid key'),
            code: e.code || 'KEY_TEST_FAILED'
        });
    }

    user.customGeminiKey = cleanKey;
    await user.save();
    console.log(`Custom Gemini key saved for user ${username} (****${last4(cleanKey)})`);
    return res.json({ success: true, last4: last4(cleanKey) });
}

// DELETE /api/user/gemini-key?username=...
async function deleteGeminiKey(req, res) {
    await connectToDatabase();
    const { username } = req.query || {};
    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
    user.customGeminiKey = '';
    await user.save();
    console.log(`Custom Gemini key removed for user ${username}`);
    return res.json({ success: true });
}

// GET /api/user/gemini-key/status?username=...
async function geminiKeyStatus(req, res) {
    await connectToDatabase();
    const { username } = req.query || {};
    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });
    const user = await User.findOne({ username });
    const k = user?.customGeminiKey || '';
    return res.json({ success: true, hasKey: k.length > 10, last4: last4(k) });
}

module.exports = { saveGeminiKey, deleteGeminiKey, geminiKeyStatus };
