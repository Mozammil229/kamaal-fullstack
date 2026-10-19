// PHASE C — Admin messaging (blueprint §6/§7).
// One support thread per user. The thread document itself; the actual
// messages live in the Message collection keyed by conversationId.
const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    lastMessageAt: { type: Number, default: Date.now, index: true },
    adminUnread: { type: Number, default: 0 }, // user -> admin messages not yet seen by admin
    userUnread: { type: Number, default: 0 }    // admin/broadcast -> user messages not yet seen by user
}, { timestamps: false });

ConversationSchema.index({ lastMessageAt: -1 });

module.exports = mongoose.models.Conversation || mongoose.model('Conversation', ConversationSchema);
