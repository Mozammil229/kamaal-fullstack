const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
    channel: { type: String, default: 'global', index: true },
    sender: { type: String, required: true },
    recipient: { type: String, default: 'global', index: true },
    text: { type: String, required: true },
    isOwner: { type: Boolean, default: false },
    pinned: { type: Boolean, default: false },
    reactions: { type: Map, of: [String], default: {} },
    timestamp: { type: Number, default: Date.now, index: true },
    createdAt: { type: Date, default: Date.now }
});

// v91 (BugHunter DB P1-16): getChatMessages sorts by createdAt within a
// channel — the channel+timestamp compound keeps that scan indexed.
ChatMessageSchema.index({ channel: 1, timestamp: -1 });

module.exports = mongoose.models.ChatMessage || mongoose.model('ChatMessage', ChatMessageSchema);
