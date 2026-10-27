const CrashReport = require('../models/CrashReport');
const { connectToDatabase, isDbConnected } = require('../config/db');

// ---- Server-side sanitization ----
// The app sends raw crash text; strip anything that looks like a secret before
// persisting. Patterns (applied in order):
const REDACTIONS = [
    // JWT-shaped tokens: eyJ....(three base64url segments)
    { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: '[REDACTED_TOKEN]' },
    // "Authorization: Bearer xyz" header-style values inside traces
    { re: /(authorization\s*[:=]\s*)(Bearer\s+)?[^\s,};"']+/gi, label: '$1[REDACTED]' },
    // key=value / key: value secret assignments (api keys, passwords, tokens)
    {
        re: /\b(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|auth[_-]?token|access[_-]?token|id[_-]?token|refresh[_-]?token|private[_-]?key|gemini[_-]?key|bearer)\s*[:=]\s*['"]?[^'"\s,}]{3,}['"]?/gi,
        label: '$1=[REDACTED]'
    },
    // Standalone long hex/base64 blobs (32+ chars) — API keys, hashes, tokens.
    // Short hex like 0x7f02007d (resource ids in traces) is deliberately kept.
    { re: /\b[A-Fa-f0-9]{32,}\b/g, label: '[REDACTED_BLOB]' },
    { re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, label: '[REDACTED_BLOB]' },
    // Email addresses (user privacy; stack traces can echo contact strings)
    { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '[REDACTED_EMAIL]' }
];

function sanitizeText(value) {
    let s = String(value == null ? '' : value);
    for (const { re, label } of REDACTIONS) {
        re.lastIndex = 0;
        s = s.replace(re, label);
    }
    return s;
}

function clampString(value, max) {
    const s = sanitizeText(value);
    return s.length > max ? s.slice(0, max) : s;
}

const MAX_STACK_BYTES = 64 * 1024; // 64KB cap on stackTrace
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_MAX = 10; // max reports per user per hour (DB-count guard: serverless-safe)

// POST /api/crash-reports — app one-tap send. Requires authenticateUser;
// the username comes ONLY from the verified JWT (never the request body).
async function submitCrashReport(req, res) {
    const username = req.user && req.user.username ? String(req.user.username).trim() : '';
    if (!username) {
        return res.status(401).json({ success: false, error: 'Invalid session.' });
    }

    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }

    try {
        // Rate limit: DB count (survives serverless; in-memory would not).
        const recent = await CrashReport.countDocuments({
            username,
            createdAt: { $gte: new Date(Date.now() - RATE_WINDOW_MS) }
        });
        if (recent >= RATE_MAX) {
            return res.status(429).json({ success: false, error: 'Too many crash reports. Try again later.' });
        }

        const body = req.body || {};
        let stackTrace = sanitizeText(body.stackTrace);
        if (stackTrace.length > MAX_STACK_BYTES) {
            stackTrace = stackTrace.slice(0, MAX_STACK_BYTES) + '\n...[TRUNCATED AT 64KB]';
        }

        let crashedAt = body.crashedAt ? new Date(body.crashedAt) : new Date();
        if (isNaN(crashedAt.getTime()) || crashedAt.getTime() > Date.now() + 24 * 3600 * 1000) {
            crashedAt = new Date(); // clamp invalid / far-future client timestamps
        }

        const doc = await CrashReport.create({
            username,
            deviceModel: clampString(body.deviceModel, 200),
            androidVersion: clampString(body.androidVersion, 200),
            appVersion: clampString(body.appVersion, 200),
            appVersionCode: Number.isFinite(Number(body.appVersionCode)) ? Number(body.appVersionCode) : undefined,
            stackTrace,
            crashedAt
        });

        return res.status(201).json({ success: true, id: doc._id });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to save crash report.' });
    }
}

// GET /api/admin/crash-reports — admin auth. Newest first, paginated (?limit=, default 50, max 200).
async function listCrashReports(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const reports = await CrashReport.find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        return res.json({ success: true, reports });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to load crash reports.' });
    }
}

// DELETE /api/admin/crash-reports/:id — admin auth. Delete one report.
async function deleteCrashReport(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }
    try {
        // v91 (BugHunter backend F29): a malformed :id threw a CastError
        // inside findByIdAndDelete (500). Validate first — bad ids are 400.
        const mongoose = require('mongoose');
        if (!mongoose.Types.ObjectId.isValid(String(req.params.id || ''))) {
            return res.status(400).json({ success: false, error: 'Invalid report id.' });
        }
        const doc = await CrashReport.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ success: false, error: 'Report not found.' });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to delete crash report.' });
    }
}

// DELETE /api/admin/crash-reports — admin auth. Clear all reports.
async function clearCrashReports(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database unavailable.' });
    }
    try {
        const result = await CrashReport.deleteMany({});
        return res.json({ success: true, deleted: result.deletedCount || 0 });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Failed to clear crash reports.' });
    }
}

module.exports = {
    submitCrashReport,
    listCrashReports,
    deleteCrashReport,
    clearCrashReports,
    // exported for tests/inspection
    sanitizeText
};
