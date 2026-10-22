// PHASE E — Social app routes (blueprint E1/E2/E3/E5).
// Mounted at /api/social (auth-only user endpoints; identity from the
// VERIFIED JWT on every route, never from client fields):
//   GET    /api/social/threads
//   POST   /api/social/threads            { dm: { username } } | { group: { name, memberUsernames[] } }
//   GET    /api/social/threads/:id/messages?since=
//   POST   /api/social/threads/:id/messages   (multipart: kind, text?, durationSec?, file)
//   POST   /api/social/groups/:id/members     { action: 'add'|'remove', usernames: [] } (group admins)
//   GET    /api/social/feed
//   POST   /api/social/feed               (multipart: text?, file?)
//   POST   /api/social/stories            (multipart: file)
//   GET    /api/social/stories/feed
//   GET    /api/social/contacts
//   POST   /api/social/contacts           { contactUsername, customName?, label? }
//   PUT    /api/social/contacts/:id       { customName?, label? }
//   POST   /api/user/fcm-token            { fcmToken } (E5: store only)
// Uploads are magic-byte validated + re-encoded by socialUpload (E4).
const express = require('express');
const router = express.Router();
const socialController = require('../controllers/socialController');
const { authenticateUser } = require('../middleware/auth');
const { upload } = require('../middleware/socialUpload');

router.use(authenticateUser);

// threads
router.get('/social/threads', socialController.listThreads);
router.post('/social/threads', socialController.createThread);
router.get('/social/threads/:id/messages', socialController.getMessages);
router.post('/social/threads/:id/messages', upload.single('file'), socialController.sendMessage);
// PHASE 1 — reliable messaging core: read state, actions, search.
router.post('/social/threads/:id/read', socialController.markThreadRead);
router.put('/social/threads/:id/messages/:messageId', socialController.editMessage);
router.delete('/social/threads/:id/messages/:messageId', socialController.deleteMessage);
router.put('/social/threads/:id/messages/:messageId/reaction', socialController.reactMessage);
router.get('/social/threads/:id/search', socialController.searchInThread);
router.get('/social/search', socialController.searchGlobal);

// groups
router.post('/social/groups/:id/members', socialController.updateGroupMembers);

// feed + stories
router.get('/social/feed', socialController.getFeed);
router.post('/social/feed', upload.single('file'), socialController.createPost);
router.post('/social/stories', upload.single('file'), socialController.createStory);
router.get('/social/stories/feed', socialController.getStoriesFeed);

// contacts
router.get('/social/contacts', socialController.listContacts);
router.post('/social/contacts', socialController.addContact);
router.put('/social/contacts/:id', socialController.updateContact);

// fcm token (E5 — store only, FCM send is a later phase)
router.post('/user/fcm-token', socialController.saveFcmToken);

module.exports = router;
