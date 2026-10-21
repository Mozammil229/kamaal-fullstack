const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const crashReportController = require('../controllers/crashReportController');
const { requireAdminAuth } = require('../middleware/auth');

router.post('/login', adminController.adminLogin);
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
router.post('/config/update', adminController.updateConfig);
router.get('/crash-reports', crashReportController.listCrashReports);
router.delete('/crash-reports/:id', crashReportController.deleteCrashReport);
router.delete('/crash-reports', crashReportController.clearCrashReports);

module.exports = router;
