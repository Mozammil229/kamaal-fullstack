// Flow Engine X P13 — review of a published shared template (§15 /
// §16.3). Advisory only in P13: only the OWNER publishes a template;
// any authenticated user may review a public template. `note` is a
// short review comment (max 500 chars) — never a message body, never
// a recipient field. No decision here auto-publishes anything.

'use strict';

const mongoose = require('mongoose');

const FlowReviewSchema = new mongoose.Schema({
    flowId: { type: String, required: true, index: true },
    reviewer: { type: String, required: true },
    decision: { type: String, required: true, enum: ['approve', 'request-changes'] },
    note: { type: String, default: '', maxlength: 500 },
    createdAt: { type: Number, default: Date.now }
});

FlowReviewSchema.index({ flowId: 1, reviewer: 1 });

module.exports = mongoose.models.FlowReview || mongoose.model('FlowReview', FlowReviewSchema);
