const express = require('express');
const router = express.Router();
const configController = require('../controllers/configController');

router.get(['/app/config', '/app-config', '/app/status'], configController.getAppConfig);
router.get('/config/kythera', configController.getKytheraConfig);
router.get('/health', configController.getHealth);

module.exports = router;
