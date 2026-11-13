// P-1 (D-12b, server confirm) — POST /api/confirm-patch behaviour tests.
//
// Boots the REAL app over HTTP with the shared 4D in-memory stubs
// (tests/4d-pwa-stubs.js: stubbed db + User) plus an in-memory
// PatchAuthorization stub installed here before the app loads — the same
// require.cache pattern as tests/4e-mount-smoke.test.js. Rows are seeded
// directly into the stub store (authorize-patch itself is NOT called:
// its ledger path needs a real modifyCredits/User findOneAndUpdate).
// The stub has no TTL sweeper, so an expired row stays readable —
// exactly what the 410 case needs (in production a TTL-deleted row
// presents as 404 instead).
//
// Run: `node --test tests/p1-confirm-patch.test.js`

'use strict';

require('./4d-pwa-stubs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// --- in-memory PatchAuthorization stub --------------------------------------
// Supports the two ops confirmPatch uses: findOne ({token, username})
// and findOneAndUpdate (atomic flip guarded on used:false +
// expiresAt: {$gt: now}). Matches the Mongoose contract closely enough
// that the controller cannot tell it apart.
const authRows = [];

function matchesAuth(row, query) {
    for (const [key, val] of Object.entries(query)) {
        if (val && typeof val === 'object' && '$gt' in val) {
            if (!(row[key] > val.$gt)) return false;
            continue;
        }
        if (String(row[key]) !== String(val)) return false;
    }
    return true;
}

const stubPatchAuthorization = {
    _rows: authRows,
    async create(data) {
        const row = { ...data };
        authRows.push(row);
        return row;
    },
    async findOne(query) {
        return authRows.find((r) => matchesAuth(r, query)) || null;
    },
    async findOneAndUpdate(filter, update, options) {
        const row = authRows.find((r) => matchesAuth(r, filter));
        if (!row) return null;
        Object.assign(row, (update && update.$set) || {});
        return row;
    }
};

function installStub(relativePath, exportsObj) {
    const resolved = require.resolve(relativePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

installStub('../src/models/PatchAuthorization', stubPatchAuthorization);

const app = require('../src/app');

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

async function confirm(username, body) {
    const r = await req('POST', '/api/confirm-patch', {
        headers: authHeaders(username),
        body: JSON.stringify(body)
    });
    let json = null;
    try { json = JSON.parse(r.body); } catch (_) { /* non-JSON body */ }
    return { ...r, json };
}

function seedAuth({ token, username, used = false, expiresAt = new Date(Date.now() + 10 * 60 * 1000) }) {
    const row = { token, username, method: '', used, createdAt: new Date(), expiresAt };
    authRows.push(row);
    return row;
}

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

test('P1-MOUNT: POST /api/confirm-patch without auth is 401, never 404 (route is mounted)', async () => {
    const r = await req('POST', '/api/confirm-patch', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: 'whatever' })
    });
    assert.equal(r.status, 401, `unauthed confirm must be 401, got ${r.status}`);
});

test('P1-HAPPY: valid token flips used false->true, 200 {success:true, confirmed:true}', async () => {
    const row = seedAuth({ token: 'p1-happy-token', username: 'p1-happy' });
    assert.equal(row.used, false);
    const r = await confirm('p1-happy', { authToken: 'p1-happy-token' });
    assert.equal(r.status, 200, `happy-path confirm must be 200, got ${r.status}: ${r.body}`);
    assert.equal(r.json.success, true);
    assert.equal(r.json.confirmed, true);
    assert.equal(row.used, true, 'row must be flipped used:true in the store');
});

test('P1-400: missing authToken -> 400', async () => {
    const r = await confirm('p1-missing', {});
    assert.equal(r.status, 400, `missing token must be 400, got ${r.status}: ${r.body}`);
    assert.equal(r.json.confirmed, false);
    const r2 = await confirm('p1-missing', { authToken: '   ' });
    assert.equal(r2.status, 400, `blank token must be 400, got ${r2.status}`);
});

test('P1-404: unknown token -> 404', async () => {
    const r = await confirm('p1-unknown', { authToken: 'no-such-token' });
    assert.equal(r.status, 404, `unknown token must be 404, got ${r.status}: ${r.body}`);
    assert.equal(r.json.confirmed, false);
});

test('P1-410: row with past expiresAt (TTL not yet fired) -> 410', async () => {
    seedAuth({ token: 'p1-expired-token', username: 'p1-expired', expiresAt: new Date(Date.now() - 60 * 1000) });
    const r = await confirm('p1-expired', { authToken: 'p1-expired-token' });
    assert.equal(r.status, 410, `expired row must be 410, got ${r.status}: ${r.body}`);
    assert.equal(r.json.confirmed, false);
});

test('P1-IDEMPOTENT: repeat confirm -> 200 {confirmed:true, alreadyConfirmed:true}, row stays used', async () => {
    const row = seedAuth({ token: 'p1-repeat-token', username: 'p1-repeat' });
    const first = await confirm('p1-repeat', { authToken: 'p1-repeat-token' });
    assert.equal(first.status, 200);
    assert.equal(first.json.confirmed, true);
    assert.equal(first.json.alreadyConfirmed, undefined, 'first confirm must not claim alreadyConfirmed');
    const second = await confirm('p1-repeat', { authToken: 'p1-repeat-token' });
    assert.equal(second.status, 200, `repeat confirm must be 200, never an error, got ${second.status}`);
    assert.equal(second.json.success, true);
    assert.equal(second.json.confirmed, true);
    assert.equal(second.json.alreadyConfirmed, true);
    assert.equal(row.used, true);
});

test('P1-WRONG-USER: another user confirming the token -> 404, row untouched', async () => {
    const row = seedAuth({ token: 'p1-owner-token', username: 'p1-owner' });
    const r = await confirm('p1-other', { authToken: 'p1-owner-token' });
    assert.equal(r.status, 404, `wrong-user confirm must be 404 (never reveals the row), got ${r.status}: ${r.body}`);
    assert.equal(r.json.confirmed, false);
    assert.equal(row.used, false, 'row must stay unused after a wrong-user attempt');
});

test('P1-CREDITS: balance identical before/after confirm (no deduct, no refund)', async () => {
    // pwauser is a stubbed 4D user with credits: 5.
    async function balance() {
        const r = await req('GET', '/api/credits', { headers: authHeaders('pwauser') });
        assert.equal(r.status, 200, `GET /api/credits must be 200, got ${r.status}: ${r.body}`);
        return JSON.parse(r.body).credits;
    }
    const before = await balance();
    seedAuth({ token: 'p1-credits-token', username: 'pwauser' });
    const r = await confirm('pwauser', { authToken: 'p1-credits-token' });
    assert.equal(r.status, 200);
    const after = await balance();
    assert.equal(after, before, `confirm must not move credits: before=${before} after=${after}`);
});

test('P1-RL: POST /api/confirm-patch 10/min/user — 11th request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 11; i++) {
        const r = await confirm('p1-rl-user', { authToken: `p1-rl-token-${i}` });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.ok(!statuses.slice(0, 10).includes(429), `first 10 confirms must not be rate-limited, got ${statuses}`);
    assert.equal(statuses[10], 429, `11th confirm must be 429, got ${statuses}`);
    assert.ok(retryAfter, 'confirm-patch 429 must carry Retry-After');
});
