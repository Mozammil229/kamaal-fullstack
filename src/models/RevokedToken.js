const mongoose = require('mongoose');

const RevokedTokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    reason: { type: String, default: 'logout' },
    createdAt: { type: Date, default: Date.now, expires: '24h' } // Auto-prune by MongoDB TTL after 24 hours
});

module.exports = mongoose.models.RevokedToken || mongoose.model('RevokedToken', RevokedTokenSchema);
