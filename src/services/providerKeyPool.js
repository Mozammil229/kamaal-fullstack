const env = require('../config/env');
const apikeyCrypto = require('./apikeyCrypto');
const ProviderApiKey = require('../models/ProviderApiKey');
const { isDbConnected } = require('../config/db');

// Provider key pool — Kamaal API track (2026-11-05).
// Merges TWO sources per provider, in order:
//   1. ENV keys (existing behaviour, unchanged): Gemini from
//      GEMINI_API_KEY + GEMINI_BACKUP_KEYS. ChatGPT has no env var.
//   2. DB pool keys (admin-added via /api/admin/apikeys/*): active rows
//      only, decrypted in-memory with APIKEY_ENCRYPTION_KEY. A row that
//      fails to decrypt (wrong/rotated enc key, tampered blob) is SKIPPED
//      with a warning that never includes key material.
//
// Cache: 60s TTL per provider (Vercel serverless instances keep their
// own); admin mutations call refresh(provider) for an immediate reload.
// Env-only fallback: when the DB is down or encryption is unconfigured,
// the pool serves env keys only — chat never breaks over pool admin.
// Live token minting (liveTokenService) keeps the sync env-only path
// (getGeminiKeys) — out of scope for this track.

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // provider -> { keys: string[], at: number }

function envGeminiKeys() {
    const raw = [env.GEMINI_API_KEY, env.GEMINI_BACKUP_KEYS].filter(Boolean).join(',');
    return Array.from(new Set(
        raw.split(',').map(k => k.trim()).filter(k => k && k.length > 10 && k !== 'MY_GEMINI_API_KEY')
    ));
}

async function loadDbKeys(provider) {
    if (!isDbConnected()) return [];
    if (!apikeyCrypto.isConfigured()) return [];
    let rows;
    try {
        rows = await ProviderApiKey.find({ provider, status: 'active' }).select('+encKey').lean();
    } catch (e) {
        console.warn(`[keypool] DB load failed for ${provider}: ${e.message}`);
        return [];
    }
    const keys = [];
    for (const row of rows) {
        try {
            const plain = apikeyCrypto.decryptValue(row.encKey);
            if (plain && plain.length > 10) keys.push(plain);
        } catch (e) {
            // Wrong/rotated enc key or tampered blob — skip the row.
            // Never log the blob or the key.
            console.warn(`[keypool] Skipping undecryptable ${provider} pool row ${String(row._id)}: ${e.message}`);
        }
    }
    return keys;
}

/** Plaintext keys for [provider], env first then DB pool (deduped). Async. */
async function getPoolKeys(provider) {
    const now = Date.now();
    const hit = cache.get(provider);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.keys.slice();
    const envKeys = provider === 'gemini' ? envGeminiKeys() : [];
    const dbKeys = await loadDbKeys(provider);
    const keys = Array.from(new Set([...envKeys, ...dbKeys]));
    cache.set(provider, { keys, at: now });
    return keys.slice();
}

/** Drop the cached list for [provider] (call after admin add/revoke). */
function refresh(provider) {
    cache.delete(provider);
}

/** Best-effort usage accounting for a DB pool key (no-op for env keys). */
async function recordKeyUse(provider, keyHash) {
    if (!keyHash || !isDbConnected()) return;
    try {
        await ProviderApiKey.findOneAndUpdate(
            { keyHash },
            { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
        );
    } catch (_) { /* usage accounting never fails a chat reply */ }
}

/** Admin-safe status: counts + masked rows only. NEVER plaintext keys. */
async function listPoolStatus(provider) {
    const envCount = provider === 'gemini' ? envGeminiKeys().length : 0;
    let dbRows = [];
    if (isDbConnected()) {
        try {
            dbRows = await ProviderApiKey.find({ provider }).sort({ createdAt: -1 }).lean();
        } catch (e) {
            console.warn(`[keypool] status load failed for ${provider}: ${e.message}`);
        }
    }
    return {
        provider,
        envKeyCount: envCount,
        dbKeyCount: dbRows.length,
        activeDbKeyCount: dbRows.filter(r => r.status === 'active').length,
        encryptionConfigured: apikeyCrypto.isConfigured(),
        keys: dbRows.map(r => ({
            id: String(r._id),
            label: r.label || '',
            last4: r.keyLast4,
            status: r.status,
            usageCount: r.usageCount || 0,
            lastUsedAt: r.lastUsedAt || null,
            createdAt: r.createdAt || null
        }))
    };
}

module.exports = { getPoolKeys, refresh, recordKeyUse, listPoolStatus, envGeminiKeys };
