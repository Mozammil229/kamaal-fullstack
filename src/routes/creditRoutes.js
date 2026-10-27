const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { authenticateUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// v91 (BugHunter backend F27): money-adjacent endpoints were unthrottled —
// redeem/deduct/payment-proof could be hammered in a loop. Per-user buckets.
const redeemRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many voucher attempts. Try again in a minute.' });
const deductRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many requests. Try again in a minute.' });
const proofRateLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Too many payment proofs. Try again in a minute.' });

// SECURITY FIX: every credit route requires a valid user JWT. Usernames are
// taken from the verified token (req.user.username), never from body/query —
// otherwise anyone could read, spend, or drain another user's credits.
// authorize-patch deducts 1 credit atomically server-side: it must be
// JWT-authenticated so nobody can spend (or drain) another user's credits
// by username alone.
router.get('/credits', authenticateUser, creditController.getCredits);
router.post(['/deduct', '/credits/deduct'], authenticateUser, deductRateLimit, creditController.deductCredit);
router.post('/authorize-patch', authenticateUser, creditController.authorizePatch);
router.post('/redeem', authenticateUser, redeemRateLimit, creditController.redeemKey);
router.post('/payment/submit-proof', authenticateUser, proofRateLimit, creditController.submitPaymentProof);

module.exports = router;
