// Flow Engine X P13 — Cross-Device Synchronization routes.
// Mounted at /api/flow in src/app.js. EVERY route carries
// authenticateUser (JWT) + the 20/min per-user bucket (same shape as
// the P2 flow/generate bucket). No route here is public, no route
// logs request bodies, no route stores a secret or message body.

'use strict';

const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/auth');
const handlers = require('../controllers/flowSyncController');

const flowSyncBuckets = new Map();
function flowSyncRateLimit(req, res, next) {
    const key = req.user?.username || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 20;
    let entry = flowSyncBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    flowSyncBuckets.set(key, entry);
    if (flowSyncBuckets.size > 5000) flowSyncBuckets.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please slow down.' });
    }
    next();
}

router.post('/sync/push', authenticateUser, flowSyncRateLimit, handlers.pushFlow);
router.get('/sync/pull/:flowId', authenticateUser, flowSyncRateLimit, handlers.pullFlow);
router.get('/sync/list', authenticateUser, flowSyncRateLimit, handlers.listFlows);
router.get('/sync/shared-with-me', authenticateUser, flowSyncRateLimit, handlers.listSharedWithMe);
router.post('/sync/share', authenticateUser, flowSyncRateLimit, handlers.shareFlow);
router.post('/templates/publish', authenticateUser, flowSyncRateLimit, handlers.publishTemplate);
router.get('/templates/list', authenticateUser, flowSyncRateLimit, handlers.listTemplates);
router.post('/templates/:flowId/review', authenticateUser, flowSyncRateLimit, handlers.reviewTemplate);
router.post('/workspaces', authenticateUser, flowSyncRateLimit, handlers.createWorkspace);
router.post('/workspaces/:id/members', authenticateUser, flowSyncRateLimit, handlers.addMember);
router.get('/workspaces', authenticateUser, flowSyncRateLimit, handlers.listWorkspaces);

module.exports = router;
