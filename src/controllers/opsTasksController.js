// MULTI-AGENT P2 — task coordination backend: task queue + state machine,
// agent assignment, dependencies, per-agent inbox API.
//
// State machine (enforced in app logic, never trusted from the client):
//   queued → in_progress → gated → done
//   any → failed · any → blocked · blocked → queued/in_progress · failed → queued
// Gate rules: gateRequired tasks MUST pass through `gated`; `gated → done`
// requires gateVerdict === 'SHIP'. A `failed` dependency makes dependents
// visibly blocked (computed `blockedBy`, never stored).
//
// P1 HARDENING (unchanged): sanitizeInputs on every persisted input,
// append-only audit trail (every mutation logs an OpsAuditEvent with the
// task _id as correlationId), timing-safe auth (opsAuth in opsRoutes.js),
// mount before socialRoutes (app.js — untouched), no new dependencies.
//
// AUTH: opsAuth lives in opsRoutes.js (internal key OR admin JWT) — same as P1.
const mongoose = require('mongoose');
const OpsTask = require('../models/OpsTask');
const OpsAuditEvent = require('../models/OpsAuditEvent');
const { sanitizeInputs, redactString, ACTORS } = require('./opsController');

// ---- State machine (pure — unit-tested without a DB) -------------------
const TASK_STATUSES = ['queued', 'in_progress', 'blocked', 'gated', 'done', 'failed'];

// Allowed edges. done is terminal. failed can be re-queued (retry).
const TRANSITIONS = {
    queued: ['in_progress', 'blocked', 'failed'],
    in_progress: ['gated', 'done', 'failed', 'blocked'],
    gated: ['done', 'failed', 'blocked'],
    blocked: ['queued', 'in_progress', 'failed'],
    failed: ['queued'],
    done: []
};

// Returns { ok: true } or { ok: false, reason }.
function canTransition(from, to, task) {
    if (!TASK_STATUSES.includes(from) || !TASK_STATUSES.includes(to)) {
        return { ok: false, reason: `Unknown status in transition: ${from} → ${to}.` };
    }
    if (!(TRANSITIONS[from] || []).includes(to)) {
        return { ok: false, reason: `Invalid transition: ${from} → ${to}.` };
    }
    const gateRequired = !!(task && task.gateRequired);
    const verdict = task && task.gateVerdict;
    // Gate rules (P2 acceptance: the full lifecycle runs through the gate).
    if (from === 'in_progress' && to === 'done' && gateRequired) {
        return { ok: false, reason: 'Gate required: task must go through gated status first.' };
    }
    if (from === 'in_progress' && to === 'gated' && !gateRequired) {
        return { ok: false, reason: 'No gate required: transition directly to done.' };
    }
    if (from === 'gated' && to === 'done' && verdict !== 'SHIP') {
        return { ok: false, reason: 'Cannot complete: gate verdict must be SHIP.' };
    }
    return { ok: true };
}

// Visible blocking (P2 acceptance): which FAILED dependencies block this task.
// Pure — takes the task plus its resolved dependency docs {_id,title,status}.
function computeBlockedBy(task, depDocs) {
    const out = [];
    for (const d of depDocs || []) {
        if (d && d.status === 'failed') {
            out.push({
                _id: String(d._id),
                title: d.title || '',
                status: 'failed'
            });
        }
    }
    return out;
}

function opErrorJson(err, message) {
    const detail = process.env.NODE_ENV === 'production'
        ? undefined
        : (err && err.message ? String(err.message).slice(0, 200) : undefined);
    return { success: false, error: message, ...(detail ? { detail } : {}) };
}

function bad(res, code, error) {
    return res.status(code).json({ success: false, error });
}

function toObjectIdOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    if (!mongoose.Types.ObjectId.isValid(v)) return undefined; // sentinel: invalid
    return new mongoose.Types.ObjectId(v);
}

