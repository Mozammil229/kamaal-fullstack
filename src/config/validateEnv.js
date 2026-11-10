// Phase 4F (W1) — prod/staging fail-fast environment validation.
//
// The backend must NEVER boot in staging or production with a localhost
// database, a test database, a placeholder/weak secret, or a wildcard
// CORS origin. A misconfigured staging/production boot used to start
// happily and fail later (or silently serve the wrong database); this
// module refuses to start instead, listing EVERY problem at once so the
// operator fixes them in one pass (never a single-var crash loop —
// STAGING_CHECKLIST.md S-05).
//
// Rules (see staging/README.md § "4F fail-fast" for the operator copy):
//   - NODE_ENV must be set explicitly to one of development | test |
//     staging | production. Unset, blank, or any other value (e.g.
//     'Staging', 'qa') is ambiguous and refuses to boot. This is
//     deliberate: the mode decides which checks apply, so an unknown
//     mode cannot silently pick the lax path.
//   - development / test: NO strict checks — the existing dummy-env
//     behaviour keeps working (the test suite boots with dummy secrets
//     and no MongoDB; `npm test` requires src/app.js directly and never
//     goes through src/server.js, but the exemption is explicit anyway).
//   - staging / production: strict checks (see validateEnv):
//       * MONGODB_URI required; host must not be localhost / 127.0.0.1 /
//         ::1; a database name is required (the driver defaults an
//         unnamed database to 'test'); the name must not be 'test' or
//         test-prefixed/suffixed (test, test-*, *_test, *-test, test_*).
//       * JWT_SECRET / ADMIN_JWT_SECRET required, >= 32 chars.
//       * WEB_JWT_SECRET, ADMIN_PASS, CRON_SECRET, OPS_INTERNAL_KEY,
//         APIKEY_ENCRYPTION_KEY, MEMORY_ENC_KEY, GEMINI_API_KEY (and
//         each GEMINI_BACKUP_KEYS entry), GROQ_API_KEY,
//         OPENROUTER_API_KEY, BLOB_READ_WRITE_TOKEN, YOUTUBE_API_KEY:
//         optional, but when set they must not be a placeholder and
//         must meet their minimum length. ADMIN_PASS unset is allowed
//         (direct-key admin login is disabled by design — see env.js)
//         and only warns; same for the other optional keys.
//       * RSA_PRIVATE_KEY_PEM: when set, must look like a PEM private
//         key and must not be a placeholder.
//       * CORS_ALLOWED_ORIGINS: when set, no entry may be '*' or
//         contain '*', and every entry must be a bare http(s) origin
//         (scheme + host, optional port — no path/query). When unset,
//         the app default allowlist applies (warn only, not fatal).
//   - A "placeholder" is: empty, an angle-bracket value (<...>), an
//     exact match for changeme / dummy / test / placeholder / password /
//     secret / example / replace-me / todo (case-insensitive), or a
//     value starting with changeme / dummy / placeholder. Values are
//     NEVER echoed in problem messages — only variable names + reasons.
//
// Wiring: src/server.js loads dotenv, then calls failFastEnvCheck()
// BEFORE requiring src/app.js, so a bad staging/production env is
// refused with the full problem list instead of env.js's single-var
// FATAL throw. The Vercel entry (api/index.js) does not use
// src/server.js, so Vercel's own environment handling is untouched.

'use strict';

const KNOWN_ENVS = ['development', 'test', 'staging', 'production'];

// Documented minimum lengths (operator copy in staging/README.md).
// JWT-family secrets sign tokens: 32 chars minimum. Admin password:
// 12. Machine-to-machine / encryption keys: 16. Provider API keys:
// 16 (real provider keys are 39+ chars; anything shorter is a stub).
const MIN_LENGTH = {
    JWT_SECRET: 32,
    ADMIN_JWT_SECRET: 32,
    WEB_JWT_SECRET: 32,
    ADMIN_PASS: 12,
    CRON_SECRET: 16,
    OPS_INTERNAL_KEY: 16,
    APIKEY_ENCRYPTION_KEY: 16,
    MEMORY_ENC_KEY: 16,
    GEMINI_API_KEY: 16,
    GROQ_API_KEY: 16,
    OPENROUTER_API_KEY: 16,
    BLOB_READ_WRITE_TOKEN: 16,
    YOUTUBE_API_KEY: 16,
};

const PLACEHOLDER_EXACT = new Set([
    'changeme', 'change-me', 'changeme123', 'placeholder', 'dummy',
    'test', 'password', 'secret', 'example', 'your-secret-here',
    'replace-me', 'replace_me', 'todo', 'xxx', 'none', 'null',
]);

