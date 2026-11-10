// Flow Engine X P13 — Cross-Device Synchronization: route handlers.
// /api/flow/* — the transport E2/E4/E5 wait on. The server is a dumb,
// opaque store with per-user isolation: it keeps allowlisted metadata
// + an encrypted blob it can never read (user-held key; the passphrase
// never leaves the device). It NEVER accepts, stores, or logs a
// secret, credential, message body, or recipient display field — any
// request carrying one is a 400 and nothing is stored.
//
// Auth: authenticateUser JWT on every route (wired in flowSyncRoutes.js).
// Owner identity is req.user.username, read server-side — a client can
// only ever see its own records plus records explicitly shared with it.
// Conflict: push carries baseVersionHash; when the server head moved,
// the push is a 409 with the server version + hash — never a silent
// overwrite, never last-writer-wins. Rate limit: 20/min per user on
// the route (same shape as the P2 flow/generate bucket).
//
// Testability: handlers are built by createFlowSyncHandlers(deps) so
// contract tests inject fake models without a running server or Mongo.
// The exported handlers are the same factory called with the real deps.

'use strict';

const FlowSkill = require('../models/FlowSkill');
const FlowShare = require('../models/FlowShare');
const FlowWorkspace = require('../models/FlowWorkspace');
const FlowMembership = require('../models/FlowMembership');
const FlowReview = require('../models/FlowReview');
const FlowVersion = require('../models/FlowVersion');
const { connectToDatabase } = require('../config/db');

const MAX_BLOB_CHARS = 1000000;
const MAX_NAME_CHARS = 80;
const MAX_NOTE_CHARS = 500;
const ROLES = ['Owner', 'Administrator', 'Developer', 'Reviewer', 'Viewer'];
const REVIEW_DECISIONS = ['approve', 'request-changes'];

// Plaintext metadata allowlist — the ONLY metadata keys a push may carry.
const ALLOWED_METADATA_KEYS = new Set([
    'flowId', 'projectId', 'name', 'dslVersion', 'registryVersion',
    'version', 'baseVersionHash', 'contentHash', 'permissions',
    'triggerTypes', 'actionNames', 'variableNames'
]);
const ALLOWED_BLOB_KEYS = new Set(['packed', 'sha256Hex', 'saltB64']);
// Field names that must never appear anywhere in a sync request.
const BANNED_KEYS = new Set([
    'password', 'passwd', 'token', 'secret', 'apikey', 'api_key',
    'credential', 'credentials', 'messagebody', 'message_body', 'body',
    'recipient', 'displayname', 'display_name', 'phone', 'email', 'otp', 'pin'
]);

function hasBannedKey(value) {
    if (value === null || typeof value !== 'object') return false;
    for (const key of Object.keys(value)) {
        if (BANNED_KEYS.has(String(key).toLowerCase())) return true;
        if (hasBannedKey(value[key])) return true;
    }
    return false;
}

function isNonEmptyString(v, max) {
    return typeof v === 'string' && v.trim().length > 0 && (max === undefined || v.length <= max);
}
function isStringArray(v, maxItems) {
    return Array.isArray(v) && v.length <= (maxItems || 50) &&
        v.every((x) => typeof x === 'string');
}
function isSha256Hex(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
}

