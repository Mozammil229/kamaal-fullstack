const mongoose = require('mongoose');

const RevokedTokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: 'logout' },
    // v91 (BugHunter DB P1-10): user JWTs live 30 days but revocations expired
    // after 24h — a logged-out token became valid again for ~29 days. TTL now
    // matches the longest JWT lifetime (30d). Admin JWTs are 24h, still covered.
    createdAt: { type: Date, default: Date.now, expires: '30d' } // Auto-prune by MongoDB TTL after 30 days
});

module.exports = mongoose.models.RevokedToken || mongoose.model('RevokedToken', RevokedTokenSchema);
