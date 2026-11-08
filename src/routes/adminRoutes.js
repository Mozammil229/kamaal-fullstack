const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const crashReportController = require('../controllers/crashReportController');
const { requireAdminAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// v91 (BugHunter backend F27): the admin login was unthrottled — password
// guessing in a loop against the single owner password. 10/min per IP.
const adminLoginRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many admin login attempts. Try again in a minute.' });

router.post('/login', adminLoginRateLimit, adminController.adminLogin);
router.post('/logout', adminController.adminLogout);

// Protected Admin Endpoints
router.use(requireAdminAuth);
router.get('/telemetry', adminController.getTelemetry);
router.get('/users', adminController.getUsers);
router.post('/user/update', adminController.updateUser);
router.get('/transactions', adminController.getTransactions);
router.post('/chat/broadcast', adminController.broadcast);
router.post('/chat/send-direct', adminController.sendDirectMessage);
router.get('/payments/list', adminController.listPayments);
router.post('/payments/review', adminController.reviewPayment);
router.get('/keys/list', adminController.listKeys);
router.post('/keys/create', adminController.createKeys);
// KAMAAL API KEYS (2026-11-05) — provider pools + kml_ access tokens.
// Separate namespace from the REDEEM voucher /keys/* above; do not merge.
const apikeyAdminController = require('../controllers/apikeyAdminController');
router.get('/apikeys/providers', apikeyAdminController.getProviders);
router.post('/apikeys/provider-key', apikeyAdminController.addProviderKey);
router.post('/apikeys/provider-key/revoke', apikeyAdminController.revokeProviderKey);
router.post('/apikeys/kamaal-key', apikeyAdminController.createKamaalKey);
router.get('/apikeys/kamaal-keys', apikeyAdminController.listKamaalKeys);
router.post('/apikeys/kamaal-key/attach', apikeyAdminController.attachKamaalKey);
router.post('/apikeys/kamaal-key/revoke', apikeyAdminController.revokeKamaalKey);
// PANEL-STORED ENCRYPTION KEY (2026-11-08) — set inside this admin panel,
// not in the Vercel dashboard. The key value is never returned or logged.
router.get('/apikeys/encryption-key/status', apikeyAdminController.getEncryptionKeyStatus);
router.post('/apikeys/encryption-key', apikeyAdminController.setEncryptionKey);
router.post('/config/update', adminController.updateConfig);
router.get('/crash-reports', crashReportController.listCrashReports);
router.delete('/crash-reports/:id', crashReportController.deleteCrashReport);
router.delete('/crash-reports', crashReportController.clearCrashReports);

module.exports = router;