// Every P2 mutation appends to the P1 audit trail. correlationId = task _id
// ties the task's full history together (create → transitions → gate → done).
async function logTaskEvent({ taskId, actor, action, inputs, result, evidenceRef }) {
    await OpsAuditEvent.create({
        correlationId: taskId,
        actor,
        action: String(action).slice(0, 120),
        inputs: sanitizeInputs(inputs),
        result: redactString(String(result)).slice(0, 2000),
        evidenceRef: redactString(String(evidenceRef || '')).slice(0, 500),
        tsUtc: new Date() // ALWAYS server-set (P1 rule)
    });
}

function validateActor(actor) {
    if (!actor || !ACTORS.includes(actor)) {
        return `Invalid actor: must be one of ${ACTORS.join(', ')}.`;
    }
    return null;
}

function validateAssignee(assignee) {
    if (assignee === undefined || assignee === null || assignee === '') return null; // unassign ok
    if (!ACTORS.includes(assignee)) {
        return `Invalid assignee: must be one of ${ACTORS.join(', ')} or empty.`;
    }
    return null;
}

// Attach computed blockedBy to lean task docs (single batched dependency fetch).
async function withBlockedBy(tasks) {
    const ids = new Set();
    for (const t of tasks) {
        for (const d of (t.dependsOn || [])) ids.add(String(d));
    }
    const depMap = {};
    if (ids.size) {
        const deps = await OpsTask
            .find({ _id: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } })
            .select('_id title status')
            .lean();
        for (const d of deps) depMap[String(d._id)] = d;
    }
    return tasks.map((t) => ({
        ...t,
        dependsOn: (t.dependsOn || []).map(String),
        blockedBy: computeBlockedBy(
            t,
            (t.dependsOn || []).map((id) => depMap[String(id)]).filter(Boolean)
        )
    }));
}

// POST /api/ops/tasks — create a task (always starts queued).
// Body: { actor, title, phase?, assignee?, gateRequired?, dependsOn?, projectId?, evidenceRefs? }
async function postTask(req, res) {
    try {
        const b = req.body || {};
        const actorErr = validateActor(b.actor);
        if (actorErr) return bad(res, 400, actorErr);
        // P1 hardening: sanitize ALL persisted inputs (titles are shown on the
        // future task board — PII/secrets must never land in the DB).
        const title = redactString(String(b.title || '').trim());
        if (!title) return bad(res, 400, 'Missing required field: title.');
        if (title.length > 300) return bad(res, 400, 'Title too long: max 300 chars.');
        const assigneeErr = validateAssignee(b.assignee);
        if (assigneeErr) return bad(res, 400, assigneeErr);

        let projectId = null;
        if (b.projectId !== undefined && b.projectId !== null && b.projectId !== '') {
            projectId = toObjectIdOrNull(b.projectId);
            if (projectId === undefined) return bad(res, 400, 'Invalid projectId: must be an ObjectId.');
        }

        const dependsOn = [];
        if (b.dependsOn !== undefined && b.dependsOn !== null) {
            if (!Array.isArray(b.dependsOn)) return bad(res, 400, 'dependsOn must be an array of task ids.');
            if (b.dependsOn.length > 50) return bad(res, 400, 'dependsOn too long: max 50 dependencies.');
            for (const dep of b.dependsOn) {
                const oid = toObjectIdOrNull(dep);
                if (oid === undefined) return bad(res, 400, `Invalid dependsOn entry: ${String(dep).slice(0, 40)}.`);
                dependsOn.push(oid);
            }
        }

        const doc = await OpsTask.create({
            projectId,
            title,
            phase: redactString(String(b.phase || '')).slice(0, 40),
            status: 'queued',
            assignee: b.assignee || '',
            dependsOn,
            gateRequired: !!b.gateRequired,
            evidenceRefs: Array.isArray(b.evidenceRefs)
                ? b.evidenceRefs.map((e) => redactString(String(e)).slice(0, 500)).slice(0, 50)
                : [],
            createdUtc: new Date(),
            updatedUtc: new Date()
        });

        await logTaskEvent({
            taskId: doc._id,
            actor: b.actor,
            action: 'task.create',
            inputs: { title, assignee: b.assignee || '', gateRequired: !!b.gateRequired, dependsOn: dependsOn.map(String) },
            result: 'ok: task queued',
            evidenceRef: b.evidenceRef
        });

        const [withBlock] = await withBlockedBy([doc.toObject()]);
        return res.status(201).json({ success: true, task: withBlock });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to create task.'));
    }
}

