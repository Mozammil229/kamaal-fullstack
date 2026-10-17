const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');
const { authenticateUser } = require('../middleware/auth');

router.get('/credits', creditController.getCredits);
router.post(['/deduct', '/credits/deduct'], creditController.deductCredit);
// authorize-patch deducts 1 credit atomically server-side: it must be
// JWT-authenticated so nobody can spend (or drain) another user's credits
// by username alone.
router.post('/authorize-patch', authenticateUser, creditController.authorizePatch);
router.post('/redeem', creditController.redeemKey);
router.post('/payment/submit-proof', creditController.submitPaymentProof);

module.exports = router;
