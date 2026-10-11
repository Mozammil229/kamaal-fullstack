const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    type: {
        type: String,
        enum: ['admin_grant', 'admin_deduct', 'voucher_redeem', 'payment_approval', 'usage_deduct', 'referral_bonus'],
        default: 'admin_grant'
    },
    creditsChange: { type: Number, required: true },
    newBalance: { type: Number, default: 0 },
    plan: { type: String, default: '' },
    planExpiry: { type: String, default: '' },
    description: { type: String, default: '' },
    adminUser: { type: String, default: '👑 Master Admin' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);
