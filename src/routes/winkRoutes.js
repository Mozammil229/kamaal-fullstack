'use strict';
// v66 — Wink AI video enhancer routes. Stateless JSON proxy only; the
// server never receives video bytes. All endpoints JWT-gated.
const express = require('express');
const router = express.Router();
const winkController = require('../controllers/winkController');
const { authenticateUser } = require('../middleware/auth');

// Job start (rate-limited): fresh gnum + maat sign.
router.post('/wink/sign', authenticateUser, winkController.startLimit, winkController.sign);
// Qiniu upload policy for a sign.
router.post('/wink/policy', authenticateUser, winkController.startLimit, winkController.policy);
// Video info after the app's direct Qiniu upload.
router.post('/wink/video-info', authenticateUser, winkController.startLimit, winkController.videoInfo);
// Transcode start + poll (poll endpoints get the higher poll limit).
router.post('/wink/transcode/start', authenticateUser, winkController.startLimit, winkController.transcodeStart);
router.get('/wink/transcode/status', authenticateUser, winkController.pollLimit, winkController.transcodeStatus);
// Delivery (enhance task) + result poll.
router.post('/wink/delivery', authenticateUser, winkController.startLimit, winkController.delivery);
router.get('/wink/result', authenticateUser, winkController.pollLimit, winkController.result);

module.exports = router;
