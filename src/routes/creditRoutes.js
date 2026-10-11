const express = require('express');
const router = express.Router();
const creditController = require('../controllers/creditController');

router.get('/credits', creditController.getCredits);
router.post(['/deduct', '/credits/deduct'], creditController.deductCredit);
router.post('/authorize-patch', creditController.authorizePatch);
router.post('/redeem', creditController.redeemKey);
router.post('/payment/submit-proof', creditController.submitPaymentProof);

module.exports = router;
