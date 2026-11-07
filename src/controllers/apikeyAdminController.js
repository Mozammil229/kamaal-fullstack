const crypto = require('crypto');
const ProviderApiKey = require('../models/ProviderApiKey');
const KamaalApiKey = require('../models/KamaalApiKey');
const AdminAudit = require('../models/AdminAudit');
const apikeyCrypto = require('../services/apikeyCrypto');
const pool = require('../services/providerKeyPool');
const { connectToDatabase } = require('../config/db');

// Admin API-key management — Kamaal API track (2026-11-05).
// Namespace /api/admin/apikeys/* (behind requireAdminAuth). The existing
// /api/admin/keys/* endpoints are REDEEM vouchers — untouched.
//
// SECURITY CONTRACT (enforced here, not just in the UI):
//   * A provider key is NEVER returned by any endpoint after creation
//     (only {id,last4} on create). It is stored AES-256-GCM encrypted +
//     SHA-256 hashed (dedup) + last4 (masked display).
//   * A kml_ token is returned in full ONCE, at creation. Only its
//     SHA-256 hash is stored; list endpoints show last4 only.
//   * No endpoint logs a key or token value. Audit rows carry ids/last4.
//   * Provider-key writes require encryption configured (503 otherwise);
//     kml_ issuance needs no enc key (hash-only storage).

const PROVIDERS = ['gemini', 'chatgpt'];
const TIERS = ['basic', 'advance'];

/** Best-effort admin audit (never fails the request). */
async function audit(adminUser, action, audience) {
    try {
        await AdminAudit.create({ adminId: adminUser || 'admin', action, audience: audience || '', count: 0 });
    } catch (_) { /* audit is best-effort */ }
}

function adminName(req) {
    return req.adminUser || 'admin';
}

