const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateUser } = require('../middleware/auth');

// SECURITY FIX (#6) + PHASE H: AI chat burns free-tier quota on the owner's
// providers (including the caller's own custom key). Require a valid user JWT
// and throttle per user so one client cannot exhaust the shared free quota
// that every user relies on. Best-effort in-memory bucket — Vercel
// serverless instances each keep their own.
const aiChatBuckets = new Map();
function aiChatRateLimit(req, res, next) {
    const key = req.user?.username || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 20; // PHASE H: 20 AI messages/min per user (was 30)
    let entry = aiChatBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    aiChatBuckets.set(key, entry);
    if (aiChatBuckets.size > 5000) aiChatBuckets.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}

router.post('/chat', authenticateUser, aiChatRateLimit, aiController.chat);
// Alias used by some Android client builds (ApiService.chatWithAi)
router.post('/ai/chat', authenticateUser, aiChatRateLimit, aiController.chat);
router.get('/ai/system-prompt', aiController.getSystemPrompt);

module.exports = router;
