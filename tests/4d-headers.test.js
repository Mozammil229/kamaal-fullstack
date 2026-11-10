// 4D (W2) tests — HEADERS, VALIDATION, RATE LIMITS + HEALTH FIELD.
// Node's built-in test runner, same harness as tests/4a-regressions.test.js.
// Runs WITHOUT MongoDB: MONGODB_URI is unset, so connectToDatabase() returns
// null immediately and controllers answer 503/400 fast instead of hanging.
// Anything needing a live DB (allowlist end-to-end, poll range vs a real
// poll, grant flows) is covered by the T3 contract suite against staging
// in 4E — NOT claimed here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

// Dummy secrets for boot only — never real values.
process.env.JWT_SECRET = 'test-jwt-secret-4d-only';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-4d-only';
process.env.CORS_ALLOWED_ORIGINS = 'https://kamaal-fullstack-ten.vercel.app,http://localhost:5173';

// Mongoose buffers model ops while disconnected (default 10s per op) and
// sendChatMessage/sendSupportMessage have no isDbConnected guard — without
// this, each limiter probe would stall ~10s. Shrink the buffer timeout for
// TESTS ONLY (production code untouched) so probes fail fast with 500s.
require('mongoose').set('bufferTimeoutMS', 250);

const app = require('../src/app');
const { validateInput } = require('../src/middleware/validateInput');

let server;
let port;

function req(method, p, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
    });
}

function authHeaders(username) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

before(async () => {
    server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    port = server.address().port;
});

after(async () => {
    await new Promise((r) => server.close(r));
});

// --- 1. CSP enforced ---
test('4D-CSP: Content-Security-Policy is ENFORCED, Report-Only is ABSENT', async () => {
    const r = await req('GET', '/api/health');
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, 'enforced CSP header must be present');
    assert.equal(r.headers['content-security-policy-report-only'], undefined, 'Report-Only header must be gone');
    for (const d of [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self' https://kamaal-fullstack-ten.vercel.app",
        "img-src 'self' data: https:",
        "media-src 'self' blob:",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
    ]) assert.ok(csp.includes(d), `CSP must contain: ${d}`);
    assert.ok(!csp.includes('unsafe-inline'), 'CSP must not contain unsafe-inline');
    assert.ok(!csp.includes('unsafe-eval'), 'CSP must not contain unsafe-eval');
});

test('4D-CSP: PWA_API_ORIGIN joins connect-src when set, malformed values are dropped', async () => {
    process.env.PWA_API_ORIGIN = 'https://pwa-api.example';
    let r = await req('GET', '/api/health');
    assert.ok(r.headers['content-security-policy'].includes('https://pwa-api.example'), 'valid PWA_API_ORIGIN must appear in connect-src');
    process.env.PWA_API_ORIGIN = 'https://x.example; script-src evil';
    r = await req('GET', '/api/health');
    assert.ok(!r.headers['content-security-policy'].includes('script-src evil'), 'injection via PWA_API_ORIGIN must be dropped');
    assert.ok(!r.headers['content-security-policy'].includes('x.example'), 'malformed PWA_API_ORIGIN must be dropped entirely');
    delete process.env.PWA_API_ORIGIN;
    r = await req('GET', '/api/health');
    assert.ok(!r.headers['content-security-policy'].includes('pwa-api.example'), 'unset PWA_API_ORIGIN must leave connect-src at the default');
});

