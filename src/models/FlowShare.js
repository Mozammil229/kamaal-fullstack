// Flow Engine X P13 — share grant: owner shares one synced flow with
// one other user (read-only pull). The recipient's copy lands DISABLED
// on their device and cannot run until they save + toggle it (E2 rule).
// No display names, no message bodies — ids only.

'use strict';

const mongoose = require('mongoose');

const FlowShareSchema = new mongoose.Schema({
    owner: { type: String, required: true, index: true },
    flowId: { type: String, required: true },
    sharedWith: { type: String, required: true, index: true },
    createdAt: { type: Number, default: Date.now }
});

FlowShareSchema.index({ owner: 1, flowId: 1, sharedWith: 1 }, { unique: true });

module.exports = mongoose.models.FlowShare || mongoose.model('FlowShare', FlowShareSchema);
