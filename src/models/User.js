const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    phone: { type: String, default: '', index: true },
    // PHASE B — Kamal ID (masked display ID, safe to show) + language pref.
    displayKamalId: { type: String, default: '' },
    preferredLanguage: { type: String, enum: ['en', 'ur', 'pa'], default: 'en' },
    // SECURITY: never returned by default — must be explicitly selected.
    passwordHash: { type: String, required: true, select: false },
    token: { type: String, default: '' },
    deviceId: { type: String, default: '', index: true },
    credits: { type: Number, default: 2 },
    // PHASE E — lifetime credits earned (drives TAG/LEVEL badges via
    // socialTagService.computeSocialTag); `tag` is a persisted convenience
    // recomputed on every credit grant. fcmToken is stored only (E5).
    creditsEarned: { type: Number, default: 0 },
    tag: { type: String, default: 'Desi Tadka' },
    fcmToken: { type: String, default: '', select: false },
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

// PHASE B — phone uniqueness that does not break existing rows: the partial
// unique index only applies to documents carrying a real phone number, so
// legacy '' values never collide.
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $ne: '' } } });

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
