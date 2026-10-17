const express = require('express');
const router = express.Router();
const userKeyController = require('../controllers/userKeyController');

// BYOK: Bring Your Own (Gemini) Key
router.post('/user/gemini-key', userKeyController.saveGeminiKey);
router.delete('/user/gemini-key', userKeyController.deleteGeminiKey);
router.get('/user/gemini-key/status', userKeyController.geminiKeyStatus);

module.exports = router;
