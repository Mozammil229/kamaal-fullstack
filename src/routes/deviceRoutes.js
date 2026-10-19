const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');

// PHASE B — Kamal ID device identity. Mounted at /api/device in app.js
// (matches the existing /api/* convention — no /v1 prefix).
router.post('/register', deviceController.registerDevice);
router.post('/resolve', deviceController.resolveDevice);

module.exports = router;
