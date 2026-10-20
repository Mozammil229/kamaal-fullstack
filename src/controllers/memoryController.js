const User = require('../models/User');
const UserMemory = require('../models/UserMemory');
const { isUnlimited } = require('../services/aiUsageService');
const memoryCrypto = require('../services/memoryCrypto');
const memoryService = require('../services/memoryService');
const { connectToDatabase } = require('../config/db');

// AI MEMORY endpoints (user order 2026-10-20). All behind authenticateUser;
// identity comes ONLY from the verified JWT — a user can only ever access
// their OWN memory. There is deliberately NO admin route to this data.
// PRO-only: non-PRO -> 403 { success:false, code:'PRO_REQUIRED' }.
// Engine not configured (MEMORY_ENC_KEY missing) -> 503 MEMORY_NOT_CONFIGURED.

async function guard(req, res) {
    await connectToDatabase();
    const username = req.user?.username;
    if (!username) {
        res.status(401).json({ success: false, error: 'Login required.' });
        return null;
    }
    const user = await User.findOne({ username });
    if (!user || !isUnlimited(user)) {
        res.status(403).json({ success: false, code: 'PRO_REQUIRED', error: 'Ye PRO feature hai.' });
        return null;
    }
    if (!memoryCrypto.isConfigured()) {
        res.status(503).json({ success: false, code: 'MEMORY_NOT_CONFIGURED', error: 'AI Memory abhi server par configured nahi hai.' });
        return null;
    }
    return username;
}

// GET /api/ai/memory -> { success, enabled, facts: [decrypted, owner's own] }
async function getMemory(req, res) {
    try {
        const username = await guard(req, res);
        if (!username) return;
        const doc = await memoryService.loadMemory(username);
        return res.json({
            success: true,
            enabled: memoryService.memoryEnabled(doc),
            facts: memoryService.decryptFacts(doc).map(f => ({
                id: f.id, category: f.category, key: f.key, value: f.value,
                kind: f.kind, updatedAt: f.updatedAt,
            })),
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// DELETE /api/ai/memory/:factId — remove one fact of the owner.
async function deleteFact(req, res) {
    try {
        const username = await guard(req, res);
        if (!username) return;
        const doc = await memoryService.loadMemory(username);
        if (!doc) return res.json({ success: true, removed: false });
        const before = doc.facts.length;
        doc.facts = doc.facts.filter(f => String(f._id) !== String(req.params.factId));
        const removed = doc.facts.length !== before;
        if (removed) {
            doc.updatedAt = new Date();
            await doc.save();
        }
        return res.json({ success: true, removed });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// DELETE /api/ai/memory — clear ALL facts (the enabled switch is kept).
async function clearMemory(req, res) {
    try {
        const username = await guard(req, res);
        if (!username) return;
        await UserMemory.findOneAndUpdate(
            { username },
            { $set: { facts: [], updatedAt: new Date() }, $setOnInsert: { username, enabled: true } },
            { upsert: true },
        );
        return res.json({ success: true, cleared: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// POST /api/ai/memory/settings { enabled: boolean }
async function updateSettings(req, res) {
    try {
        const username = await guard(req, res);
        if (!username) return;
        const enabled = req.body?.enabled === true;
        const doc = await UserMemory.findOneAndUpdate(
            { username },
            { $set: { enabled, updatedAt: new Date() }, $setOnInsert: { username, facts: [] } },
            { upsert: true, new: true },
        );
        return res.json({ success: true, enabled: doc.enabled });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = { getMemory, deleteFact, clearMemory, updateSettings };
