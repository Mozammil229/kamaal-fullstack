const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { authenticateUser } = require('../middleware/auth');

// SECURITY FIX: every credit route requires a valid user JWT. Usernames are
// taken from the verified token (req.user.username), never from body/query —
// otherwise anyone could read, spend, or drain another user's credits.
// authorize-patch deducts 1 credit atomically server-side: it must be
// JWT-authenticated so nobody can spend (or drain) another user's credits
// by username alone.
router.get('/credits', authenticateUser, creditController.getCredits);
router.post(['/deduct', '/credits/deduct'], authenticateUser, creditController.deductCredit);
router.post('/authorize-patch', authenticateUser, creditController.authorizePatch);
router.post('/redeem', authenticateUser, creditController.redeemKey);
router.post('/payment/submit-proof', authenticateUser, creditController.submitPaymentProof);

module.exports = router;
