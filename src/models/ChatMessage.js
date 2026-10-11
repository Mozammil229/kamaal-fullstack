const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
    channel: { type: String, default: 'global', index: true },
    sender: { type: String, required: true },
    recipient: { type: String, default: 'global', index: true },
    text: { type: String, required: true },
    isOwner: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    reactions: { type: Map, of: [String], default: {} },
    timestamp: { type: Number, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.ChatMessage || mongoose.model('ChatMessage', ChatMessageSchema);