/** Validate a push body. Returns an error string, or null when valid. */
function validatePushBody(body) {
    if (!body || typeof body !== 'object') return 'Body required.';
    if (hasBannedKey(body)) return 'Banned field in sync payload.';
    const m = body.metadata;
    const b = body.encryptedBlob;
    if (!m || typeof m !== 'object') return 'metadata required.';
    if (!b || typeof b !== 'object') return 'encryptedBlob required.';
    for (const key of Object.keys(m)) {
        if (!ALLOWED_METADATA_KEYS.has(key)) return `Unknown metadata field: ${key}.`;
    }
    for (const key of Object.keys(b)) {
        if (!ALLOWED_BLOB_KEYS.has(key)) return `Unknown encryptedBlob field: ${key}.`;
    }
    if (!isNonEmptyString(m.flowId, 128)) return 'flowId required.';
    if (!isNonEmptyString(m.name, MAX_NAME_CHARS)) return 'name required.';
    if (!Number.isInteger(m.dslVersion) || m.dslVersion < 1 || m.dslVersion > 100) return 'dslVersion invalid.';
    if (!Number.isInteger(m.registryVersion) || m.registryVersion < 1 || m.registryVersion > 100) return 'registryVersion invalid.';
    if (!Number.isInteger(m.version) || m.version < 1) return 'version invalid.';
    if (typeof m.baseVersionHash !== 'string') return 'baseVersionHash required.';
    if (!isSha256Hex(m.contentHash)) return 'contentHash must be sha256 hex.';
    if (m.projectId !== undefined && typeof m.projectId !== 'string') return 'projectId invalid.';
    if (m.permissions !== undefined && !isStringArray(m.permissions)) return 'permissions invalid.';
    if (m.triggerTypes !== undefined && !isStringArray(m.triggerTypes)) return 'triggerTypes invalid.';
    if (m.actionNames !== undefined && !isStringArray(m.actionNames)) return 'actionNames invalid.';
    if (m.variableNames !== undefined && !isStringArray(m.variableNames)) return 'variableNames invalid.';
    if (!isNonEmptyString(b.packed, MAX_BLOB_CHARS)) return 'encryptedBlob.packed required.';
    if (!isSha256Hex(b.sha256Hex)) return 'encryptedBlob.sha256Hex must be sha256 hex.';
    if (!isNonEmptyString(b.saltB64, 64)) return 'encryptedBlob.saltB64 required.';
    return null;
}

/** Public view of a skill: metadata + opaque blob, no internals. */
function publicSkill(doc) {
    const s = doc && doc.toObject ? doc.toObject() : doc;
    return {
        owner: s.owner, flowId: s.flowId, projectId: s.projectId, name: s.name,
        dslVersion: s.dslVersion, registryVersion: s.registryVersion,
        version: s.version, baseVersionHash: s.baseVersionHash,
        contentHash: s.contentHash, permissions: s.permissions || [],
        triggerTypes: s.triggerTypes || [], actionNames: s.actionNames || [],
        variableNames: s.variableNames || [],
        isTemplate: !!s.isTemplate, encryptedBlob: s.encryptedBlob,
        updatedAt: s.updatedAt
    };
}

/** Metadata-only view (list endpoints): no blob, no internals. */
function metadataOnly(doc) {
    const s = publicSkill(doc);
    delete s.encryptedBlob;
    return s;
}

