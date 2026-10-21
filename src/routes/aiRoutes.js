const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const memoryController = require('../controllers/memoryController');
const extractController = require('../controllers/extractController');
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
// SECURITY (Round 2, 2026-10-21): was PUBLIC — anyone could read the raw
// system prompt unauthenticated. Now JWT-gated. The app still works: its
// ApiClient authInterceptor injects the Bearer token on every request,
// and fetchServerSystemPrompt() fails soft (null) when logged out.
router.get('/ai/system-prompt', authenticateUser, aiController.getSystemPrompt);
// DAILY FREE-AI TIME BUDGET (2026-10-20): remaining-seconds lookup +
// elapsed-time report for the FREE tier's 20 min/day ONLINE AI pool.
router.get('/ai/usage', authenticateUser, aiController.getUsage);
router.post('/ai/usage/report', authenticateUser, aiController.reportUsage);

// AI MEMORY (2026-10-20): the owner's own long-term memory — PRO-only,
// JWT identity only, NO admin route exists for this data by design.
router.get('/ai/memory', authenticateUser, memoryController.getMemory);
router.delete('/ai/memory/:factId', authenticateUser, memoryController.deleteFact);
router.delete('/ai/memory', authenticateUser, memoryController.clearMemory);
router.post('/ai/memory/settings', authenticateUser, memoryController.updateSettings);

// ALL-IN-ONE DOWNLOADER (2026-10-20): one link in -> normalized format list
// out. Providers are called server-side only; per-user throttle matches the
// AI chat limit (20/min) so the shared free provider quota cannot be burned
// by one client.
const extractBuckets = new Map();
function extractRateLimit(req, res, next) {
    const key = req.user?.username || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 20;
    let entry = extractBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    extractBuckets.set(key, entry);
    if (extractBuckets.size > 5000) extractBuckets.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}
router.post('/extract', authenticateUser, extractRateLimit, extractController.extract);
router.post('/extract/resolve', authenticateUser, extractRateLimit, extractController.resolve);

module.exports = router;
