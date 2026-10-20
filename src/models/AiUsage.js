const mongoose = require('mongoose');

// DAILY FREE-AI TIME BUDGET (user order 2026-10-20): AI conversation costs
// NO credits, but FREE-tier users get 20 minutes/day of ONLINE AI usage
// (text chat + online voice turns share one pool). One document per
// (username, PKT calendar day). PAID/PRO are unlimited and never tracked
// against a cap (rows may still be written by usage reports, but
// `remainingSeconds` is always reported as unlimited for them).
const AiUsageSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    // Masked Kamal ID of the user at report time (display/audit only).
    kamalId: { type: String, default: '' },
    // Calendar day in Asia/Karachi, format YYYY-MM-DD. The daily pool
    // resets at midnight PKT because a new day = a new document.
    date: { type: String, required: true },
    secondsUsed: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
});

AiUsageSchema.index({ username: 1, date: 1 }, { unique: true });

module.exports = mongoose.models.AiUsage || mongoose.model('AiUsage', AiUsageSchema);
