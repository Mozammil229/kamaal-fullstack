const crypto = require('crypto');

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
// Key: env APIKEY_ENCRYPTION_KEY — 32 bytes, hex (64 chars) or base64.
// When absent/invalid the provider-key features are NOT CONFIGURED:
// admin provider-key endpoints answer 503 and the pool serves env keys
// only (chat never breaks). The kml_ hash-only path needs no enc key.

const FORMAT_PREFIX = 'v1';

function getKey() {
    const raw = (process.env.APIKEY_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    try {
        if (/^[0-9a-fA-F]{64}$/.test(raw)) {
            const buf = Buffer.from(raw, 'hex');
            return buf.length === 32 ? buf : null;
        }
        const buf = Buffer.from(raw, 'base64');
        return buf.length === 32 ? buf : null;
    } catch (_) {
        return null;
    }
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

module.exports = { isConfigured, encryptValue, decryptValue, sha256, maskLast4, newKmlId };
