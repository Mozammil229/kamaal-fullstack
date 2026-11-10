// 4A regression tests (M-P1-01–M-P1-05 + P2 fixes). Node's built-in test runner.
// Runs WITHOUT MongoDB: the app boots with a lazy DB connection and these tests
// assert behaviour observable without a database. Anything needing a live DB
// (support-message scoping end-to-end, getUsers rows) is covered by the T3
// contract suite against staging in 4E — NOT claimed here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// Dummy secrets for boot only — never real values.
process.env.JWT_SECRET = 'test-jwt-secret-4a-only';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-4a-only';
process.env.CORS_ALLOWED_ORIGINS = 'https://kamaal-fullstack-ten.vercel.app,http://localhost:5173';

const app = require('../src/app');
const { serverError } = require('../src/utils/serverError');
const { validateInput } = require('../src/middleware/validateInput');
const { verifyPassword } = require('../src/controllers/authController');
const { USER_LIST_FIELDS } = require('../src/controllers/adminController');
const auth = require('../src/middleware/auth');

let server;
let port;

function req(method, path, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

before(async () => {
    server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    port = server.address().port;
});

after(async () => {
    await new Promise((r) => server.close(r));
});

// --- M-P1-02: fail closed without secrets (regression: hardcoded fallbacks) ---
test('F-02: env.js refuses to load without JWT_SECRET / ADMIN_JWT_SECRET', async () => {
    const run = (env) => new Promise((resolve) => {
        execFile(process.execPath, ['-e', "require('/home/hatch/workspace/kamaal-fullstack-deploy/src/config/env.js'); console.log('LOADED')"],
            { env: { ...process.env, ...env }, timeout: 10000 },
            (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout }));
    });
    const noJwt = await run({ JWT_SECRET: '', ADMIN_JWT_SECRET: 'x' });
    assert.notEqual(noJwt.code, 0, 'must fail without JWT_SECRET');
    const noAdmin = await run({ JWT_SECRET: 'x', ADMIN_JWT_SECRET: '' });
    assert.notEqual(noAdmin.code, 0, 'must fail without ADMIN_JWT_SECRET');
});

// --- M-P1-01: revocation TTL 30d (model) + bounded in-memory set ---
test('F-01: RevokedToken TTL covers the 30d JWT lifetime', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/models/RevokedToken.js'), 'utf8');
    assert.match(src, /expires:\s*'30d'/);
});
test('F-01 residual: in-memory revocation set is bounded at 10000 (FIFO)', async () => {
    for (let i = 0; i < 10050; i++) {
        await auth.revokeToken(`test-token-${i}`);
    }
    assert.equal(auth._localRevocationCount(), 10000);
    assert.equal(auth.MAX_LOCAL_REVOCATIONS, 10000);
});

// --- M-P1-03: CORS allowlist ---
test('F-03: disallowed Origin gets no ACAO header; allowed Origin is echoed; "*" never appears', async () => {
    const evil = await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
    const ok = await req('GET', '/api/health', { headers: { Origin: 'https://kamaal-fullstack-ten.vercel.app' } });
    assert.equal(ok.headers['access-control-allow-origin'], 'https://kamaal-fullstack-ten.vercel.app');
    assert.notEqual(evil.headers['access-control-allow-origin'], '*');
    assert.notEqual(ok.headers['access-control-allow-origin'], '*');
});

// --- M-P2-16: security headers ---
test('F-10: security headers present, X-Powered-By absent', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-powered-by'], undefined);
});

// --- M-P2-11: honest health status ---
test('F-11: GET /api/health is 503 with honest body when the DB is disconnected', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 503);
    const body = JSON.parse(r.body);
    assert.equal(body.status, 'DEGRADED');
    assert.match(body.database, /Disconnected/);
});

// --- M-P2-12: probe route deleted ---
// The deleted route no longer answers: the request falls through to the
// socialRoutes blanket auth wall (401), never to the probe handler (which
// used to answer 400 NO_AUDIO_FILE / 503 GEMINI_KEY_MISSING without auth).
test('F-12: POST /api/subtitles/probe is gone (no probe handler answers)', async () => {
    const r = await req('POST', '/api/subtitles/probe', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.ok(!r.body.includes('subtitle-probe') && !r.body.includes('NO_AUDIO_FILE') && !r.body.includes('GEMINI_KEY_MISSING'));
});

// --- M-P1-04: admin login limiter 5/min + failure delay ---
test('F-04: admin login allows 5 attempts then 429s, and failures are delayed ~400ms', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
        const t0 = Date.now();
        const r = await req('POST', '/api/admin/login', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'wrong' }),
        });
        statuses.push({ status: r.status, ms: Date.now() - t0 });
    }
    assert.deepEqual(statuses.map((s) => s.status), [401, 401, 401, 401, 401, 429]);
    assert.ok(statuses[0].ms >= 350, `first failure took ${statuses[0].ms}ms, expected >=350ms delay`);
});

