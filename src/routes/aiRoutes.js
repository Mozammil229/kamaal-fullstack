const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

router.post('/chat', aiController.chat);
router.get('/ai/system-prompt', aiController.getSystemPrompt);

module.exports = router;
