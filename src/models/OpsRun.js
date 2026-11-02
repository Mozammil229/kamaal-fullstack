const mongoose = require('mongoose');

// MULTI-AGENT P1 — runs: SKELETON (minimal fields to start; P5/P6 add QA
// ingestion + attempt history + retry policy).
//
// Replaces today's build ledgers + suite per-script results + subagent
// execution records. One run = one execution; its _id doubles as the
// correlation_id across audit_events (verify-before-relay identity bundle
// lives in artifacts for build kinds).
const OpsRunStepSchema = new mongoose.Schema({
    name: { type: String, required: true },
    exitCode: { type: Number, default: null },
    logRef: { type: String, default: '' }
}, { _id: false });

const OpsRunSchema = new mongoose.Schema({
    // → tasks._id; null for cron runs and ad-hoc runs.
    taskId: { type: mongoose.Schema.Types.ObjectId, default: null },
    kind: {
        type: String,
        required: true,
        enum: ['build', 'test-suite', 'gate', 'agent', 'delivery', 'cron', 'audit']
    },
    agent: { type: String, default: '', maxlength: 40 },
    status: {
        type: String,
        enum: ['running', 'succeeded', 'failed', 'interrupted'],
        default: 'running'
    },
    startedUtc: { type: Date, default: Date.now },
    finishedUtc: { type: Date, default: null },
    // Per-step exits (Phase-13 lesson: never trust a finalize after a failed
    // compile — every step's own exit code is recorded).
    steps: { type: [OpsRunStepSchema], default: [] },
    // Build identity bundle {apk_size, md5, sha256, drive_id, drive_name,
    // version} or gate/suite verdict text ('97/97 scripts exit 0').
    artifacts: { type: mongoose.Schema.Types.Mixed, default: null },
    verdict: { type: String, default: '', maxlength: 300 },
    // True when the report came from session jsonl, not a live handoff
    // (standing handoff-recovery lesson).
    handoffRecovered: { type: Boolean, default: false }
});

OpsRunSchema.index({ taskId: 1, startedUtc: -1 });
OpsRunSchema.index({ kind: 1, status: 1 });
OpsRunSchema.index({ startedUtc: -1 });

module.exports = mongoose.models.OpsRun || mongoose.model('OpsRun', OpsRunSchema);