// GET /api/admin/apikeys/providers
// Per-provider pool status: counts + masked rows. NEVER plaintext keys.
async function getProviders(req, res) {
    await connectToDatabase();
    try {
        const out = [];
        for (const p of PROVIDERS) out.push(await pool.listPoolStatus(p));
        return res.json({ success: true, providers: out });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// POST /api/admin/apikeys/provider-key  { provider, key, label? }
// Adds one WORKING provider key to the pool. Returns {id,last4} ONLY.
async function addProviderKey(req, res) {
    await connectToDatabase();
    const { provider, key, label } = req.body || {};
    if (!PROVIDERS.includes(provider)) {
        return res.status(400).json({ success: false, error: 'provider must be gemini or chatgpt.' });
    }
    const plain = String(key || '').trim();
    if (plain.length < 10) {
        return res.status(400).json({ success: false, error: 'A working provider key is required (min 10 chars).' });
    }
    if (!apikeyCrypto.isConfigured()) {
        return res.status(503).json({
            success: false,
            code: 'APIKEY_ENC_NOT_CONFIGURED',
            error: 'APIKEY_ENCRYPTION_KEY is not set on the server. Set it in Vercel env first — provider keys are never stored unencrypted.'
        });
    }
    const keyHash = apikeyCrypto.sha256(plain);
    const existing = await ProviderApiKey.findOne({ keyHash }).lean();
    if (existing) {
        return res.status(409).json({ success: false, error: 'This key is already in the pool.' });
    }
    let created;
    try {
        created = await ProviderApiKey.create({
            provider,
            label: String(label || '').slice(0, 80),
            encKey: apikeyCrypto.encryptValue(plain),
            keyHash,
            keyLast4: apikeyCrypto.maskLast4(plain),
            createdBy: adminName(req)
        });
    } catch (e) {
        if (e && e.code === 11000) {
            return res.status(409).json({ success: false, error: 'This key is already in the pool.' });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
    pool.refresh(provider);
    await audit(adminName(req), 'apikey.provider_key.create', `${provider}:${created.keyLast4}`);
    return res.json({ success: true, id: String(created._id), provider, last4: created.keyLast4 });
}

// POST /api/admin/apikeys/provider-key/revoke  { id }
// Soft-revoke: row kept for audit, never served by the pool again.
async function revokeProviderKey(req, res) {
    await connectToDatabase();
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id required.' });
    const row = await ProviderApiKey.findByIdAndUpdate(
        id,
        { $set: { status: 'revoked', revokedAt: new Date() } },
        { new: true }
    ).lean();
    if (!row) return res.status(404).json({ success: false, error: 'Provider key not found.' });
    pool.refresh(row.provider);
    await audit(adminName(req), 'apikey.provider_key.revoke', `${row.provider}:${row.keyLast4}`);
    return res.json({ success: true, id: String(row._id), provider: row.provider, last4: row.keyLast4, status: 'revoked' });
}

// POST /api/admin/apikeys/kamaal-key  { ownerUsername?, tier? }
// Issues a Kamaal API key (kml_...). The FULL token is returned ONCE here
// and never again; only its SHA-256 hash is stored.
async function createKamaalKey(req, res) {
    await connectToDatabase();
    const { ownerUsername, tier } = req.body || {};
    const cleanTier = TIERS.includes(tier) ? tier : 'basic';
    const owner = String(ownerUsername || '').trim().slice(0, 100);
    let created = null;
    let token = '';
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
        token = apikeyCrypto.newKmlId();
        try {
            created = await KamaalApiKey.create({
                publicId: token,
                tokenHash: apikeyCrypto.sha256(token),
                ownerUsername: owner,
                tier: cleanTier,
                createdBy: adminName(req)
            });
        } catch (e) {
            if (e && e.code === 11000) continue; // collision — fresh id
            return res.status(500).json({ success: false, error: e.message });
        }
    }
    if (!created) return res.status(500).json({ success: false, error: 'Could not issue a key. Try again.' });
    await audit(adminName(req), 'apikey.kamaal_key.create', `${token.slice(-4)}:${owner || 'unattached'}:${cleanTier}`);
    // FULL token, once. The admin must copy it now — it is never shown again.
    return res.json({
        success: true,
        token,
        publicId: token,
        last4: apikeyCrypto.maskLast4(token),
        ownerUsername: owner,
        tier: cleanTier
    });
}

// GET /api/admin/apikeys/kamaal-keys
// List issued keys: last4 only. NEVER token, tokenHash, or the full
// publicId — publicId IS the token, so the list exposes only a Mongo
// row id (for attach/revoke) and a masked display id.
async function listKamaalKeys(req, res) {
    await connectToDatabase();
    try {
        const rows = await KamaalApiKey.find().sort({ createdAt: -1 }).limit(200).lean();
        return res.json({
            success: true,
            keys: rows.map(r => ({
                id: String(r._id),
                displayId: 'kml_****' + String(r.publicId).slice(-4),
                last4: apikeyCrypto.maskLast4(r.publicId),
                ownerUsername: r.ownerUsername || '',
                tier: r.tier,
                status: r.status,
                callsUsed: r.callsUsed || 0,
                lastUsedAt: r.lastUsedAt || null,
                createdAt: r.createdAt || null
            }))
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Resolve a kml_ row for attach/revoke: by Mongo row id (what the admin
// UI has) or by full publicId token (admin pasting the once-shown token).
async function findKamaalRow({ id, publicId }) {
    if (id && /^[0-9a-fA-F]{24}$/.test(String(id))) {
        return KamaalApiKey.findById(id);
    }
    if (publicId) {
        return KamaalApiKey.findOne({ publicId: String(publicId) });
    }
    return null;
}

// POST /api/admin/apikeys/kamaal-key/attach  { id | publicId, ownerUsername }
// Attach (or re-assign) a kml_ key to a user. Credits are checked +
// deducted from this user on every /api/v1/chat call with the key.
async function attachKamaalKey(req, res) {
    await connectToDatabase();
    const { id, publicId, ownerUsername } = req.body || {};
    const owner = String(ownerUsername || '').trim();
    if ((!id && !publicId) || !owner) {
        return res.status(400).json({ success: false, error: 'id (or publicId) and ownerUsername are required.' });
    }
    const User = require('../models/User');
    const user = await User.findOne({ username: owner }).select('username').lean();
    if (!user) return res.status(404).json({ success: false, error: `User '${owner}' not found.` });
    const row = await findKamaalRow({ id, publicId });
    if (!row) return res.status(404).json({ success: false, error: 'Kamaal API key not found.' });
    row.ownerUsername = owner;
    await row.save();
    await audit(adminName(req), 'apikey.kamaal_key.attach', `${String(row.publicId).slice(-4)}:${owner}`);
    return res.json({ success: true, id: String(row._id), displayId: 'kml_****' + String(row.publicId).slice(-4), last4: apikeyCrypto.maskLast4(row.publicId), ownerUsername: owner, tier: row.tier, status: row.status });
}

// POST /api/admin/apikeys/kamaal-key/revoke  { id | publicId }
async function revokeKamaalKey(req, res) {
    await connectToDatabase();
    const { id, publicId } = req.body || {};
    if (!id && !publicId) return res.status(400).json({ success: false, error: 'id (or publicId) required.' });
    const row = await findKamaalRow({ id, publicId });
    if (!row) return res.status(404).json({ success: false, error: 'Kamaal API key not found.' });
    row.status = 'revoked';
    row.revokedAt = new Date();
    await row.save();
    await audit(adminName(req), 'apikey.kamaal_key.revoke', `${String(row.publicId).slice(-4)}:${row.ownerUsername || 'unattached'}`);
    return res.json({ success: true, id: String(row._id), displayId: 'kml_****' + String(row.publicId).slice(-4), last4: apikeyCrypto.maskLast4(row.publicId), status: 'revoked' });
}

module.exports = {
    getProviders,
    addProviderKey,
    revokeProviderKey,
    createKamaalKey,
    listKamaalKeys,
    attachKamaalKey,
    revokeKamaalKey
};
