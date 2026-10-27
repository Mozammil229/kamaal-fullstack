const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// v91 (BugHunter backend F27): registration was unthrottled — mass account
// creation for referral farming / quota abuse. 5 registrations/min per IP.
const registerRateLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Too many registrations. Try again in a minute.' });

// SECURITY FIX (#9): simple per-IP login throttle (best-effort in-memory;
// Vercel serverless instances each keep their own bucket).
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
    const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const max = 10;
    let entry = loginAttempts.get(key);
    if (!entry || now - entry.start > windowMs) entry = { start: now, count: 0 };
    entry.count += 1;
    loginAttempts.set(key, entry);
    if (loginAttempts.size > 2000) loginAttempts.clear();
    if (entry.count > max) {
        return res.status(429).json({ success: false, error: 'Too many login attempts. Try again in a minute.' });
    }
    next();
}

router.post('/register', registerRateLimit, authController.register);
router.post('/login', loginRateLimit, authController.login);
// v91 (BugHunter frontback F7): the app never called logout — the token
// stayed valid after the user "logged out". The app now calls this on logout.
router.post('/logout', authenticateUser, authController.userLogout);
// PHASE F — transport encryption: public RSA key for opportunistic
// password encryption (public route; needed pre-login).
router.get('/pubkey', authController.serverPubkey);
// SECURITY FIX (#3): /verify requires auth and returns an allowlisted user
// object (no passwordHash / customGeminiKey).
router.get('/verify', authenticateUser, authController.verify);

module.exports = router;
module.exports.loginRateLimit = loginRateLimit;