function createFlowSyncHandlers(deps) {
    const Skill = deps.FlowSkill;
    const Share = deps.FlowShare;
    const Workspace = deps.FlowWorkspace;
    const Membership = deps.FlowMembership;
    const Review = deps.FlowReview;
    const Version = deps.FlowVersion;
    const connect = deps.connectToDatabase;

    async function dbOr503(res) {
        try {
            await connect();
            return true;
        } catch (_) {
            res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
            return false;
        }
    }
    function ownerOf(req) {
        return req.user && req.user.username ? req.user.username : null;
    }

    async function pushFlow(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const err = validatePushBody(req.body);
        if (err) return res.status(400).json({ success: false, error: err });
        const m = req.body.metadata;
        const b = req.body.encryptedBlob;
        let existing = null;
        try {
            existing = await Skill.findOne({ owner, flowId: m.flowId });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        // Conflict: the head moved since the editor's base — refuse, never overwrite.
        if (existing && m.baseVersionHash !== existing.contentHash) {
            return res.status(409).json({
                success: false, error: 'conflict',
                serverVersion: existing.version, serverHash: existing.contentHash,
                serverUpdatedAt: existing.updatedAt
            });
        }
        const newVersion = (existing ? existing.version : 0) + 1;
        const now = Date.now();
        const fields = {
            owner, flowId: m.flowId, projectId: m.projectId || '',
            name: m.name, dslVersion: m.dslVersion, registryVersion: m.registryVersion,
            version: newVersion, baseVersionHash: m.baseVersionHash,
            contentHash: m.contentHash, permissions: m.permissions || [],
            triggerTypes: m.triggerTypes || [], actionNames: m.actionNames || [],
            variableNames: m.variableNames || [],
            encryptedBlob: { packed: b.packed, sha256Hex: b.sha256Hex, saltB64: b.saltB64 },
            syncEnabled: true, updatedAt: now
        };
        try {
            if (existing) {
                await Skill.updateOne({ owner, flowId: m.flowId }, { $set: fields });
            } else {
                await Skill.create({ ...fields, isTemplate: false, createdAt: now });
            }
            await Version.create({
                owner, flowId: m.flowId, version: newVersion,
                contentHash: m.contentHash, dslVersion: m.dslVersion,
                encryptedBlob: { packed: b.packed, sha256Hex: b.sha256Hex, saltB64: b.saltB64 },
                createdAt: now
            });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true, version: newVersion, contentHash: m.contentHash });
    }

    async function pullFlow(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const flowId = req.params && req.params.flowId;
        if (!isNonEmptyString(flowId, 128)) {
            return res.status(400).json({ success: false, error: 'flowId required.' });
        }
        let skill = null;
        try {
            skill = await Skill.findOne({ owner, flowId });
            if (!skill) {
                // Explicitly shared with this user? Then the owner's copy is readable.
                const share = await Share.findOne({ flowId, sharedWith: owner });
                if (share) skill = await Skill.findOne({ owner: share.owner, flowId });
            }
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        if (!skill) return res.status(404).json({ success: false, error: 'Flow not found.' });
        return res.json({ success: true, skill: publicSkill(skill) });
    }

    async function listFlows(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        let rows = [];
        try {
            rows = await Skill.find({ owner });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true, flows: rows.map(metadataOnly) });
    }

    async function listSharedWithMe(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        let out = [];
        try {
            const shares = await Share.find({ sharedWith: owner });
            for (const share of shares) {
                const skill = await Skill.findOne({ owner: share.owner, flowId: share.flowId });
                if (skill) out.push(metadataOnly(skill));
            }
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true, flows: out });
    }

    async function shareFlow(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const body = req.body || {};
        if (hasBannedKey(body)) return res.status(400).json({ success: false, error: 'Banned field in sync payload.' });
        if (!isNonEmptyString(body.flowId, 128) || !isNonEmptyString(body.sharedWith, 128)) {
            return res.status(400).json({ success: false, error: 'flowId and sharedWith required.' });
        }
        if (body.sharedWith === owner) {
            return res.status(400).json({ success: false, error: 'Cannot share with yourself.' });
        }
        try {
            const skill = await Skill.findOne({ owner, flowId: body.flowId });
            if (!skill) return res.status(404).json({ success: false, error: 'Flow not found.' });
            const existing = await Share.findOne({ owner, flowId: body.flowId, sharedWith: body.sharedWith });
            if (existing) return res.json({ success: true, alreadyShared: true });
            await Share.create({ owner, flowId: body.flowId, sharedWith: body.sharedWith, createdAt: Date.now() });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true });
    }

    async function publishTemplate(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const body = req.body || {};
        if (!isNonEmptyString(body.flowId, 128)) {
            return res.status(400).json({ success: false, error: 'flowId required.' });
        }
        try {
            const skill = await Skill.findOne({ owner, flowId: body.flowId });
            if (!skill) return res.status(404).json({ success: false, error: 'Flow not found.' });
            await Skill.updateOne({ owner, flowId: body.flowId }, { $set: { isTemplate: true } });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true });
    }

    async function listTemplates(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        // Scoped, never public (P13 fix round, F-03): templates the caller
        // owns, OR templates of flows explicitly shared with the caller.
        // A stranger lists nothing — there is no public listing.
        let rows = [];
        try {
            const owned = await Skill.find({ owner, isTemplate: true });
            const shares = await Share.find({ sharedWith: owner });
            rows = owned.slice();
            for (const share of shares) {
                const skill = await Skill.findOne({ owner: share.owner, flowId: share.flowId });
                if (skill && skill.isTemplate &&
                    !rows.some((r) => String(r.owner) === String(skill.owner) &&
                        String(r.flowId) === String(skill.flowId))) {
                    rows.push(skill);
                }
            }
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true, templates: rows.map(metadataOnly) });
    }

    async function reviewTemplate(req, res) {
        if (!(await dbOr503(res))) return;
        const reviewer = ownerOf(req);
        if (!reviewer) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const body = req.body || {};
        const flowId = req.params && req.params.flowId;
        if (hasBannedKey(body)) return res.status(400).json({ success: false, error: 'Banned field in sync payload.' });
        if (!isNonEmptyString(flowId, 128)) {
            return res.status(400).json({ success: false, error: 'flowId required.' });
        }
        if (!REVIEW_DECISIONS.includes(body.decision)) {
            return res.status(400).json({ success: false, error: 'decision must be approve or request-changes.' });
        }
        if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > MAX_NOTE_CHARS)) {
            return res.status(400).json({ success: false, error: 'note too long (max 500 chars).' });
        }
        try {
            const skill = await Skill.findOne({ flowId, isTemplate: true });
            if (!skill) return res.status(404).json({ success: false, error: 'Template not found.' });
            await Review.create({
                flowId, reviewer, decision: body.decision,
                note: body.note || '', createdAt: Date.now()
            });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true });
    }

    async function createWorkspace(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const body = req.body || {};
        if (!isNonEmptyString(body.name, MAX_NAME_CHARS)) {
            return res.status(400).json({ success: false, error: 'name required.' });
        }
        let ws = null;
        try {
            ws = await Workspace.create({ owner, name: body.name, createdAt: Date.now() });
            const id = ws._id ? String(ws._id) : ws.id;
            await Membership.create({ workspaceId: id, user: owner, role: 'Owner', createdAt: Date.now() });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        const id = ws._id ? String(ws._id) : ws.id;
        return res.json({ success: true, workspaceId: id });
    }

    async function addMember(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        const body = req.body || {};
        const workspaceId = req.params && req.params.id;
        if (!isNonEmptyString(workspaceId, 128)) {
            return res.status(400).json({ success: false, error: 'workspaceId required.' });
        }
        if (!isNonEmptyString(body.user, 128) || !ROLES.includes(body.role)) {
            return res.status(400).json({ success: false, error: 'user and a valid role required.' });
        }
        try {
            const ws = await Workspace.findOne({ _id: workspaceId });
            if (!ws) return res.status(404).json({ success: false, error: 'Workspace not found.' });
            if (ws.owner !== owner) {
                return res.status(403).json({ success: false, error: 'Only the workspace owner adds members.' });
            }
            const existing = await Membership.findOne({ workspaceId, user: body.user });
            if (existing) return res.json({ success: true, alreadyMember: true });
            await Membership.create({ workspaceId, user: body.user, role: body.role, createdAt: Date.now() });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({ success: true });
    }

    async function listWorkspaces(req, res) {
        if (!(await dbOr503(res))) return;
        const owner = ownerOf(req);
        if (!owner) return res.status(401).json({ success: false, error: 'Unauthorized.' });
        let out = [];
        try {
            const owned = await Workspace.find({ owner });
            const memberships = await Membership.find({ user: owner });
            out = owned.slice();
            for (const m of memberships) {
                const ws = await Workspace.findOne({ _id: m.workspaceId });
                if (ws && !out.some((o) => String(o._id || o.id) === String(ws._id || ws.id))) out.push(ws);
            }
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        return res.json({
            success: true,
            workspaces: out.map((w) => ({ workspaceId: String(w._id || w.id), owner: w.owner, name: w.name }))
        });
    }

    return {
        pushFlow, pullFlow, listFlows, listSharedWithMe, shareFlow,
        publishTemplate, listTemplates, reviewTemplate,
        createWorkspace, addMember, listWorkspaces
    };
}

const handlers = createFlowSyncHandlers({
    FlowSkill, FlowShare, FlowWorkspace, FlowMembership, FlowReview, FlowVersion,
    connectToDatabase
});

module.exports = { ...handlers, createFlowSyncHandlers, validatePushBody };
