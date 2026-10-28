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
        videoPatching: true,
        // VOXPILOT PHASE 2 (v58) parity with the AppConfig schema.
        liveVoice: true,
        liveTools: true,
        liveAlwaysOn: true
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
    // v59: default Live custom instructions = flash answer-style rule
    // (admin-editable in panel; keep in sync with DEFAULT_LIVE_INSTRUCTIONS
    // in liveTokenService.js). The locked LIVE_ANSWER_STYLE block enforces
    // the same rule even when this field is empty.
    liveInstructions: 'Jawab hamesha 1 se 6 short lines mein do, dostana aur seedha — bina soche hue dikhaye, bina lambi tafseel ke.',
    // v91 (BugHunter DB P2-23): the retired gemini-2.5-flash was the default.
    currentModel: 'gemini-3.6-flash',
    referralReward: 5
};

async function getActiveConfig() {
    await connectToDatabase();
    if (isDbConnected()) {
        // v91 (BugHunter DB P1-9): atomic upsert — the old findOne + create
        // raced on cold starts (two invocations -> E11000 on the unique key).
        const conf = await AppConfig.findOneAndUpdate(
            { key: 'global_config' },
            { $setOnInsert: localConfig },
            { upsert: true, new: true }
        );
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
// Latest shipped release: versionCode 92 / "1.0.91" (2026-10-28, v92 hotfix + Method 6 + patcher slow-fix).
// Bump LATEST_VERSION_CODE / LATEST_VERSION_NAME when a newer APK ships.
const LATEST_VERSION_CODE = 92;
const LATEST_VERSION_NAME = '1.0.91';

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
