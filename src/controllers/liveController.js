// VOXPILOT PHASE 2 (v58) — POST /api/live/token.
//
// JWT-authenticated. Mints a short-lived, single-use Gemini Live ephemeral
// token so the phone can open a Live voice session WITHOUT ever receiving
// the server-side Gemini key. Response: { success, token, wsUrl, model,
// expiresAt, newSessionExpiresAt, uses }. The token value itself is the
// only credential in the response; the server key is never included.
const { getActiveConfig } = require('./configController');
const { mintEphemeralToken, LIVE_MODELS, DEFAULT_LIVE_MODEL, LIVE_WS_URL, LIVE_VOICES } = require('../services/liveTokenService');

async function mintLiveToken(req, res) {
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'Login required.' });

    const requestedModel = req.body && typeof req.body.model === 'string' ? req.body.model.trim() : '';
    if (requestedModel && !LIVE_MODELS.includes(requestedModel)) {
        return res.status(400).json({ success: false, error: 'Unknown Live model: ' + requestedModel.slice(0, 80) });
    }

    // v61 — Live voice styles: the app may ask for one of the five
    // prebuilt voices; anything else is a 400 (never silently remapped).
    const requestedVoice = req.body && typeof req.body.voice === 'string' ? req.body.voice.trim() : '';
    if (requestedVoice && !LIVE_VOICES.includes(requestedVoice)) {
        return res.status(400).json({ success: false, error: 'Unknown Live voice: ' + requestedVoice.slice(0, 40) });
    }

    try {
        const conf = await getActiveConfig();
        const flags = (conf && conf.featureFlags) || {};
        if (flags.liveVoice === false) {
            return res.status(503).json({ success: false, error: 'Live voice is disabled by the admin.', code: 'LIVE_DISABLED' });
        }
        const toolsEnabled = flags.liveTools !== false;
        const minted = await mintEphemeralToken({
            model: requestedModel || DEFAULT_LIVE_MODEL,
            voice: requestedVoice || undefined,
            systemPrompt: conf && conf.systemPrompt,
            liveInstructions: conf && conf.liveInstructions,
            toolsEnabled
        });
        return res.json({
            success: true,
            token: minted.token,
            wsUrl: LIVE_WS_URL,
            model: minted.model,
            voice: minted.voice,
            expiresAt: minted.expiresAt,
            newSessionExpiresAt: minted.newSessionExpiresAt,
            uses: minted.uses,
            toolsEnabled
        });
    } catch (e) {
        if (e && e.code === 'GEMINI_KEY_MISSING') {
            return res.status(503).json({ success: false, error: 'Live voice is not configured on the server.', code: 'LIVE_NOT_CONFIGURED' });
        }
        return res.status(502).json({ success: false, error: (e && e.message) || 'Live token mint failed.', code: 'LIVE_MINT_FAILED' });
    }
}

module.exports = { mintLiveToken };
