const mongoose = require('mongoose');

const RedeemKeySchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true, index: true },
    credits: { type: Number, default: 100 },
    plan: { type: String, default: 'PRO' },
    isPro: { type: Boolean, default: true },
    isUsed: { type: Boolean, default: false },
    usedBy: { type: String, default: '' },
    usedAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.RedeemKey || mongoose.model('RedeemKey', RedeemKeySchema);