// GET /api/ops/tasks — list tasks. Filters: ?status=&assignee=&limit=
async function getTasks(req, res) {
    try {
        const q = {};
        if (req.query.status) {
            if (!TASK_STATUSES.includes(req.query.status)) {
                return bad(res, 400, `Invalid status filter: must be one of ${TASK_STATUSES.join(', ')}.`);
            }
            q.status = req.query.status;
        }
        if (req.query.assignee) {
            if (!ACTORS.includes(req.query.assignee)) {
                return bad(res, 400, `Invalid assignee filter: must be one of ${ACTORS.join(', ')}.`);
            }
            q.assignee = req.query.assignee;
        }
        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 50;
        limit = Math.min(limit, 500);

        const tasks = await OpsTask.find(q).sort({ updatedUtc: -1 }).limit(limit).lean();
        return res.json({ success: true, count: tasks.length, tasks: await withBlockedBy(tasks) });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to list tasks.'));
    }
}

// GET /api/ops/tasks/:id — one task + visible blocking + recent audit trail.
async function getTask(req, res) {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return bad(res, 400, 'Invalid task id.');
        }
        const task = await OpsTask.findById(req.params.id).lean();
        if (!task) return bad(res, 404, 'Task not found.');
        const [withBlock] = await withBlockedBy([task]);
        const history = await OpsAuditEvent
            .find({ correlationId: task._id })
            .sort({ tsUtc: 1 })
            .limit(50)
            .lean();
        return res.json({ success: true, task: withBlock, history });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to read task.'));
    }
}