// CSP/inline-style evidence (static, against the REAL built PWA shell):
// React style={} props compile to CSSOM assignments (el.style.*), which CSP
// style-src does NOT block — only <style> elements / style attributes are
// blocked. The built bundle must contain NO CSP-blockable inline style.
test('4D-CSP: built PWA has no CSP-blockable inline styles (no style= attr, no <style> in shell)', () => {
    const dist = path.join(__dirname, '../../kamaal-pwa/apps/web/dist');
    const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    assert.ok(!/<style/i.test(indexHtml), 'dist/index.html must contain no <style> element');
    const assets = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
    assert.ok(assets.length > 0, 'built JS assets must exist');
    for (const f of assets) {
        const js = fs.readFileSync(path.join(dist, 'assets', f), 'utf8');
        assert.ok(!js.includes('style='), `${f} must contain no literal style= attribute`);
        assert.ok(!/setAttribute\(["']style["']/.test(js), `${f} must not setAttribute('style', ...)`);
    }
    // SW + Three.js chunks are same-origin files, covered by script-src 'self'.
    for (const f of ['sw.js', 'kill-switch-sw.js']) assert.ok(fs.existsSync(path.join(dist, f)), `${f} must exist in dist`);
    assert.ok(assets.some((f) => f.startsWith('three-')), 'Three.js chunks must exist in dist/assets');
});

// --- 2. Validation extension ---
test('4D-VAL: negative credits / NaN amount / non-numeric amount rejected 400 before auth', async () => {
    const cases = [
        [{ credits: -5 }, 'negative credits'],
        [{ credits: 'NaN' }, 'NaN credits'],
        [{ amount: 'not-a-number' }, 'non-numeric amount'],
        [{ amount: 'NaN' }, 'NaN amount'],
        [{ amount: -100 }, 'negative amount'],
        [{ creditsToAdd: -1 }, 'negative creditsToAdd'],
    ];
    for (const [body, label] of cases) {
        const r = await req('POST', '/api/redeem', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal(r.status, 400, `${label} must be 400, got ${r.status}: ${r.body}`);
    }
});

test('4D-VAL: negative / fractional optionIndex rejected 400; over-long chat message rejected 400', async () => {
    for (const idx of [-1, 1.5, 'abc']) {
        const r = await req('POST', '/api/polls/vote', {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pollId: 'x', optionIndex: idx }),
        });
        assert.equal(r.status, 400, `optionIndex ${idx} must be 400, got ${r.status}`);
    }
    const r = await req('POST', '/api/chat/send', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'x'.repeat(5000) }),
    });
    assert.equal(r.status, 400);
});

test('4D-VAL: validateInput unit — negative numerics rejected, zero allowed, clamps kept', async () => {
    const run = (body, query = {}) => new Promise((resolve) => {
        const res = { status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
        validateInput({ body, query }, res, () => resolve({ code: null }));
    });
    assert.equal((await run({ credits: -1 })).code, 400);
    assert.equal((await run({ amount: 0 })).code, null, 'amount 0 must pass the global layer (controllers enforce > 0 where it matters)');
    assert.equal((await run({ optionIndex: 2 })).code, null);
    assert.equal((await run({ optionIndex: 2.5 })).code, 400);
    const q = { limit: '9999', offset: '-5' };
    await run({}, q);
    assert.equal(q.limit, '200');
    assert.equal(q.offset, '0');
});

test('4D-VAL: updateUser/updateConfig accept ONLY allowlisted fields (no req.body spread)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/controllers/adminController.js'), 'utf8');
    assert.ok(!src.includes('...req.body'), 'no spread of req.body anywhere in adminController');
    assert.ok(!src.includes('$set: req.body'), 'no $set of raw req.body');
    for (const field of ['username', 'credits', 'creditAction', 'isPro', 'proPlan', 'status', 'banReason', 'betaMember']) {
        assert.ok(src.includes(field), `updateUser allowlist must include ${field}`);
    }
    for (const field of ['maintenance', 'minAppVersion', 'featureFlags', 'defaultSignupCredits', 'onlineTool']) {
        assert.ok(src.includes(field), `updateConfig allowlist must include ${field}`);
    }
    // No controller spreads the raw body into an update anywhere.
    const dir = path.join(__dirname, '../src/controllers');
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js')) continue;
        const s = fs.readFileSync(path.join(dir, f), 'utf8');
        assert.ok(!s.includes('...req.body'), `${f} must not spread req.body`);
    }
});

test('4D-VAL: chat list default is 75 / max 200 (controller clamp)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/controllers/chatController.js'), 'utf8');
    assert.match(src, /Math\.min\(200, Math\.max\(1, parseInt\(req\.query\.limit\) \|\| 75\)\)/);
});

