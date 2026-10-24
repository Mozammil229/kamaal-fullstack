const mongoose = require('mongoose');

const AppConfigSchema = new mongoose.Schema({
    key: { type: String, default: 'global_config', unique: true },
    maintenance: {
        enabled: { type: Boolean, default: false },
        message: { type: String, default: 'Kammal App is currently under system maintenance. Please try again soon.' },
        upgradeTitle: { type: String, default: 'System Upgrade in Progress' },
        countdownEnd: { type: Date, default: null },
        allowAdmins: { type: Boolean, default: true }
    },
    minAppVersion: { type: String, default: '1.0.0' },
    latestAppVersion: { type: String, default: '1.0.0' },
    updateUrl: { type: String, default: '' },
    updateNotes: { type: String, default: 'Performance improvements and bug fixes.' },
    forceUpdate: { type: Boolean, default: false },
    featureFlags: {
        voiceAgent: { type: Boolean, default: true },
        enhancer4k: { type: Boolean, default: true },
        communityChat: { type: Boolean, default: true },
        paymentUpload: { type: Boolean, default: true },
        referralSystem: { type: Boolean, default: true },
        geminiChat: { type: Boolean, default: true },
        videoPatching: { type: Boolean, default: true },
        // VOXPILOT PHASE 2 (v58): Live voice master switch, Live tool
        // graft switch, and Always-On (background listening) permission.
        liveVoice: { type: Boolean, default: true },
        liveTools: { type: Boolean, default: true },
        liveAlwaysOn: { type: Boolean, default: true }
    },
    whiteLabel: {
        appName: { type: String, default: 'Kammal App' },
        primaryColor: { type: String, default: '#38BDF8' },
        logoUrl: { type: String, default: '' },
        announcementBanner: { type: String, default: '' },
        supportContact: { type: String, default: '' }
    },
    defaultSignupCredits: { type: Number, default: 2 },
    onlineTool: {
        enabled: { type: Boolean, default: true },
        minCredits: { type: Number, default: 12 },
        theme: { type: String, default: 'neon-dark' },
        customPath: { type: String, default: 'online-tool' }
    },
    systemPrompt: { type: String, default: 'You are Kammal AI, a world-class video optimization, MP4 atom manipulation, and social viral algorithm specialist.' },
    // VOXPILOT PHASE 2 (v58): admin-editable extra instructions locked into
    // Live voice sessions at token-mint time (appended to systemPrompt).
    liveInstructions: { type: String, default: '' },
    currentModel: { type: String, default: 'gemini-2.5-flash' },
    referralReward: { type: Number, default: 10 }
});

module.exports = mongoose.models.AppConfig || mongoose.model('AppConfig', AppConfigSchema);
