const crypto = require('crypto');

// AES-256-GCM encryption-at-rest for AI Memory fact values.
// Key: env MEMORY_ENC_KEY — 32 bytes, hex (64 chars) or base64.
// When the key is absent/invalid the memory engine is NOT CONFIGURED:
// memory endpoints answer 503 MEMORY_NOT_CONFIGURED and chat
// injection/extraction skip silently (see memoryService / aiController).
const FORMAT_PREFIX = 'v1';

function getKey() {
    const raw = (process.env.MEMORY_ENC_KEY || '').trim();
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
    if (!key) throw new Error('MEMORY_NOT_CONFIGURED');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Decrypt a value produced by encryptValue. Throws on tamper/format. */
function decryptValue(payload) {
    const key = getKey();
    if (!key) throw new Error('MEMORY_NOT_CONFIGURED');
    const parts = String(payload || '').split(':');
    if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) throw new Error('BAD_MEMORY_CIPHERTEXT');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { isConfigured, encryptValue, decryptValue };
