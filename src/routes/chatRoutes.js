const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');

router.get('/chat/messages', chatController.getChatMessages);
router.post('/chat/send', chatController.sendChatMessage);
router.post('/chat/react', chatController.reactChatMessage);

router.get('/support/messages', chatController.getSupportMessages);
router.post('/support/send', chatController.sendSupportMessage);

router.get('/polls/active', chatController.getActivePoll);
router.post('/polls/vote', chatController.votePoll);

module.exports = router;
