const AppConfig = require('../models/AppConfig');
const { connectToDatabase, isDbConnected } = require('../config/db');

// In-memory fallback config when MongoDB is offline
let localConfig = {
    key: 'global_config',
    maintenance: {
        enabled: false,
        message: 'Kammal App is currently under system maintenance. Please try again soon.',
        upgradeTitle: 'System Upgrade in Progress',
        countdownEnd: null,
        allowAdmins: true
    },
    minAppVersion: '1.0.0',
    latestAppVersion: '1.0.0',
    updateUrl: '',
    updateNotes: 'Performance improvements and bug fixes.',
    forceUpdate: false,
    featureFlags: {
        voiceAgent: true,
        enhancer4k: true,
        communityChat: true,
        paymentUpload: true,
        referralSystem: true,
        geminiChat: true,
        videoPatching: true
    },
    whiteLabel: {
        appName: 'Kammal App',
        primaryColor: '#38BDF8',
        logoUrl: '',
        announcementBanner: '',
        supportContact: ''
    },
    defaultSignupCredits: 2,
    systemPrompt: 'You are Kammal AI, a world-class video optimization specialist.',
    currentModel: 'gemini-2.5-flash',
    referralReward: 10
};

async function getActiveConfig() {
    await connectToDatabase();
    if (isDbConnected()) {
        let conf = await AppConfig.findOne({ key: 'global_config' });
        if (!conf) {
            conf = await AppConfig.create(localConfig);
        }
        return conf;
    }
    return localConfig;
}

// App Remote Config Endpoint (/api/app/config, /api/app-config, /api/app/status)
async function getAppConfig(req, res) {
    try {
        const conf = await getActiveConfig();
        return res.json({
            success: true,
            maintenance: conf.maintenance,
            minAppVersion: conf.minAppVersion,
            latestAppVersion: conf.latestAppVersion,
            forceUpdate: conf.forceUpdate,
            updateUrl: conf.updateUrl,
            updateNotes: conf.updateNotes,
            featureFlags: conf.featureFlags,
            whiteLabel: conf.whiteLabel,
            serverTime: Date.now()
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Kythera Video Engine Remote Config Endpoint (/api/config/kythera)
function getKytheraConfig(req, res) {
    return res.json({
        status: 'ACTIVE',
        statusMessage: 'Kammal Kythera Atom Engine • Ready',
        convCrfExtra: '-bf 0',
        convAudio: '-c:a aac -b:a 192k',
        convGlobal: '-movflags +faststart',
        compAudioCompress: '-c:a aac -b:a 128k',
        compAudioCopy: '-c:a copy',
        compMeta: '-map_metadata -1',
        aiScale: '4',
        aiCpuArgs: '-g -1',
        lastSyncTimeMs: Date.now()
    });
}

// Health Check (/api/health)
async function getHealth(req, res) {
    const { isDbConnected } = require('../config/db');
    return res.json({
        status: 'OK',
        version: '2.0.0',
        database: isDbConnected() ? 'Connected (MongoDB Atlas)' : 'Disconnected / Standby',
        timestamp: Date.now()
    });
}

module.exports = {
    getActiveConfig,
    getAppConfig,
    getKytheraConfig,
    getHealth
};
