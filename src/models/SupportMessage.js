const mongoose = require('mongoose');

const SupportMessageSchema = new mongoose.Schema({
    sender: { type: String, required: true, index: true },
    deviceId: { type: String, default: '', index: true },
    message: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    timestamp: { type: Number, default: Date.now }
});

module.exports = mongoose.models.SupportMessage || mongoose.model('SupportMessage', SupportMessageSchema);
