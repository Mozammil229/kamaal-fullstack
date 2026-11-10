// Flow Engine X P13 — team workspace (E2 groundwork). A workspace
// groups synced flows for a team; membership + roles live in the
// separate FlowMembership collection. No member display data here.

'use strict';

const mongoose = require('mongoose');

const FlowWorkspaceSchema = new mongoose.Schema({
    owner: { type: String, required: true, index: true },
    name: { type: String, required: true },
    createdAt: { type: Number, default: Date.now }
});

FlowWorkspaceSchema.index({ owner: 1, name: 1 });

module.exports = mongoose.models.FlowWorkspace || mongoose.model('FlowWorkspace', FlowWorkspaceSchema);
