const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateUser } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// 4D (W2, §4.8 rule 8): chat send 30/min/user, support send 10/min/user
// (both were unthrottled; shared middleware so 429s carry Retry-After).
const chatSendRateLimit = rateLimit({ windowMs: 60 * 1000, max: 30, message: 'Too many chat messages. Try again in a minute.' });
const supportSendRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many support messages. Try again in a minute.' });

// SECURITY FIX: chat + poll routes require a valid user JWT. Usernames come
// from the verified token inside the controllers — never from body/query —
// so nobody can impersonate another user, read their DMs, or stuff ballots.
router.get('/chat/messages', authenticateUser, chatController.getChatMessages);
router.post('/chat/send', authenticateUser, chatSendRateLimit, chatController.sendChatMessage);
router.post('/chat/react', authenticateUser, chatController.reactChatMessage);

router.get('/support/messages', authenticateUser, chatController.getSupportMessages);
router.post('/support/send', authenticateUser, supportSendRateLimit, chatController.sendSupportMessage);

router.get('/polls/active', chatController.getActivePoll);
router.post('/polls/vote', authenticateUser, chatController.votePoll);

module.exports = router;