// PATCH /api/ops/tasks/:id — mutate a task.
// Body: { actor, status?, assignee?, gateVerdict?, title?, phase?,
//         dependsOn?, evidenceRefs?, evidenceRef? }
// Status changes go through the state machine; gate rules enforced.
// Every successful mutation appends one audit event.
async function patchTask(req, res) {
    try {
        const b = req.body || {};
        const actorErr = validateActor(b.actor);
        if (actorErr) return bad(res, 400, actorErr);
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return bad(res, 400, 'Invalid task id.');
        }
        const task = await OpsTask.findById(req.params.id);
        if (!task) return bad(res, 404, 'Task not found.');

        const changes = {};   // persisted mutations
        const auditInputs = {}; // sanitized log inputs

        // --- status transition (state machine) ---
        if (b.status !== undefined && b.status !== null && b.status !== '') {
            const to = String(b.status);
            const check = canTransition(task.status, to, task);
            if (!check.ok) return bad(res, 400, check.reason);
            changes.status = to;
            auditInputs.status = `${task.status} → ${to}`;
            if (to === 'done' && !task.doneUtc) changes.doneUtc = new Date();
        }

        // --- gate verdict (only meaningful on gated tasks) ---
        if (b.gateVerdict !== undefined && b.gateVerdict !== null && b.gateVerdict !== '') {
            const v = String(b.gateVerdict);
            if (!['SHIP', 'DO-NOT-SHIP'].includes(v)) {
                return bad(res, 400, 'Invalid gateVerdict: must be SHIP or DO-NOT-SHIP.');
            }
            const effectiveStatus = changes.status || task.status;
            if (effectiveStatus !== 'gated') {
                return bad(res, 400, 'gateVerdict can only be set on a gated task.');
            }
            changes.gateVerdict = v;
            auditInputs.gateVerdict = v;
        }

        // --- assignment ---
        if (b.assignee !== undefined) {
            const assigneeErr = validateAssignee(b.assignee);
            if (assigneeErr) return bad(res, 400, assigneeErr);
            if ((b.assignee || '') !== task.assignee) {
                changes.assignee = b.assignee || '';
                auditInputs.assignee = changes.assignee || '(unassigned)';
            }
        }

        // --- dependencies (additive replace; never self-reference) ---
        if (b.dependsOn !== undefined && b.dependsOn !== null) {
            if (!Array.isArray(b.dependsOn)) return bad(res, 400, 'dependsOn must be an array of task ids.');
            if (b.dependsOn.length > 50) return bad(res, 400, 'dependsOn too long: max 50 dependencies.');
            const deps = [];
            for (const dep of b.dependsOn) {
                const oid = toObjectIdOrNull(dep);
                if (oid === undefined) return bad(res, 400, `Invalid dependsOn entry: ${String(dep).slice(0, 40)}.`);
                if (String(oid) === String(task._id)) {
                    return bad(res, 400, 'A task cannot depend on itself.');
                }
                deps.push(oid);
            }
            changes.dependsOn = deps;
            auditInputs.dependsOn = deps.map(String);
        }

        // --- light metadata edits ---
        if (b.title !== undefined && b.title !== null && b.title !== '') {
            const title = redactString(String(b.title).trim());
            if (!title) return bad(res, 400, 'Title cannot be blank.');
            if (title.length > 300) return bad(res, 400, 'Title too long: max 300 chars.');
            changes.title = title;
            auditInputs.title = title;
        }
        if (b.phase !== undefined && b.phase !== null) {
            changes.phase = redactString(String(b.phase)).slice(0, 40);
            auditInputs.phase = changes.phase;
        }
        if (b.evidenceRefs !== undefined && b.evidenceRefs !== null) {
            if (!Array.isArray(b.evidenceRefs)) return bad(res, 400, 'evidenceRefs must be an array.');
            changes.evidenceRefs = b.evidenceRefs
                .map((e) => redactString(String(e)).slice(0, 500)).slice(0, 50);
            auditInputs.evidenceRefs = `${changes.evidenceRefs.length} refs`;
        }

        if (!Object.keys(changes).length) {
            return bad(res, 400, 'Nothing to update.');
        }
        changes.updatedUtc = new Date();

        const action = changes.status
            ? `task.transition`
            : (changes.gateVerdict ? 'task.gate' : (changes.assignee !== undefined ? 'task.assign' : 'task.update'));

        Object.assign(task, changes);
        await task.save();

        await logTaskEvent({
            taskId: task._id,
            actor: b.actor,
            action,
            inputs: auditInputs,
            result: 'ok',
            evidenceRef: b.evidenceRef
        });

        const [withBlock] = await withBlockedBy([task.toObject()]);
        return res.json({ success: true, task: withBlock });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to update task.'));
    }
}

// GET /api/ops/inbox/:agent — per-agent inbox: their open tasks.
// Open = queued | in_progress | gated | blocked (done/failed are history).
async function getInbox(req, res) {
    try {
        const agent = String(req.params.agent || '');
        if (!ACTORS.includes(agent)) {
            return bad(res, 400, `Invalid agent: must be one of ${ACTORS.join(', ')}.`);
        }
        const tasks = await OpsTask.find({
            assignee: agent,
            status: { $in: ['queued', 'in_progress', 'gated', 'blocked'] }
        }).sort({ updatedUtc: -1 }).limit(200).lean();
        return res.json({
            success: true,
            agent,
            count: tasks.length,
            tasks: await withBlockedBy(tasks)
        });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to read inbox.'));
    }
}

module.exports = {
    postTask,
    getTasks,
    getTask,
    patchTask,
    getInbox,
    // Pure logic exported for unit tests (no DB).
    canTransition,
    computeBlockedBy,
    TRANSITIONS,
    TASK_STATUSES
};
