const mongoose = require('mongoose');

// MULTI-AGENT P1 — tasks: SKELETON (minimal fields to start; P2 adds the
// queue + state machine + assignment + dependencies).
//
// Replaces today's todo.write lists. State machine (enforced in app logic
// from P2 on): queued → in_progress → gated → done · → failed · → blocked
// (blocked = waiting on approval/handoff; exactly-one-in_progress per the
// standing todo-tool rule).
const OpsTaskSchema = new mongoose.Schema({
    // → projects._id once the projects collection lands (P3); null until then.
    projectId: { type: mongoose.Schema.Types.ObjectId, default: null },
    title: { type: String, required: true, maxlength: 300 },
    phase: { type: String, default: '', maxlength: 40 },
    status: {
        type: String,
        enum: ['queued', 'in_progress', 'blocked', 'gated', 'done', 'failed'],
        default: 'queued'
    },
    assignee: { type: String, default: '', maxlength: 40 },
    gateRequired: { type: Boolean, default: false },
    gateVerdict: { type: String, enum: ['SHIP', 'DO-NOT-SHIP'], default: undefined },
    evidenceRefs: { type: [String], default: [] },
    createdUtc: { type: Date, default: Date.now },
    updatedUtc: { type: Date, default: Date.now }
});

OpsTaskSchema.index({ status: 1 });
OpsTaskSchema.index({ assignee: 1, status: 1 });

module.exports = mongoose.models.OpsTask || mongoose.model('OpsTask', OpsTaskSchema);