// --- 3. Rate limits + Retry-After ---
test('4D-RL: shared rateLimit 429s carry a Retry-After header', async () => {
    const { rateLimit } = require('../src/middleware/rateLimit');
    const limited = rateLimit({ windowMs: 60 * 1000, max: 2, message: 'slow down' });
    const call = () => new Promise((resolve) => {
        const res = {
            headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            status(c) { this.code = c; return this; },
            json(o) { resolve({ code: this.code, headers: this.headers, body: o }); },
        };
        limited({ user: { username: 'w2-unit' }, ip: '127.0.0.1' }, res, () => resolve({ code: null }));
    });
    assert.equal((await call()).code, null);
    assert.equal((await call()).code, null);
    const third = await call();
    assert.equal(third.code, 429);
    assert.ok(third.headers['Retry-After'], '429 must carry Retry-After');
    assert.ok(Number(third.headers['Retry-After']) >= 1 && Number(third.headers['Retry-After']) <= 60, 'Retry-After must be 1..60');
});

test('4D-RL: POST /api/chat/send 30/min/user — 31st request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 31; i++) {
        const r = await req('POST', '/api/chat/send', {
            headers: authHeaders('w2-chat-user'),
            body: JSON.stringify({ text: 'hi' }),
        });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.equal(statuses[30], 429, `31st chat send must be 429, got ${statuses}`);
    assert.ok(!statuses.slice(0, 30).includes(429), 'first 30 chat sends must not be rate-limited');
    assert.ok(retryAfter, 'chat-send 429 must carry Retry-After');
});

test('4D-RL: POST /api/authorize-patch 10/min/user — 11th request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 11; i++) {
        const r = await req('POST', '/api/authorize-patch', {
            headers: authHeaders('w2-authz-user'),
            body: JSON.stringify({}),
        });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.equal(statuses[10], 429, `11th authorize-patch must be 429, got ${statuses}`);
    assert.ok(retryAfter, 'authorize-patch 429 must carry Retry-After');
});

test('4D-RL: POST /api/redeem 5/min/user — 6th request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 6; i++) {
        const r = await req('POST', '/api/redeem', {
            headers: authHeaders('w2-redeem-user'),
            body: JSON.stringify({ key: 'KAMAAL-TEST' }),
        });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.equal(statuses[5], 429, `6th redeem must be 429, got ${statuses}`);
    assert.ok(retryAfter, 'redeem 429 must carry Retry-After');
});

test('4D-RL: POST /api/support/send 10/min/user — 11th request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 11; i++) {
        const r = await req('POST', '/api/support/send', {
            headers: authHeaders('w2-support-user'),
            body: JSON.stringify({ message: 'help' }),
        });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.equal(statuses[10], 429, `11th support send must be 429, got ${statuses}`);
    assert.ok(retryAfter, 'support-send 429 must carry Retry-After');
});

test('4D-RL: payment-proof limiter is 5/min and AI chat limiter is kept at 20/min', () => {
    const creditSrc = fs.readFileSync(path.join(__dirname, '../src/routes/creditRoutes.js'), 'utf8');
    assert.match(creditSrc, /proofRateLimit = rateLimit\(\{ windowMs: 60 \* 1000, max: 5/);
    const aiSrc = fs.readFileSync(path.join(__dirname, '../src/routes/aiRoutes.js'), 'utf8');
    assert.match(aiSrc, /const max = 20; \/\/ PHASE H: 20 AI messages\/min per user/);
});

// --- 4. Health pwa field ---
test('4D-HEALTH: GET /api/health returns the pwa field; other fields + status behaviour unchanged', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 503, 'DB down must still be 503 (4A behaviour)');
    const body = JSON.parse(r.body);
    assert.deepEqual(body.pwa, { version: '4d.1', cookieAuth: true });
    assert.equal(body.status, 'DEGRADED');
    assert.equal(body.version, '2.0.0');
    assert.match(body.database, /Disconnected/);
    assert.equal(typeof body.timestamp, 'number');
});

// --- 5. CORS verify-only ---
test('4D-CORS: no "*" origin in the CORS config; no-Origin requests still allowed', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    // Strip comments: the 4A header comment quotes the OLD origin:'*' config.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/origin:\s*'\*'/.test(code), "CORS config must not contain origin:'*'");
    assert.ok(src.includes('CORS_ALLOWED_ORIGINS.includes(origin)'), 'CORS must use the allowlist');
    assert.ok(src.includes('if (!origin) return cb(null, true)'), 'no-Origin requests (Android/curl) must stay allowed');
    const r = await req('GET', '/api/health'); // no Origin header
    assert.equal(r.status, 503, 'no-Origin request must reach the handler, not be CORS-blocked');
    const evil = await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.headers['access-control-allow-origin'], undefined);
});
