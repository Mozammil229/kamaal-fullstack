const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateUser } = require('../middleware/auth');

// SECURITY FIX: chat + poll routes require a valid user JWT. Usernames come
// from the verified token inside the controllers — never from body/query —
// so nobody can impersonate another user, read their DMs, or stuff ballots.
router.get('/chat/messages', authenticateUser, chatController.getChatMessages);
router.post('/chat/send', authenticateUser, chatController.sendChatMessage);
router.post('/chat/react', chatController.reactChatMessage);

router.get('/support/messages', chatController.getSupportMessages);
router.post('/support/send', chatController.sendSupportMessage);

router.get('/polls/active', chatController.getActivePoll);
router.post('/polls/vote', authenticateUser, chatController.votePoll);

module.exports = router;
