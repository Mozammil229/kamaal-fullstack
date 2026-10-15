const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

router.post('/chat', aiController.chat);
// Alias used by some Android client builds (ApiService.chatWithAi)
router.post('/ai/chat', aiController.chat);
router.get('/ai/system-prompt', aiController.getSystemPrompt);

module.exports = router;
