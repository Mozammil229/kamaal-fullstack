// Flow Engine X P13 — workspace membership + role (E2 roles:
// Owner / Administrator / Developer / Reviewer / Viewer — plan C11).
// One row per (workspace, user). The workspace owner is also a member
// (role Owner) so every access check reads this one collection.

'use strict';

const mongoose = require('mongoose');

const FlowMembershipSchema = new mongoose.Schema({
    workspaceId: { type: String, required: true, index: true },
    user: { type: String, required: true, index: true },
    role: {
        type: String, required: true,
        enum: ['Owner', 'Administrator', 'Developer', 'Reviewer', 'Viewer']
    },
    createdAt: { type: Number, default: Date.now }
});

FlowMembershipSchema.index({ workspaceId: 1, user: 1 }, { unique: true });

module.exports = mongoose.models.FlowMembership || mongoose.model('FlowMembership', FlowMembershipSchema);
