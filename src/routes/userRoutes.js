const express = require('express');
const router = express.Router();

// BYOK (Bring Your Own Gemini Key) endpoints were removed on 2026-10-21
// (Backend Safai package): the app no longer ships a BYOK surface, so
// POST/DELETE /user/gemini-key and GET /user/gemini-key/status are gone,
// along with their controller (userKeyController.js, deleted).
// This router is intentionally empty now; it stays mounted in app.js so
// the existing mount remains valid. The User.customGeminiKey schema field
// is deliberately left in place — harmless in already-stored documents.

module.exports = router;
