'use strict';

const express = require('express');
const router = express.Router();
const patchController = require('../controllers/patchController');
const { authenticateUser } = require('../middleware/auth');

// PHASE F — per-user hourly throttle for recipe issuance (~10/hr). Best-effort
// in-memory buckets (same pattern as the login rate limiter); Vercel
// serverless instances each keep their own bucket, which is acceptable for a
// cost-control throttle rather than a security boundary — the credit ledger
// is the authoritative control.
const recipeBuckets = new Map();
function patchRecipeRateLimit(req, res, next) {
    const key = req.user?.username || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const max = 10;
    let entry = recipeBuckets.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    recipeBuckets.set(key, entry);
    if (recipeBuckets.size > 5000) recipeBuckets.clear();
    if (entry.count > max) {
        return res.status(429).json({
            success: false,
            error: 'Too many patch recipe requests. Try again later.'
        });
    }
    next();
}

// Identity always comes from the verified JWT (authenticateUser) — never from
// the body — so one user cannot mint recipes against another's quota.
router.post('/request', authenticateUser, patchRecipeRateLimit, patchController.requestRecipe);
router.post('/apply', authenticateUser, patchController.applyRecipe);

module.exports = router;
