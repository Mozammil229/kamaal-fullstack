const mongoose = require('mongoose');

// MULTI-AGENT P1 — audit_events: the append-only trail (Req 7, built FIRST).
//
// Every agent action is logged: actor, action, sanitized inputs, result,
// evidence ref, timestamp. Conventions (DATA-MODEL.md):
// - timestamps stored UTC (tsUtc), displayed PKT 12-hour by readers;
// - evidence_ref points at artifacts (ledger paths, Drive file ids, session
//   ids) — NEVER inline secrets;
// - actor is always one of the five agent voices (never blended) — enforced
//   by the enum below;
// - APPEND-ONLY: there are no update/delete API routes, and the schema
//   pre-hooks below reject any update/delete operation at the model layer
//   (defense in depth — a future route cannot silently mutate history).
// - NO PII/secrets inside inputs or result — the controller sanitizes before
//   insert (see opsController.sanitizeInputs); the BugHunter P1 gate checks
//   this property explicitly.
const OpsAuditEventSchema = new mongoose.Schema({
    // Ties every event to one run (runs._id). Optional: ad-hoc actions that
    // are not part of a tracked run may omit it.
    correlationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actor: {
        type: String,
        required: true,
        enum: ['mozammil', 'ptagdam', 'bughunter', 'reviewer', 'rough']
    },
    action: { type: String, required: true, maxlength: 120 },
    // Sanitized object — NEVER secrets/credentials/PII (controller-enforced).
    inputs: { type: mongoose.Schema.Types.Mixed, default: {} },
    // 'ok' · 'fail' · 'blocked' + one-line detail. Sanitized like inputs.
    result: { type: String, required: true, maxlength: 2000 },
    evidenceRef: { type: String, default: '', maxlength: 500 },
    tsUtc: { type: Date, default: Date.now, index: false }
});

// Query patterns: per-run trail, per-actor history, per-action history.
OpsAuditEventSchema.index({ correlationId: 1, tsUtc: 1 });
OpsAuditEventSchema.index({ actor: 1, tsUtc: -1 });
OpsAuditEventSchema.index({ action: 1, tsUtc: -1 });

// Append-only guard: reject every mutation path at the model layer.
const APPEND_ONLY_ERR = 'OpsAuditEvent is append-only: updates and deletes are rejected';
for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
    OpsAuditEventSchema.pre(hook, function (next) {
        next(new Error(APPEND_ONLY_ERR));
    });
}
for (const hook of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
    OpsAuditEventSchema.pre(hook, function (next) {
        next(new Error(APPEND_ONLY_ERR));
    });
}

module.exports = mongoose.models.OpsAuditEvent || mongoose.model('OpsAuditEvent', OpsAuditEventSchema);
