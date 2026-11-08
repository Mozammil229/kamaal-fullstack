const crypto = require('crypto');
const env = require('../config/env');

// API-KEY crypto helpers — Kamaal API track (2026-11-05).
// Mirrors services/memoryCrypto.js exactly (AES-256-GCM, env key, format
// "v1:iv:tag:ct") so provider keys at rest use the same reviewed pattern.
//
// TWO key types — do not conflate:
//   (a) Kamaal API keys (kml_...): access tokens for POST /api/v1/chat.
//       Stored as SHA-256 hash ONLY — the plaintext is never needed again
//       after issuance (like a password). Full token shown ONCE at creation.
//   (b) Provider pool keys (real Gemini / ChatGPT keys): the server MUST
//       present them in plaintext to the provider, so hash-only storage
//       would make them unusable. Stored ENCRYPTED at rest + SHA-256 hash
//       alongside for dedup + last4 for masked display. NEVER plaintext.
//
// Key sources, in precedence order (2026-11-08, panel-based setup):
//   1. env APIKEY_ENCRYPTION_KEY — 32 bytes, hex (64 chars) or base64.
//      If set, it ALWAYS wins and the panel key (if any) is dormant.
//   2. Panel key — set from the admin panel (API Keys tab), stored in
//      MongoDB WRAPPED under a key derived from env.ADMIN_PASS (scrypt).
//      Unwrapped into an in-memory cache by ensurePanelKeyLoaded().
// When neither is available the provider-key features are NOT CONFIGURED:
// admin provider-key endpoints answer 503 and the pool serves env keys
// only (chat never breaks). The kml_ hash-only path needs no enc key.

const FORMAT_PREFIX = 'v1';

function getEnvKey() {
    const raw = (process.env.APIKEY_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    const buf = parseKeyInput(raw);
    return buf; // null when malformed — env is ignored, never half-trusted
}

/**
 * The encryption key in use: env first, panel cache second, null when
 * neither is available. Sync on purpose — every existing caller is sync
 * (encryptValue/decryptValue/isConfigured). Async entry points warm the
 * panel cache first via ensurePanelKeyLoaded().
 */
function getKey() {
    return getEnvKey() || panelKeyBuf;
}

/** Where the active key came from: 'env' | 'panel' | null. */
function getKeySource() {
    if (getEnvKey()) return 'env';
    if (panelKeyBuf) return 'panel';
    return null;
}

function isConfigured() {
    return getKey() !== null;
}

/** Encrypt a UTF-8 string -> "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
function encryptValue(plaintext) {
    const key = getKey();
    if (!key) throw new Error('APIKEY_ENC_NOT_CONFIGURED');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypt a value produced by encryptValue. Throws on tamper/format. */
function decryptValue(payload) {
    const key = getKey();
    if (!key) throw new Error('APIKEY_ENC_NOT_CONFIGURED');
    const parts = String(payload || '').split(':');
    if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) throw new Error('BAD_APIKEY_CIPHERTEXT');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** SHA-256 hex of a token/key. Used for storage + lookup, never reversed. */
function sha256(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

/** Masked display: only the last 4 chars are ever shown after creation. */
function maskLast4(str) {
    const s = String(str || '');
    return '****' + s.slice(-4);
}

/** New Kamaal API key id: kml_ + 24 crypto-random alphanumerics. */
function newKmlId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(24);
    let out = '';
    for (let i = 0; i < 24; i++) out += chars[bytes[i] % chars.length];
    return 'kml_' + out;
}

// ---- PANEL-STORED ENCRYPTION KEY (2026-11-08) -------------------------
// The panel key is set from the admin panel (Generate server-side, or
// paste 64 hex / base64-of-32). It is stored WRAPPED in MongoDB
// (models/EncryptionKeyStore) under a key derived from env.ADMIN_PASS
// via scrypt. The plaintext key value is NEVER returned, logged, or
// written to a file anywhere in this module.

const STORE_DOC_KEY = 'apikey_encryption_key';

// In-memory cache of the unwrapped panel key. Warmed lazily by
// ensurePanelKeyLoaded() (async entry points only) and set directly by
// storePanelKey() after a successful write. 'unknown' means "not looked
// up yet this process" — NOT "absent" (a cold server must not cache a
// false negative before the DB is reachable).
let panelKeyBuf = null;
let panelKeyState = 'unknown'; // 'unknown' | 'loaded' | 'none'

/**
 * Parse a pasted/generated key: 64 hex chars OR strict base64 of exactly
 * 32 bytes. Returns the 32-byte Buffer, or null for anything else.
 * Strict base64: only the base64 alphabet, length multiple of 4, and the
 * decoded length must be exactly 32 (Buffer.from is lenient — it silently
 * drops bad characters, so the regex gate is load-bearing).
 */
function parseKeyInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    try {
        if (/^[0-9a-fA-F]{64}$/.test(s)) {
            const buf = Buffer.from(s, 'hex');
            return buf.length === 32 ? buf : null;
        }
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return null;
        const buf = Buffer.from(s, 'base64');
        return buf.length === 32 ? buf : null;
    } catch (_) {
        return null;
    }
}

