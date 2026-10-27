const mongoose = require('mongoose');

const SupportMessageSchema = new mongoose.Schema({
    sender: { type: String, required: true, index: true },
    deviceId: { type: String, default: '', index: true },
    // v91 (BugHunter backend F5): admin DMs are addressed to a USERNAME, not a
    // device — the old code misused deviceId to store the recipient username,
    // which made every admin message globally readable. New rows use this.
    recipientUsername: { type: String, default: '', index: true },
    // v91: global admin broadcasts (visible to every user by design).
    broadcast: { type: Boolean, default: false },
    message: { type: String, required: true },
    isAdmin: { type: Boolean, default: false, index: true },
    timestamp: { type: Number, default: Date.now }
});

// v91 (BugHunter DB P1-16): getSupportMessages filters on sender /
// recipientUsername / broadcast / deviceId and sorts by timestamp desc.
SupportMessageSchema.index({ sender: 1, timestamp: -1 });
SupportMessageSchema.index({ recipientUsername: 1, timestamp: -1 });

module.exports = mongoose.models.SupportMessage || mongoose.model('SupportMessage', SupportMessageSchema);
