// PHASE E — Social chat messages (blueprint E1).
// kind: text | photo | voice | document (document added Phase 1).
// mediaUrl is a server-generated relative path (e.g. /uploads/social/<uuid>.jpg);
// voice notes carry durationSec; documents carry fileName/fileSize.
//
// PHASE 1 (Reliable Messaging Core) — additive fields only:
// - clientMsgId: client-generated idempotency key. Unique per thread
//   (partial unique index below) so a retried send returns the ORIGINAL
//   message instead of creating a duplicate.
// - replyToId: message being quoted (same thread; validated in controller).
// - editedAt / deletedAt: edit marker + soft delete (tombstone; text/media
//   are blanked on delete, the row stays so all clients converge).
// - reactions: one reaction per user per message [{ username, emoji }].
// Delivery/read state is NOT stored per message — it is derived from the
// per-member lastDeliveredAt/lastReadAt maps on ChatThread (see serialize).
const mongoose = require('mongoose');

const ReactionSchema = new mongoose.Schema({
    username: { type: String, required: true },
    emoji: { type: String, required: true, maxlength: 16 }
}, { _id: false });

const SocialChatMessageSchema = new mongoose.Schema({
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread', required: true, index: true },
    senderUsername: { type: String, required: true, index: true },
    kind: { type: String, enum: ['text', 'photo', 'voice', 'document'], required: true },
    text: { type: String, default: '', maxlength: 2000, trim: true },
    mediaUrl: { type: String, default: '' },
    durationSec: { type: Number, default: 0, max: 600 },
    clientMsgId: { type: String, default: null, maxlength: 64 },
    replyToId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialChatMessage', default: null },
    fileName: { type: String, default: '', maxlength: 120 },
    fileSize: { type: Number, default: 0 },
    editedAt: { type: Number, default: null },
    deletedAt: { type: Number, default: null },
    reactions: { type: [ReactionSchema], default: [] },
    createdAt: { type: Number, default: Date.now, index: true }
});

// Thread reads in time order + since= polling.
SocialChatMessageSchema.index({ threadId: 1, createdAt: 1 });

// PHASE 1 dedupe: at most ONE stored message per (thread, clientMsgId).
// Partial: only real string clientMsgIds are indexed, so legacy messages
// (clientMsgId=null) never collide.
SocialChatMessageSchema.index(
    { threadId: 1, clientMsgId: 1 },
    { unique: true, partialFilterExpression: { clientMsgId: { $type: 'string' } } }
);

module.exports = mongoose.models.SocialChatMessage || mongoose.model('SocialChatMessage', SocialChatMessageSchema);
