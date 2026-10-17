const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    // SECURITY: never returned by default — must be explicitly selected.
    passwordHash: { type: String, required: true, select: false },
    token: { type: String, default: '' },
    deviceId: { type: String, default: '', index: true },
    credits: { type: Number, default: 2 },
    isPro: { type: Boolean, default: false },
    proPlan: { type: String, enum: ['none', 'trial', 'monthly', 'yearly', 'lifetime'], default: 'trial' },
    planExpiry: { type: String, default: 'Lifetime' },
    planExpiryDate: { type: Date, default: null },
    tier: { type: String, default: 'FREE' },
    status: { type: String, enum: ['active', 'banned'], default: 'active' },
    banReason: { type: String, default: '' },
    role: { type: String, enum: ['user', 'admin', 'reseller', 'vip'], default: 'user' },
    referralCode: { type: String, default: '' },
    referredBy: { type: String, default: '' },
    customPrompt: { type: String, default: '' },
    // SECURITY: the user's private Gemini key — never returned by default.
    customGeminiKey: { type: String, default: '', select: false },
    socialLinks: {
        tiktok: { type: String, default: '' },
        instagram: { type: String, default: '' },
        youtube: { type: String, default: '' },
        bio: { type: String, default: '' }
    },
    stats: {
        videosPatched: { type: Number, default: 0 },
        videosEnhanced4K: { type: Number, default: 0 },
        totalBandwidthBytes: { type: Number, default: 0 }
    },
    lastActiveAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
