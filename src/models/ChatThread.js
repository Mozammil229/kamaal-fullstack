// PHASE E — Social messaging core (blueprint E1).
// 1:1 DMs (user<->username, user<->admin) and user-created WhatsApp-style
// groups. Identity is always username-based; every route resolves identity
// from the VERIFIED JWT only (req.user.username) — never from the body.
const mongoose = require('mongoose');

const ChatThreadSchema = new mongoose.Schema({
    type: { type: String, enum: ['dm', 'group'], required: true, index: true },
    // DM identity key: "dm:<lowerA>:<lowerB>" with usernames sorted, so the
    // pair resolves to one thread no matter who created it.
    dmKey: { type: String, default: null, index: true },
    memberUsernames: [{ type: String, index: true }],
    groupName: { type: String, default: '', maxlength: 80, trim: true },
    groupAdminUsernames: [{ type: String }],
    lastMessageAt: { type: Number, default: Date.now, index: true },
    createdAt: { type: Number, default: Date.now }
});

// One DM thread per username pair.
ChatThreadSchema.index({ dmKey: 1 }, { unique: true, partialFilterExpression: { dmKey: { $ne: null } } });
ChatThreadSchema.index({ memberUsernames: 1, lastMessageAt: -1 });

module.exports = mongoose.models.ChatThread || mongoose.model('ChatThread', ChatThreadSchema);
