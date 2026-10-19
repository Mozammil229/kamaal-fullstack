// ============================================================================
// PHASE D — Referral routes. Mounted at /api/referral (see src/app.js).
// Both endpoints require the user JWT (authenticateUser); identity always
// comes from the VERIFIED token, never from client-supplied fields.
// ============================================================================
const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/auth');
const { applyReferral, myReferrals } = require('../controllers/referralController');

router.post('/apply', authenticateUser, applyReferral);
router.get('/my', authenticateUser, myReferrals);

module.exports = router;
