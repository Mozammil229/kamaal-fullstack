const express = require('express');
const router = express.Router();
const userKeyController = require('../controllers/userKeyController');
const { authenticateUser } = require('../middleware/auth');

// BYOK: Bring Your Own (Gemini) Key
// All routes require a valid user JWT; the username is taken from the
// verified token (req.user), never from client-supplied params.
router.post('/user/gemini-key', authenticateUser, userKeyController.saveGeminiKey);
router.delete('/user/gemini-key', authenticateUser, userKeyController.deleteGeminiKey);
router.get('/user/gemini-key/status', authenticateUser, userKeyController.geminiKeyStatus);

module.exports = router;
