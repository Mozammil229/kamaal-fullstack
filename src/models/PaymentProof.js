const mongoose = require('mongoose');

const PaymentProofSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    method: { type: String, enum: ['jazzcash', 'easypaisa', 'bank'], default: 'jazzcash' },
    transactionId: { type: String, required: true, unique: true },
    amount: { type: Number, default: 500 },
    requestedPlan: { type: String, default: 'PRO' },
    requestedCredits: { type: Number, default: 1000 },
    screenshotUrl: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    adminNote: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.PaymentProof || mongoose.model('PaymentProof', PaymentProofSchema);
