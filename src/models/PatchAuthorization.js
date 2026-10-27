'use strict';

const mongoose = require('mongoose');

// v91 — server-side patch authorization records (BugHunter backend F6).
//
// authorize-patch deducts 1 credit; requestRecipe must now prove the
// deduction happened. authorizePatch creates one single-use record and
// returns its token; requestRecipe atomically consumes it. A client that
// skips /api/authorize-patch can no longer mint recipes for free.
// Rows live 10 minutes (TTL) — the authorize -> recipe round-trip is
// immediate in the app flow.

const patchAuthorizationSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, index: true },
    method: { type: String, default: '' },
    used: { type: Boolean, default: false, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true }
});

patchAuthorizationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PatchAuthorization || mongoose.model('PatchAuthorization', patchAuthorizationSchema);
