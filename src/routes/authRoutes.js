const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateUser } = require('../middleware/auth');

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

router.post('/register', authController.register);
router.post('/login', loginRateLimit, authController.login);
// SECURITY FIX (#3): /verify requires auth and returns an allowlisted user
// object (no passwordHash / customGeminiKey).
router.get('/verify', authenticateUser, authController.verify);

module.exports = router;
