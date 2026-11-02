// MULTI-AGENT P1 — audit trail core: POST /api/ops/audit + GET /api/ops/audit.
//
// Every agent action is logged: actor, action, SANITIZED inputs, result,
// evidence ref, timestamp (server-set). The BugHunter P1 gate checks the
// hard rule: NO PII/secrets are ever persisted — see sanitizeInputs below.
//
// AUTH: opsAuth lives in opsRoutes.js (internal key OR admin JWT).
// APPEND-ONLY: there is no update/delete handler here by design, and the
// OpsAuditEvent schema pre-hooks reject mutations at the model layer.
const mongoose = require('mongoose');
const OpsAuditEvent = require('../models/OpsAuditEvent');

const ACTORS = ['mozammil', 'ptagdam', 'bughunter', 'reviewer', 'rough'];
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 10;
const MAX_INPUT_CHARS = 50000;

// ---- Sanitizer (the P1 hard rule) -------------------------------------
// Recursively redacts secrets + PII from anything about to be persisted.
// Key-based: any object key that normalizes (lowercased, _- stripped) to a
// known secret name has its whole value replaced — this catches
// {apiKey: '...'}, {db_password: '...'}, {authToken: '...'} etc. without
// substring false positives ('author' does NOT match).
// Value-based (strings): known secret prefixes + PII shapes (email,
// Pakistani mobile) are redacted wherever they appear, even under an
// innocent key like 'notes'.
const SECRET_KEYS = new Set([
    'token', 'accesstoken', 'refreshtoken', 'idtoken',
    'secret', 'clientsecret', 'apisecret',
    'password', 'passwd', 'pwd',
    'apikey', 'authkey', 'key', 'privatekey',
    'authorization', 'bearer',
    'credential', 'credentials',
    'sessionid', 'sessiontoken', 'jwt',
    'otp', 'pin', 'cvv', 'ssn'
]);
const SECRET_VALUE_PATTERNS = [
    /AIza[0-9A-Za-z_\-]{20,}/g,          // Google API keys
    /gsk_[0-9A-Za-z]{10,}/g,             // Groq keys
    /sk-[A-Za-z0-9]{10,}/g,              // OpenAI-style keys
    /xox[bap]-[A-Za-z0-9\-]{10,}/g,      // Slack-style tokens
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM blocks
    /Bearer\s+[A-Za-z0-9\-._~+/=]{10,}/g  // bearer tokens in prose
];
const PII_VALUE_PATTERNS = [
    // email addresses
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    // Pakistani mobiles: 03XXXXXXXXX, +923XXXXXXXXX, 923XXXXXXXXX
    /(\+?92|0)?3\d{2}[\s-]?\d{7}/g
];

function normalizeKey(k) {
    return String(k).toLowerCase().replace(/[_-]+/g, '');
}

// A key is secret if it normalizes to a known secret name OR any of its
// segments (split on separators + camelCase boundaries) is one. Segment
// matching catches db_password / authToken / apiKey while 'author',
// 'monkey', 'tokenizer' stay innocent (no substring false positives).
function keyIsSecret(k) {
    const raw = String(k);
    if (SECRET_KEYS.has(normalizeKey(raw))) return true;
    const segs = raw.split(/[^a-zA-Z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
        .map((s) => s.toLowerCase())
        .filter(Boolean);
    return segs.some((s) => SECRET_KEYS.has(s));
}

function redactString(s) {
    let out = String(s);
    for (const re of SECRET_VALUE_PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, REDACTED);
    }
    for (const re of PII_VALUE_PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, REDACTED);
    }
    return out;
}

function sanitizeValue(value, depth, seen) {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'string') return redactString(value);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
    if (depth >= MAX_DEPTH) return REDACTED;
    if (seen.has(value)) return '[Circular]';
    if (Array.isArray(value)) {
        seen.add(value);
        const arr = value.slice(0, 200).map((v) => sanitizeValue(v, depth + 1, seen));
        seen.delete(value);
        return arr;
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return `[Buffer ${value.length} bytes]`;
    }
    if (t === 'object') {
        seen.add(value);
        const out = {};
        const keys = Object.keys(value).slice(0, 200);
        for (const k of keys) {
            out[k] = keyIsSecret(k)
                ? REDACTED
                : sanitizeValue(value[k], depth + 1, seen);
        }
        seen.delete(value);
        return out;
    }
    // functions, symbols, etc. — never persistable meaningfully
    return REDACTED;
}