// --- M-P2-17: error masking ---
test('F-11: serverError masks internals and carries an errorId', () => {
    let out = null;
    const res = { status(code) { this.code = code; return this; }, json(obj) { out = obj; return this; } };
    serverError(res, new Error('Mongoose collection users failed: secret internals'), 500);
    assert.equal(res.code, 500);
    assert.equal(out.error, 'Something went wrong. Please try again.');
    assert.match(out.errorId, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(out).includes('Mongoose'));
});
test('F-11: no "error: e.message" leak remains in controllers (except controlled throws)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../src/controllers');
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!line.includes('error: e.message')) return;
            // Controlled throws only: our own {status,message} objects
            // (password-decrypt errors) and KEY_ERROR paths — never raw
            // exception internals.
            const controlled = line.includes("|| 'Password error.'") || line.includes("KEY_ERROR");
            assert.ok(controlled, `unexpected e.message leak at ${f}:${i + 1}: ${line.trim()}`);
        });
    }
});

test('F4: no raw e.message/err.message reaches a response body except controlled throws', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(__dirname, '../src/controllers');
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!/\.json\(/.test(line)) return;
            // Word-boundary match only: "maintenance.message" (an admin-authored
            // config string) must NOT match — only real exception variables.
            if (!/(?:^|[^A-Za-z0-9_])(e|err|error)\.message/.test(line)) return;
            if (line.includes('serverError(')) return;
            // Controlled throws only (same markers as the F-11 test above).
            const controlled = line.includes("|| 'Password error.'") || line.includes('KEY_ERROR');
            assert.ok(controlled, `raw exception text in response at ${f}:${i + 1}: ${line.trim()}`);
        });
    }
});

// --- M-P2-18: validation layer ---
test('F-12: over-long chat text is rejected 400 before auth; limit is clamped', async () => {
    const r = await req('POST', '/api/chat/send', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(5000) }),
    });
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /too long/);
    const mockReq = { body: {}, query: { limit: '9999', offset: '-5' } };
    await new Promise((resolve) => validateInput(mockReq, {}, resolve));
    assert.equal(mockReq.query.limit, '200');
    assert.equal(mockReq.query.offset, '0');
});

// --- M-P2-19 / M-P3-02: getUsers allowlist ---
test('F-14: getUsers allowlist excludes secrets and tokens', () => {
    for (const banned of ['passwordHash', 'customGeminiKey', 'fcmToken', 'token', '__v', 'password']) {
        assert.ok(!USER_LIST_FIELDS.split(' ').includes(banned), `${banned} must not be in the allowlist`);
    }
    for (const needed of ['username', 'email', 'credits', 'status']) {
        assert.ok(USER_LIST_FIELDS.split(' ').includes(needed), `${needed} must be in the allowlist`);
    }
});

// --- M-P1-07: legacy password fallback (default OFF = migration preserved) ---
test('F-07: legacy SHA-256 login still migrates with the kill-switch OFF (default)', () => {
    const sha = crypto.createHash('sha256').update('oldpass').digest('hex');
    const r = verifyPassword('oldpass', { passwordHash: sha });
    assert.deepEqual(r, { ok: true, migrate: true });
    const bcrypt = require('bcryptjs');
    const r2 = verifyPassword('newpass', { passwordHash: bcrypt.hashSync('newpass', 10) });
    assert.equal(r2.ok, true);
    assert.equal(r2.migrate, false);
});
test('F-07: legacy login is rejected with legacyRejected when the kill-switch is ON', async () => {
    const out = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', `
            process.env.DISABLE_LEGACY_PASSWORD_FALLBACK='true';
            process.env.JWT_SECRET='x'; process.env.ADMIN_JWT_SECRET='x';
            const c = require('/home/hatch/workspace/kamaal-fullstack-deploy/src/controllers/authController');
            const crypto = require('crypto');
            const sha = crypto.createHash('sha256').update('oldpass').digest('hex');
            console.log(JSON.stringify(c.verifyPassword('oldpass', { passwordHash: sha })));
        `], { timeout: 10000 }, (err, stdout, stderr) => err ? reject(new Error(stderr)) : resolve(stdout.trim()));
    });
    assert.deepEqual(JSON.parse(out), { ok: false, migrate: false, legacyRejected: true });
});

// --- F-05: support scoping is enforced in code (DB-dependent e2e is T3/staging) ---
test('F-05: getSupportMessages has no bare { isAdmin: true } clause', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '../src/controllers/chatController.js'), 'utf8');
    // Strip comments: the fix comment itself quotes the old clause.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // No $or element that is ONLY { isAdmin: true } (the old leak).
    assert.ok(!/{\s*isAdmin:\s*true\s*}/.test(code), 'bare isAdmin clause must not exist');
    // The only live isAdmin:true is the scoped legacy clause (admin DM whose
    // recipient username was stored in deviceId, matched only for that user).
    assert.ok(code.includes("{ deviceId: username, isAdmin: true }"), 'scoped legacy clause must exist');
    assert.ok(code.includes('recipientUsername: username'), 'must scope to addressed DMs');
});
