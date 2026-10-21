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
    onlineTool: {
        enabled: true,
        minCredits: 12,
        theme: 'neon-dark',
        customPath: 'online-tool'
    },
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
            onlineTool: conf.onlineTool,
            serverTime: Date.now()
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// App Version Check (GET /api/app/version) — the in-app updater compares
// the installed versionCode against this payload. Contract (Android
// AppVersionResponse, parsed as the BARE body — no success envelope):
// { versionCode, versionName, downloadUrl, forceUpdate, message }.
// Latest shipped release: versionCode 40 / "1.0.39" (2026-10-21). Bump
// LATEST_VERSION_CODE / LATEST_VERSION_NAME when a newer APK ships.
const LATEST_VERSION_CODE = 40;
const LATEST_VERSION_NAME = '1.0.39';

async function getAppVersion(req, res) {
    try {
        const conf = await getActiveConfig();
        return res.json({
            versionCode: LATEST_VERSION_CODE,
            versionName: LATEST_VERSION_NAME,
            downloadUrl: conf?.updateUrl || '',
            forceUpdate: !!conf?.forceUpdate,
            message: conf?.updateNotes || ''
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
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
    getAppVersion,
    getHealth
};
