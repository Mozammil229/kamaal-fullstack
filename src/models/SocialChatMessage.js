// PHASE E — Social chat messages (blueprint E1).
// kind: text | photo | voice. mediaUrl is a server-generated relative path
// (e.g. /uploads/social/<uuid>.jpg); voice notes carry durationSec.
const mongoose = require('mongoose');

const SocialChatMessageSchema = new mongoose.Schema({
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread', required: true, index: true },
    senderUsername: { type: String, required: true, index: true },
    kind: { type: String, enum: ['text', 'photo', 'voice'], required: true },
    text: { type: String, default: '', maxlength: 2000, trim: true },
    mediaUrl: { type: String, default: '' },
    durationSec: { type: Number, default: 0, max: 600 },
    createdAt: { type: Number, default: Date.now, index: true }
});

// Thread reads in time order + since= polling.
SocialChatMessageSchema.index({ threadId: 1, createdAt: 1 });

module.exports = mongoose.models.SocialChatMessage || mongoose.model('SocialChatMessage', SocialChatMessageSchema);