function isPlaceholder(value) {
    const v = String(value).trim();
    if (v === '') return true;
    if (v.includes('<') || v.includes('>')) return true;
    const lower = v.toLowerCase();
    if (PLACEHOLDER_EXACT.has(lower)) return true;
    for (const prefix of ['changeme', 'dummy', 'placeholder']) {
        if (lower === prefix || lower.startsWith(prefix + '-') || lower.startsWith(prefix + '_') || lower.startsWith(prefix + ' ')) return true;
    }
    return false;
}

/** Parse a MongoDB URI into { host, dbName } (nulls when unparseable). */
function parseMongoUri(uri) {
    // mongodb://[user:pass@]host[:port][/db][?opts]
    // mongodb+srv://[user:pass@]host[/db][?opts]
    const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)(?:\/([^?#]*))?/.exec(String(uri).trim());
    if (!m) return { host: null, dbName: null };
    let dbName = null;
    try { dbName = m[2] ? decodeURIComponent(m[2]) : null; } catch (_) { dbName = m[2] || null; }
    return { host: m[1] ? m[1].toLowerCase() : null, dbName };
}

function isLocalhost(host) {
    if (!host) return false;
    // Bracketed IPv6: '[::1]:27017' -> '::1'. Unbracketed: split off :port.
    let bare;
    if (host.startsWith('[')) {
        const close = host.indexOf(']');
        bare = close === -1 ? host.slice(1) : host.slice(1, close);
    } else {
        bare = host.split(':')[0];
    }
    bare = bare.toLowerCase();
    return bare === 'localhost' || bare === '127.0.0.1' || bare === '::1' || bare.endsWith('.localhost');
}

function isTestDbName(dbName) {
    const n = String(dbName).toLowerCase();
    return n === 'test' || n.startsWith('test-') || n.startsWith('test_') ||
        n.endsWith('-test') || n.endsWith('_test');
}

/**
 * Validate an env object for the given mode. Returns an array of
 * problems: { variable, problem }. Empty array = OK to boot.
 * Pure function (no process access, no exit) — unit-tested directly.
 */
function validateEnv(env) {
    const problems = [];
    const fail = (variable, problem) => problems.push({ variable, problem });

    const rawNodeEnv = env.NODE_ENV === undefined || env.NODE_ENV === null ? '' : String(env.NODE_ENV).trim();
    if (!KNOWN_ENVS.includes(rawNodeEnv)) {
        fail('NODE_ENV', rawNodeEnv === ''
            ? 'is unset. Set NODE_ENV explicitly to development, test, staging, or production — the boot mode must never be guessed.'
            : `is '${rawNodeEnv}', which is not a recognised environment. Set NODE_ENV explicitly to development, test, staging, or production.`);
        return problems; // Mode unknown: no further checks are meaningful.
    }
    const mode = rawNodeEnv;
    if (mode === 'development' || mode === 'test') return problems; // Lax by design.

    // ---- staging / production: strict checks below ----

    // MONGODB_URI — required, remote host, real (non-test) database.
    const uri = String(env.MONGODB_URI || '').trim();
    if (!uri) {
        fail('MONGODB_URI', `is not set. ${mode} must point at its own remote MongoDB database (never localhost, never a test database).`);
    } else {
        const { host, dbName } = parseMongoUri(uri);
        if (!host) {
            fail('MONGODB_URI', 'is not a parseable MongoDB connection string.');
        } else {
            if (isLocalhost(host)) {
                fail('MONGODB_URI', `points at a local host ('${host}'). ${mode} must use a remote database, never localhost / 127.0.0.1.`);
            }
            if (!dbName) {
                fail('MONGODB_URI', 'names no database — the driver would default to the \'test\' database. Add an explicit database name.');
            } else if (isTestDbName(dbName)) {
                fail('MONGODB_URI', `uses test database '${dbName}'. ${mode} must use its own non-test database.`);
            }
        }
    }

    // Required secrets — present, not a placeholder, minimum length.
    for (const name of ['JWT_SECRET', 'ADMIN_JWT_SECRET']) {
        const v = String(env[name] || '').trim();
        if (!v) fail(name, `is not set. ${mode} cannot sign tokens without it.`);
        else if (isPlaceholder(v)) fail(name, 'looks like a placeholder value, not a real secret. Generate a long random value.');
        else if (v.length < MIN_LENGTH[name]) fail(name, `is only ${v.length} characters — minimum ${MIN_LENGTH[name]} for ${mode}. Generate a longer random value.`);
    }

    // Optional secrets — when set, same placeholder + length rules.
    // (Unset is allowed: each feature degrades or disables itself by
    // design — e.g. ADMIN_PASS unset disables direct-key admin login,
    // WEB_JWT_SECRET unset falls back to JWT_SECRET.)
    for (const name of Object.keys(MIN_LENGTH)) {
        if (name === 'JWT_SECRET' || name === 'ADMIN_JWT_SECRET') continue;
        const raw = env[name];
        if (raw === undefined || raw === null) continue;
        const v = String(raw).trim();
        if (v === '') continue; // Empty = unset for optional keys.
        if (name === 'GEMINI_API_KEY' || name === 'GEMINI_BACKUP_KEYS') continue; // Handled below (comma lists).
        if (isPlaceholder(v)) fail(name, 'looks like a placeholder value, not a real secret. Generate a real value or leave it unset.');
        else if (v.length < MIN_LENGTH[name]) fail(name, `is only ${v.length} characters — minimum ${MIN_LENGTH[name]} for ${mode} when set.`);
    }

    // Gemini keys may be comma-separated lists (GEMINI_BACKUP_KEYS).
    for (const name of ['GEMINI_API_KEY', 'GEMINI_BACKUP_KEYS']) {
        const raw = env[name];
        if (raw === undefined || raw === null) continue;
        for (const entry of String(raw).split(',')) {
            const v = entry.trim();
            if (v === '') continue;
            if (isPlaceholder(v)) fail(name, `contains a placeholder entry ('${name}' list). Use real keys or leave it unset.`);
            else if (v.length < MIN_LENGTH.GEMINI_API_KEY) fail(name, `contains a key of only ${v.length} characters — minimum ${MIN_LENGTH.GEMINI_API_KEY} for ${mode} when set.`);
        }
    }

    // RSA private key — when set, must look like a PEM private key.
    if (env.RSA_PRIVATE_KEY_PEM !== undefined && env.RSA_PRIVATE_KEY_PEM !== null) {
        const v = String(env.RSA_PRIVATE_KEY_PEM).replace(/\\n/g, '\n').trim();
        if (v !== '') {
            if (isPlaceholder(v)) fail('RSA_PRIVATE_KEY_PEM', 'looks like a placeholder value, not a real key.');
            else if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(v)) fail('RSA_PRIVATE_KEY_PEM', 'does not look like a PEM private key (expected a -----BEGIN ... PRIVATE KEY----- block).');
        }
    }

    // CORS — never a wildcard in staging/production.
    const corsRaw = env.CORS_ALLOWED_ORIGINS;
    if (corsRaw !== undefined && corsRaw !== null && String(corsRaw).trim() !== '') {
        for (const entry of String(corsRaw).split(',')) {
            const origin = entry.trim();
            if (origin === '') continue;
            if (origin.includes('*')) {
                fail('CORS_ALLOWED_ORIGINS', `contains a wildcard entry ('${origin}'). ${mode} must list explicit origins, never '*'.`);
            } else if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin)) {
                fail('CORS_ALLOWED_ORIGINS', `contains '${origin}', which is not a bare http(s) origin (scheme + host, optional port — no path or query).`);
            }
        }
    }

    return problems;
}

