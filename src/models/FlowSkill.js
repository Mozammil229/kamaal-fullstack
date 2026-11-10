// Flow Engine X P13 — Cross-Device Synchronization: synced skill/flow record.
//
// One row per (owner, flowId). The server stores the flow ONLY as an
// opaque encrypted blob (AES-256-GCM under a user-held key — the
// passphrase never leaves the device, the server holds no key and can
// never read the blob) plus the plaintext metadata allowlist below.
// NO secret, credential, message body, or recipient display data is
// ever a field here — step args and variable values live ONLY inside
// the blob. Per-user isolation: every query is scoped by `owner`
// (the JWT username), enforced server-side, never by the client.

'use strict';

const mongoose = require('mongoose');

const EncryptedBlobSchema = new mongoose.Schema({
    packed: { type: String, required: true },
    sha256Hex: { type: String, required: true },
    saltB64: { type: String, required: true }
}, { _id: false });

const FlowSkillSchema = new mongoose.Schema({
    owner: { type: String, required: true, index: true },
    flowId: { type: String, required: true },
    projectId: { type: String, default: '' },
    name: { type: String, required: true },
    dslVersion: { type: Number, required: true },
    registryVersion: { type: Number, required: true },
    version: { type: Number, required: true },
    baseVersionHash: { type: String, default: '' },
    contentHash: { type: String, required: true },
    permissions: { type: [String], default: [] },
    triggerTypes: { type: [String], default: [] },
    actionNames: { type: [String], default: [] },
    // Project variable NAMES only (which variables a flow needs) — never
    // values. Added in the P13 fix round (F-01): the app wire carries
    // this key and the validator allowlists it, so it must persist.
    variableNames: { type: [String], default: [] },
    isTemplate: { type: Boolean, default: false },
    encryptedBlob: { type: EncryptedBlobSchema, required: true },
    syncEnabled: { type: Boolean, default: true },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now }
});

FlowSkillSchema.index({ owner: 1, flowId: 1 }, { unique: true });

module.exports = mongoose.models.FlowSkill || mongoose.model('FlowSkill', FlowSkillSchema);
