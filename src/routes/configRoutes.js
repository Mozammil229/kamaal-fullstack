const express = require('express');
const router = express.Router();
const configController = require('../controllers/configController');

router.get(['/app/config', '/app-config', '/app/status'], configController.getAppConfig);
router.get('/app/version', configController.getAppVersion);
router.get('/health', configController.getHealth);

module.exports = router;
