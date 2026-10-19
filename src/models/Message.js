// PHASE C — Admin messaging (blueprint §6/§7).
// conversationId == null  =>  broadcast (stored once, fanned out on read:
// a user's inbox merges their 1-to-1 thread plus broadcasts after their join date).
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conversation',
        default: null,
        index: true
    },
    sender: {
        type: String,
        enum: ['USER', 'ADMIN', 'BROADCAST'],
        required: true,
        index: true
    },
    body: { type: String, required: true, maxlength: 2000, trim: true },
    createdAt: { type: Number, default: Date.now, index: true },
    readAt: { type: Number, default: null }
});

// Thread reads: one user's messages in time order.
MessageSchema.index({ conversationId: 1, createdAt: 1 });
// Broadcast reads: all broadcasts after a join date / since a timestamp.
MessageSchema.index({ createdAt: 1 });

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);
