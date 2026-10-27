// ============================================================================
// PHASE D — Referral routes. Mounted at /api/referral (see src/app.js).
// Both endpoints require the user JWT (authenticateUser); identity always
// comes from the VERIFIED token, never from client-supplied fields.
// ============================================================================
const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { applyReferral, myReferrals } = require('../controllers/referralController');

// v91 (BugHunter backend F27): referral-apply was unthrottled — code
// guessing in a loop. 5 attempts/min per user.
const applyRateLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Too many referral attempts. Try again in a minute.' });

router.post('/apply', authenticateUser, applyRateLimit, applyReferral);
router.get('/my', authenticateUser, myReferrals);

module.exports = router;
