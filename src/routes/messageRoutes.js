// PHASE C — Admin messaging routes (blueprint §6/§7).
// Mounted at /api (existing /api/* convention):
//   GET  /api/messages                      (user JWT)
//   POST /api/messages                      (user JWT, 30/hr rate limit)
//   POST /api/translate                     (user JWT)
//   GET  /api/admin/messages/users/search   (admin JWT)
//   GET  /api/admin/messages/:userId        (admin JWT)
//   POST /api/admin/messages/:userId        (admin JWT)
//   POST /api/admin/broadcast/preview       (admin JWT)
//   POST /api/admin/broadcast               (admin JWT)
const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const { authenticateUser, requireAdminAuth } = require('../middleware/auth');

// ---- user endpoints (identity from verified JWT only) ----
router.get('/messages', authenticateUser, messageController.getInbox);
router.post('/messages', authenticateUser, messageController.sendMessage);
router.post('/translate', authenticateUser, messageController.translateText);

// ---- admin endpoints (admin JWT / ADMIN_PASS) ----
// NOTE: /users/search is registered BEFORE /:userId so Express does not
// treat "search" as a userId param.
router.get('/admin/messages/users/search', requireAdminAuth, messageController.adminSearchUsers);
router.get('/admin/messages/:userId', requireAdminAuth, messageController.adminGetThread);
router.post('/admin/messages/:userId', requireAdminAuth, messageController.adminSendMessage);
router.post('/admin/broadcast/preview', requireAdminAuth, messageController.adminBroadcastPreview);
router.post('/admin/broadcast', requireAdminAuth, messageController.adminBroadcast);

module.exports = router;