// Public for unit tests. Returns the sanitized copy (input untouched).
function sanitizeInputs(inputs) {
    let v = inputs;
    if (v === null || v === undefined) return {};
    if (typeof v !== 'object' || Array.isArray(v)) v = { value: v };
    const clean = sanitizeValue(v, 0, new WeakSet());
    // Size cap: a hostile or chatty caller cannot bloat the trail.
    const json = JSON.stringify(clean);
    if (json.length > MAX_INPUT_CHARS) {
        return {
            _truncated: true,
            _originalChars: json.length,
            preview: json.slice(0, MAX_INPUT_CHARS)
        };
    }
    return clean;
}

function opErrorJson(err, message) {
    const detail = process.env.NODE_ENV === 'production'
        ? undefined
        : (err && err.message ? String(err.message).slice(0, 200) : undefined);
    return { success: false, error: message, ...(detail ? { detail } : {}) };
}

// POST /api/ops/audit — log one agent action. 201 with the STORED (sanitized)
// document, so the caller can verify exactly what was persisted.
async function postAuditEvent(req, res) {
    try {
        const { actor, action, inputs, result, evidenceRef, correlationId } = req.body || {};
        if (!actor || !ACTORS.includes(actor)) {
            return res.status(400).json({
                success: false,
                error: `Invalid actor: must be one of ${ACTORS.join(', ')}.`
            });
        }
        if (!action || !String(action).trim()) {
            return res.status(400).json({ success: false, error: 'Missing required field: action.' });
        }
        if (!result || !String(result).trim()) {
            return res.status(400).json({ success: false, error: 'Missing required field: result.' });
        }
        let corr = null;
        if (correlationId !== undefined && correlationId !== null && correlationId !== '') {
            if (!mongoose.Types.ObjectId.isValid(correlationId)) {
                return res.status(400).json({ success: false, error: 'Invalid correlationId: must be an ObjectId.' });
            }
            corr = new mongoose.Types.ObjectId(correlationId);
        }
        const doc = await OpsAuditEvent.create({
            correlationId: corr,
            actor,
            action: String(action).trim().slice(0, 120),
            inputs: sanitizeInputs(inputs),
            result: redactString(String(result)).slice(0, 2000),
            // evidenceRef is a pointer (ledger path / Drive id / file:line),
            // but redact it anyway — a secret must never land in the trail
            // even if a caller pastes one into the wrong field.
            evidenceRef: redactString(String(evidenceRef || '')).slice(0, 500),
            // tsUtc: ALWAYS server-set here (never client-supplied, never
            // left to schema-default subtleties) — tamper-evident trail.
            tsUtc: new Date()
        });
        return res.status(201).json({ success: true, event: doc });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to log audit event.'));
    }
}

// GET /api/ops/audit — read the trail (future Mission Control UI).
// Filters: ?actor=&action=&correlationId=&since=&until=&limit=&order=asc|desc
async function getAuditEvents(req, res) {
    try {
        const q = {};
        if (req.query.actor) {
            if (!ACTORS.includes(req.query.actor)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid actor filter: must be one of ${ACTORS.join(', ')}.`
                });
            }
            q.actor = req.query.actor;
        }
        if (req.query.action) q.action = String(req.query.action).slice(0, 120);
        if (req.query.correlationId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.correlationId)) {
                return res.status(400).json({ success: false, error: 'Invalid correlationId filter.' });
            }
            q.correlationId = new mongoose.Types.ObjectId(req.query.correlationId);
        }
        const ts = {};
        if (req.query.since) {
            const d = new Date(req.query.since);
            if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Invalid since date.' });
            ts.$gte = d;
        }
        if (req.query.until) {
            const d = new Date(req.query.until);
            if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Invalid until date.' });
            ts.$lte = d;
        }
        if (Object.keys(ts).length) q.tsUtc = ts;

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit < 1) limit = 50;
        limit = Math.min(limit, 500);
        const order = req.query.order === 'asc' ? 1 : -1;

        const events = await OpsAuditEvent.find(q).sort({ tsUtc: order }).limit(limit).lean();
        return res.json({ success: true, count: events.length, events });
    } catch (err) {
        return res.status(500).json(opErrorJson(err, 'Failed to read audit trail.'));
    }
}

module.exports = {
    postAuditEvent,
    getAuditEvents,
    sanitizeInputs, // exported for unit tests
    redactString,   // exported for unit tests
    ACTORS
};
