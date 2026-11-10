// Flow Engine X P13 — append-only version history for a synced flow
// (§16.4 groundwork). One row per (owner, flowId, version); a version
// row is NEVER mutated — a new push appends a new row. The blob is
// stored per version (opaque ciphertext) so restore can re-fetch the
// exact bytes that version carried. Conflict detection compares
// baseVersionHash against the head row's contentHash.

'use strict';

const mongoose = require('mongoose');

const FlowVersionSchema = new mongoose.Schema({
    owner: { type: String, required: true, index: true },
    flowId: { type: String, required: true },
    version: { type: Number, required: true },
    contentHash: { type: String, required: true },
    dslVersion: { type: Number, required: true },
    encryptedBlob: {
        packed: { type: String, required: true },
        sha256Hex: { type: String, required: true },
        saltB64: { type: String, required: true }
    },
    createdAt: { type: Number, default: Date.now }
});

FlowVersionSchema.index({ owner: 1, flowId: 1, version: 1 }, { unique: true });

module.exports = mongoose.models.FlowVersion || mongoose.model('FlowVersion', FlowVersionSchema);
