// PHASE E — Contacts with custom names/labels (blueprint E3).
// One row per (owner, contact) pair; customName + label (friend/family/…)
// are the owner's private view of the contact.
const mongoose = require('mongoose');

const SocialContactSchema = new mongoose.Schema({
    ownerUsername: { type: String, required: true, index: true },
    contactUsername: { type: String, required: true, index: true },
    customName: { type: String, default: '', maxlength: 60, trim: true },
    label: { type: String, default: '', maxlength: 30, trim: true },
    createdAt: { type: Number, default: Date.now }
});

SocialContactSchema.index({ ownerUsername: 1, contactUsername: 1 }, { unique: true });

module.exports = mongoose.models.SocialContact || mongoose.model('SocialContact', SocialContactSchema);
