const mongoose = require('mongoose');

// Kamaal API key — access token issued to an outsider for POST /api/v1/chat.
// The token itself is kml_ + 24 random chars; ONLY its SHA-256 hash is
// stored (tokenHash), exactly like a password — the plaintext is never
// needed again after issuance and is shown to the admin ONCE at creation.
// Display after creation is last4 only (****aB3d).
//
// ownerUsername is the ATTACH target: the key is usable only while attached
// to a real user (credits are checked + deducted from that user). Empty
// ownerUsername = unattached = rejected by /api/v1/chat (403).
// tier selects the Gemini model on the call: basic -> gemini-3.5-flash-lite,
// advance -> gemini-3.6-flash. Credit price is 1/call for both tiers
// (standing 1-credit rule; tier pricing is an open owner decision).

const KamaalApiKeySchema = new mongoose.Schema({
    publicId: { type: String, required: true, unique: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    ownerUsername: { type: String, default: '', index: true },
    tier: { type: String, enum: ['basic', 'advance'], default: 'basic' },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    callsUsed: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null }
});

module.exports = mongoose.models.KamaalApiKey || mongoose.model('KamaalApiKey', KamaalApiKeySchema);
