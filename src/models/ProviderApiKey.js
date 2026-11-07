const mongoose = require('mongoose');

// Provider pool key — one row per REAL provider key (Gemini / ChatGPT)
// that the server uses to call the provider on behalf of users.
//
// SECURITY: the provider key itself is NEVER stored in plaintext and NEVER
// returned by any endpoint after creation.
//   encKey   — AES-256-GCM ciphertext (services/apikeyCrypto.js); the only
//              recoverable form, decrypted in-memory only when calling the
//              provider. Useless without APIKEY_ENCRYPTION_KEY.
//   keyHash  — SHA-256 hex, for duplicate detection (same key twice -> 409).
//   keyLast4 — masked display only (****aB3d).
// Revocation is a soft status flip (row kept for audit); revoked rows are
// never served by the pool.

const ProviderApiKeySchema = new mongoose.Schema({
    provider: { type: String, enum: ['gemini', 'chatgpt'], required: true, index: true },
    label: { type: String, default: '' },
    encKey: { type: String, required: true, select: false },
    keyHash: { type: String, required: true, unique: true, index: true },
    keyLast4: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
    usageCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null }
});

ProviderApiKeySchema.index({ provider: 1, status: 1 });

module.exports = mongoose.models.ProviderApiKey || mongoose.model('ProviderApiKey', ProviderApiKeySchema);
