const express = require('express');
const router = express.Router();
const crashReportController = require('../controllers/crashReportController');
const { authenticateUser } = require('../middleware/auth');

// POST /api/crash-reports — app one-tap crash report send.
// Username is taken ONLY from the verified JWT (never the request body).
router.post('/crash-reports', authenticateUser, crashReportController.submitCrashReport);

module.exports = router;