/** Wrapping key for the panel store: scrypt(ADMIN_PASS, salt, 32). */
function deriveWrapKey(saltBuf) {
    const pass = (env.ADMIN_PASS || '').trim();
    if (!pass) return null; // no server secret -> panel storage unavailable
    return crypto.scryptSync(pass, saltBuf, 32);
}

/** Wrap a 32-byte key for storage. Returns { salt, iv, tag, ct } (base64). */
function wrapPanelKey(keyBuf) {
    const salt = crypto.randomBytes(16);
    const wrapKey = deriveWrapKey(salt);
    if (!wrapKey) throw new Error('PANEL_KEY_UNAVAILABLE');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
    const ct = Buffer.concat([cipher.update(keyBuf), cipher.final()]);
    return {
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64')
    };
}

/** Unwrap a stored doc back to the 32-byte key. Throws on bad wrap key. */
function unwrapPanelKey(doc) {
    if (!doc || !doc.salt || !doc.iv || !doc.tag || !doc.ct) {
        throw new Error('BAD_PANEL_KEY_STORE');
    }
    const wrapKey = deriveWrapKey(Buffer.from(doc.salt, 'base64'));
    if (!wrapKey) throw new Error('PANEL_KEY_UNAVAILABLE');
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm', wrapKey, Buffer.from(doc.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
    const out = Buffer.concat([
        decipher.update(Buffer.from(doc.ct, 'base64')), decipher.final()
    ]);
    if (out.length !== 32) throw new Error('BAD_PANEL_KEY_STORE');
    return out;
}

/** Load the stored panel key into the in-memory cache (once per process). */
async function ensurePanelKeyLoaded() {
    if (panelKeyState !== 'unknown') return;
    const { isDbConnected } = require('../config/db');
    if (!isDbConnected()) return; // DB not up yet — retry on the next call
    try {
        const EncryptionKeyStore = require('../models/EncryptionKeyStore');
        const doc = await EncryptionKeyStore.findOne({ key: STORE_DOC_KEY }).lean();
        if (!doc) { panelKeyState = 'none'; panelKeyBuf = null; return; }
        panelKeyBuf = unwrapPanelKey(doc);
        panelKeyState = 'loaded';
    } catch (e) {
        // Wrong/rotated ADMIN_PASS or tampered blob — fail closed, never
        // log the blob or the key. The admin can set the panel key again.
        console.warn(`[apikeyCrypto] panel key unavailable: ${e.message}`);
        panelKeyState = 'none';
        panelKeyBuf = null;
    }
}

/**
 * Store a panel key (wrap + upsert + warm the cache). Returns
 * { replaced: bool } — replaced=true when a stored key already existed
 * (its pool rows were encrypted under the old key and will be skipped
 * until re-added). Throws PANEL_KEY_UNAVAILABLE when ADMIN_PASS is unset.
 */
async function storePanelKey(keyBuf, updatedBy) {
    if (!Buffer.isBuffer(keyBuf) || keyBuf.length !== 32) {
        throw new Error('INVALID_ENCRYPTION_KEY');
    }
    const wrapped = wrapPanelKey(keyBuf); // throws PANEL_KEY_UNAVAILABLE
    const EncryptionKeyStore = require('../models/EncryptionKeyStore');
    const prev = await EncryptionKeyStore.findOne({ key: STORE_DOC_KEY }).lean();
    await EncryptionKeyStore.findOneAndUpdate(
        { key: STORE_DOC_KEY },
        {
            $set: {
                v: 1,
                salt: wrapped.salt,
                iv: wrapped.iv,
                tag: wrapped.tag,
                ct: wrapped.ct,
                updatedBy: String(updatedBy || ''),
                updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true, new: true }
    );
    panelKeyBuf = Buffer.from(keyBuf);
    panelKeyState = 'loaded';
    return { replaced: !!prev };
}

/** Test/support hook: drop the in-memory cache (forces a fresh DB load). */
function clearPanelKeyCache() {
    panelKeyBuf = null;
    panelKeyState = 'unknown';
}

module.exports = {
    isConfigured, encryptValue, decryptValue, sha256, maskLast4, newKmlId,
    parseKeyInput, getKeySource, ensurePanelKeyLoaded, storePanelKey,
    clearPanelKeyCache, wrapPanelKey, unwrapPanelKey
};