/** Non-fatal warnings for staging/production (logged, never blocking). */
function stagingWarnings(env) {
    const warnings = [];
    if (String(env.CORS_ALLOWED_ORIGINS || '').trim() === '') {
        warnings.push('CORS_ALLOWED_ORIGINS is unset — the built-in default allowlist applies. Set it explicitly to the staging PWA origin on the real host.');
    }
    if (String(env.ADMIN_PASS || '').trim() === '') {
        warnings.push('ADMIN_PASS is unset — direct-key admin login is DISABLED (by design, see src/config/env.js). Set a staging admin password if admin login is needed.');
    }
    if (String(env.WEB_JWT_SECRET || '').trim() === '') {
        warnings.push('WEB_JWT_SECRET is unset — web tokens fall back to JWT_SECRET. Setting a dedicated value is recommended.');
    }
    return warnings;
}

function formatProblems(problems, mode) {
    const lines = [`FATAL: invalid environment for NODE_ENV=${mode} — refusing to start. Fix all ${problems.length} problem(s):`];
    for (const p of problems) lines.push(`  - ${p.variable}: ${p.problem}`);
    lines.push('No secrets are echoed above — only variable names and reasons.');
    return lines.join('\n');
}

/**
 * Boot gate for src/server.js: validate process.env, and on any problem
 * print the full list to stderr and exit(1) — no stack trace, no secret
 * values. Returns silently when the environment is valid (or lax mode).
 */
function failFastEnvCheck(env = process.env) {
    const problems = validateEnv(env);
    if (problems.length > 0) {
        const mode = String(env.NODE_ENV || '').trim() || '(unset)';
        console.error(formatProblems(problems, mode));
        process.exit(1);
    }
    const mode = String(env.NODE_ENV || '').trim();
    if (mode === 'staging' || mode === 'production') {
        for (const w of stagingWarnings(env)) console.error(`WARNING (non-fatal): ${w}`);
    }
}

module.exports = {
    KNOWN_ENVS,
    MIN_LENGTH,
    isPlaceholder,
    parseMongoUri,
    isTestDbName,
    validateEnv,
    stagingWarnings,
    formatProblems,
    failFastEnvCheck,
};
