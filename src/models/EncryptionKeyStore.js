const mongoose = require('mongoose');

// Panel-stored APIKEY_ENCRYPTION_KEY (2026-11-08, user order: the key is
// set INSIDE the admin panel, not in the Vercel dashboard).
//
// The 32-byte key is NEVER stored in plaintext. It is stored WRAPPED
// (AES-256-GCM) under a key derived from env.ADMIN_PASS via scrypt with a
// per-store random salt. The server unwraps it in memory at runtime.
//
//   * env APIKEY_ENCRYPTION_KEY (if set) ALWAYS takes precedence — the
//     panel key is then dormant and the panel input is disabled.
//   * If ADMIN_PASS is unset, panel storage is UNAVAILABLE (fail-closed:
//     there is no server secret to wrap with).
//   * If ADMIN_PASS is ROTATED, the stored blob becomes undecryptable —
//     the server treats encryption as unconfigured and the admin simply
//     sets the panel key again (Generate). Provider pool rows encrypted
//     under the old key are skipped by the pool (existing behaviour for a
//     wrong/rotated key) and must be re-added.
//   * Single document, keyed 'apikey_encryption_key'. The wrapped blob
//     fields (salt/iv/tag/ct) are useless without ADMIN_PASS.

const EncryptionKeyStoreSchema = new mongoose.Schema({
    key: { type: String, default: 'apikey_encryption_key', unique: true },
    v: { type: Number, default: 1 },
    salt: { type: String, required: true }, // base64, 16 bytes
    iv: { type: String, required: true },   // base64, 12 bytes (GCM nonce)
    tag: { type: String, required: true },  // base64, 16 bytes (GCM tag)
    ct: { type: String, required: true },   // base64, wrapped 32-byte key
    updatedBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.EncryptionKeyStore
    || mongoose.model('EncryptionKeyStore', EncryptionKeyStoreSchema);
