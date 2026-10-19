// ============================================================================
// PHASE D — Referral: one row per successful referral application.
// FRAUD GUARD: referredKamalId is UNIQUE — a single Kamal ID (device) can
// only ever consume one referral code, so reinstalling or re-registering on
// the same device cannot farm the 20+20 reward twice.
// ============================================================================
const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema({
    // The deterministic code that was consumed, e.g. "KML-A1B2C3".
    code: { type: String, required: true, index: true },
    // Who invited (the code owner).
    referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referrerUsername: { type: String, default: '' },
    // Who was invited (the newcomer who applied the code).
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    referredUsername: { type: String, default: '' },
    // Kamal ID (masked display ID) of the invited device — UNIQUE, one per device.
    referredKamalId: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'applied'], default: 'applied', index: true },
    // Total credits awarded by this row (20 referrer + 20 referred = 40).
    creditsAwarded: { type: Number, default: 40 },
    createdAt: { type: Date, default: Date.now, index: true }
});

// Explicit declaration so the intent is visible even before first insert.
ReferralSchema.index({ referredKamalId: 1 }, { unique: true });

module.exports = mongoose.models.Referral || mongoose.model('Referral', ReferralSchema);
