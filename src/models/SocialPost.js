// PHASE E — Feed posts (blueprint E3).
// Posts = text + optional single photo (server re-encodes + strips metadata).
// NO VIDEO in this phase.
const mongoose = require('mongoose');

const SocialPostSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    text: { type: String, default: '', maxlength: 1000, trim: true },
    photoUrl: { type: String, default: '' },
    createdAt: { type: Number, default: Date.now, index: true }
});

module.exports = mongoose.models.SocialPost || mongoose.model('SocialPost', SocialPostSchema);
