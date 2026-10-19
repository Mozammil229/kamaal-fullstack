const express = require('express');
const router = express.Router();
const onlineToolController = require('../controllers/onlineToolController');
const { authenticateUser } = require('../middleware/auth');

// POST /api/online-tool/token — auth + credits gate, issues a 5-min single-use token.
router.post('/online-tool/token', authenticateUser, onlineToolController.issueToken);

module.exports = router;
