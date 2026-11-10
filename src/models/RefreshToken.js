'use strict';

// 4D (PWA cookie auth) — rotating refresh tokens.
//
// One row per issued refresh token. Only the SHA-256 hash of the opaque
// token is ever stored (a DB leak must not yield usable tokens). Rotation
// is tracked per family: when a token is rotated its row is marked revoked
// with replacedByHash pointing at the new token's hash; presenting an
// already-replaced token is reuse and revokes the WHOLE family.
//
// D-08 (device binding) is PENDING — this model stores NO fingerprint, NO
// IP and NO user-agent, on purpose. Do not add them here without a ruling.

const mongoose = require('mongoose');

const RefreshTokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    createdAt: { type: Date, default: Date.now }
});

// Auto-prune expired rows. Expired rows are useless for reuse detection
// (an expired token answers 401 either way), so the TTL cannot weaken it.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RefreshToken || mongoose.model('RefreshToken', RefreshTokenSchema);
