const crypto = require('crypto');
const User = require('../models/User');
const OnlineToolToken = require('../models/OnlineToolToken');
const { connectToDatabase, isDbConnected } = require('../config/db');
const { getActiveConfig } = require('./configController');

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token).trim()).digest('hex');
}

// Normalize admin-controlled online-tool config with safe defaults.
function getOnlineToolConfig(conf) {
    const raw = (conf && conf.onlineTool) || {};
    let customPath = String(raw.customPath || 'online-tool').trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
    if (!customPath || customPath === 'api' || customPath === 'admin') customPath = 'online-tool';
    const theme = raw.theme === 'light' ? 'light' : 'neon-dark';
    return {
        enabled: raw.enabled !== false,
        minCredits: Number.isFinite(Number(raw.minCredits)) && Number(raw.minCredits) >= 0
            ? Number(raw.minCredits) : 12,
        theme,
        customPath
    };
}

// POST /api/online-tool/token — authenticateUser required.
// Issues a 5-minute, single-use token after the credits gate.
async function issueToken(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Try again shortly.' });
    }

    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    try {
        const conf = await getActiveConfig();
        const toolCfg = getOnlineToolConfig(conf);
        if (!toolCfg.enabled) {
            return res.status(403).json({ success: false, error: 'Online Tool is currently disabled.' });
        }

        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        if (user.status === 'banned') {
            return res.status(403).json({ success: false, error: 'Account banned.' });
        }
        // Pro members keep unlimited access; everyone else needs credits above the threshold.
        const credits = Number(user.credits) || 0;
        if (!(credits > toolCfg.minCredits || user.isPro)) {
            return res.status(403).json({
                success: false,
                error: `Online Tool requires more than ${toolCfg.minCredits} credits.`
            });
        }

        const token = crypto.randomBytes(32).toString('hex');
        await OnlineToolToken.create({
            tokenHash: hashToken(token),
            username,
            expiresAt: new Date(Date.now() + TOKEN_TTL_MS)
        });

        return res.json({
            success: true,
            token,
            pageUrl: `/${toolCfg.customPath}?token=${token}`,
            expiresIn: TOKEN_TTL_MS / 1000
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// GET /<customPath>?token=... — the token IS the auth. No session needed.
// Redeem is an atomic findOneAndDelete: single-use, race-safe on serverless.
async function serveToolPage(req, res) {
    const token = (req.query && req.query.token) || '';
    if (!token) return denyPage(res);

    await connectToDatabase();
    if (!isDbConnected()) return denyPage(res, 'Service temporarily unavailable.');

    try {
        const conf = await getActiveConfig();
        const toolCfg = getOnlineToolConfig(conf);
        if (!toolCfg.enabled) return denyPage(res, 'Online Tool is currently disabled.');

        const doc = await OnlineToolToken.findOneAndDelete({ tokenHash: hashToken(token) });
        if (!doc) return denyPage(res); // unknown, already used, or pruned
        if (doc.expiresAt.getTime() < Date.now()) return denyPage(res, 'This link has expired.');

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        return res.send(renderOnlineToolPage(toolCfg.theme));
    } catch (e) {
        return denyPage(res, 'Service temporarily unavailable.');
    }
}

function denyPage(res, message) {
    res.status(403).set('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e2e8f0;font-family:system-ui,sans-serif;"><div style="text-align:center;padding:24px;"><h1 style="font-size:22px;margin-bottom:8px;">🔒 Access Denied</h1><p style="color:#94a3b8;font-size:14px;">${escapeHtml(message || 'Open from inside the Kamaal app.')}</p></div></body></html>`);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Placeholder page (admin-editable later): "Online Downloader" + plans.
function renderOnlineToolPage(theme) {
    const dark = theme !== 'light';
    const bg = dark ? '#0b1220' : '#f1f5f9';
    const card = dark ? '#111c33' : '#ffffff';
    const fg = dark ? '#e2e8f0' : '#0f172a';
    const muted = dark ? '#94a3b8' : '#64748b';
    const accent = dark ? '#22d3ee' : '#0284c7';
    const accent2 = dark ? '#a855f7' : '#7c3aed';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Online Downloader</title></head><body style="margin:0;min-height:100vh;background:${bg};color:${fg};font-family:system-ui,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:32px 20px;">
<h1 style="font-size:28px;margin:0 0 6px;background:linear-gradient(90deg,${accent},${accent2});-webkit-background-clip:text;background-clip:text;color:transparent;">⬇ Online Downloader</h1>
<p style="color:${muted};font-size:14px;margin:0 0 24px;">Paste a link, get your file. Plans below — more tools coming soon.</p>
<div style="display:grid;gap:16px;">
<div style="background:${card};border:1px solid ${accent}55;border-radius:16px;padding:20px;">
<h2 style="margin:0 0 4px;font-size:18px;">Free</h2>
<p style="margin:0 0 12px;color:${muted};font-size:13px;">Everyday downloads, no fuss.</p>
<div style="font-size:26px;font-weight:800;margin-bottom:12px;">$0<span style="font-size:13px;font-weight:400;color:${muted};"> / forever</span></div>
<ul style="margin:0;padding-left:18px;color:${muted};font-size:13px;line-height:1.9;"><li>720p downloads</li><li>5 downloads / day</li><li>Standard speed</li></ul>
</div>
<div style="background:${card};border:1px solid ${accent2};border-radius:16px;padding:20px;box-shadow:0 0 24px ${accent2}33;">
<h2 style="margin:0 0 4px;font-size:18px;">Pro <span style="font-size:11px;background:${accent2};color:#fff;border-radius:999px;padding:2px 8px;vertical-align:middle;">POPULAR</span></h2>
<p style="margin:0 0 12px;color:${muted};font-size:13px;">For power downloaders.</p>
<div style="font-size:26px;font-weight:800;margin-bottom:12px;">$4.99<span style="font-size:13px;font-weight:400;color:${muted};"> / month</span></div>
<ul style="margin:0;padding-left:18px;color:${muted};font-size:13px;line-height:1.9;"><li>4K downloads</li><li>Unlimited downloads</li><li>Priority speed</li><li>No waiting queue</li></ul>
</div>
</div>
<p style="color:${muted};font-size:11px;text-align:center;margin-top:28px;">Inside-app access only • Kamaal</p>
</div></body></html>`;
}

module.exports = {
    issueToken,
    serveToolPage,
    getOnlineToolConfig,
    TOKEN_TTL_MS
};
