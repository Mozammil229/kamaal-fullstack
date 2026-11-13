// P-1b (D-12c, HOLD MODEL) — hold / commit / release / expiry tests.
//
// Boots the REAL app over HTTP with the shared 4D in-memory stubs
// (tests/4d-pwa-stubs.js: stubbed db + User + Transaction) plus in-memory
// PatchAuthorization + PatchRecipe stubs installed here before the app
// loads — the same require.cache pattern as tests/p1-confirm-patch.test.js.
// Test users are cloned from the stub store per test (fresh username =
// fresh rate-limit bucket + exact starting credits), so tests are
// independent of each other and of the P-1 file's balances.
//
// The stub has no TTL sweeper, so an expired row stays readable —
// exactly what the expiry tests need (in production the TTL deletes the
// row, which presents the same way: the hold no longer counts).
//
// Run: `node --test tests/p1b-hold-model.test.js`

'use strict';

require('./4d-pwa-stubs');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { users, txRows } = require('./4d-pwa-stubs');

// --- in-memory PatchAuthorization stub --------------------------------------
// Same contract as the P-1 stub, plus countDocuments (live-hold count)
// and findOneAndDelete (release-patch). Matches the Mongoose contract
// closely enough that the controllers cannot tell it apart.
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
    },
    async findOneAndDelete(filter) {
        const idx = authRows.findIndex((r) => matchesAuth(r, filter));
        if (idx === -1) return null;
        return authRows.splice(idx, 1)[0];
    },
    async countDocuments(query) {
        return authRows.filter((r) => matchesAuth(r, query)).length;
    }
};

// --- in-memory PatchRecipe stub (requestRecipe issues a row) ---------------
const recipeRows = [];
const stubPatchRecipe = {
    _rows: recipeRows,
    async create(data) {
        const row = { ...data, _id: new mongoose.Types.ObjectId().toString() };
        recipeRows.push(row);
        return row;
    },
    async findOne(query) {
        return recipeRows.find((r) => Object.entries(query).every(([k, v]) => String(r[k]) === String(v))) || null;
    },
    async findOneAndUpdate(filter, update) {
        const row = recipeRows.find((r) => Object.entries(filter).every(([k, v]) => String(r[k]) === String(v)));
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
installStub('../src/models/PatchRecipe', stubPatchRecipe);

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

async function post(path, username, body) {
    const r = await req('POST', path, { headers: authHeaders(username), body: JSON.stringify(body) });
    let json = null;
    try { json = JSON.parse(r.body); } catch (_) { /* non-JSON body */ }
    return { ...r, json };
}

async function balance(username) {
    const r = await req('GET', '/api/credits', { headers: authHeaders(username) });
    assert.equal(r.status, 200, `GET /api/credits must be 200, got ${r.status}: ${r.body}`);
    return JSON.parse(r.body);
}

// Fresh stub user per test: exact starting credits, fresh rate-limit
// buckets, no shared balances with other tests.
function ensureUser(username, credits) {
    let u = users.find((x) => x.username === username);
    if (!u) {
        u = {
            ...users[0],
            _id: new mongoose.Types.ObjectId().toString(),
            username,
            name: `P1B ${username}`,
            email: `${username}@kamaal.test`,
            phone: '',
            deviceId: ''
        };
        users.push(u);
    }
    u.credits = credits;
    u.creditsEarned = 0;
    u.holdSeq = 0;
    u.stats = { videosPatched: 0, videosEnhanced4K: 0, totalBandwidthBytes: 0 };
    return u;
}

function liveHolds(username) {
    const now = new Date();
    return authRows.filter((r) => r.username === username && !r.used && new Date(r.expiresAt) > now).length;
}

function findRow(token) {
    return authRows.find((r) => r.token === token);
}

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

test('P1B-MOUNT: POST /api/release-patch without auth is 401, never 404 (route is mounted)', async () => {
    const r = await req('POST', '/api/release-patch', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authToken: 'whatever' })
    });
    assert.equal(r.status, 401, `unauthed release must be 401, got ${r.status}`);
});

test('P1B-HOLD: authorize holds 1, deducts NOTHING, reports held/available, writes no ledger row', async () => {
    ensureUser('p1b-hold', 5);
    const txBefore = txRows.length;
    const r = await post('/api/authorize-patch', 'p1b-hold', {});
    assert.equal(r.status, 200, `authorize must be 200, got ${r.status}: ${r.body}`);
    assert.equal(r.json.authorized, true);
    assert.ok(typeof r.json.authToken === 'string' && r.json.authToken.length > 10, 'authorize must mint a token');
    const b = await balance('p1b-hold');
    assert.equal(b.credits, 5, 'authorize must NOT deduct — balance stays 5');
    assert.equal(b.creditsHeld, 1, 'one live hold must be reported');
    assert.equal(b.creditsAvailable, 4, 'available must be credits minus holds');
    assert.equal(r.json.creditsHeld, 1);
    assert.equal(r.json.creditsAvailable, 4);
    assert.equal(liveHolds('p1b-hold'), 1);
    assert.equal(txRows.length, txBefore, 'authorize must write NO ledger row (no money moved)');
    const row = findRow(r.json.authToken);
    assert.ok(row, 'auth row must exist in the store');
    assert.equal(row.used, false);
});

test('P1B-402-ZERO: authorize with 0 credits -> 402, no row minted', async () => {
    ensureUser('p1b-zero', 0);
    const before = authRows.length;
    const r = await post('/api/authorize-patch', 'p1b-zero', {});
    assert.equal(r.status, 402, `0-credit authorize must be 402, got ${r.status}: ${r.body}`);
    assert.equal(r.json.authorized, false);
    assert.equal(authRows.length, before, 'a refused authorize must mint no row');
});

test('P1B-DOUBLE-HOLD: 1 credit, second authorize -> 402 (one credit held twice is impossible)', async () => {
    ensureUser('p1b-last', 1);
    const first = await post('/api/authorize-patch', 'p1b-last', {});
    assert.equal(first.status, 200, `first authorize must be 200, got ${first.status}: ${first.body}`);
    const second = await post('/api/authorize-patch', 'p1b-last', {});
    assert.equal(second.status, 402, `second authorize on the last credit must be 402, got ${second.status}: ${second.body}`);
    assert.equal(liveHolds('p1b-last'), 1, 'exactly one live hold must exist');
    const b = await balance('p1b-last');
    assert.equal(b.credits, 1, 'balance untouched by holds');
    assert.equal(b.creditsAvailable, 0);
});

test('P1B-CONCURRENT: two parallel authorizes for the last credit — exactly one 200, one 402', async () => {
    ensureUser('p1b-race', 1);
    const [a, b] = await Promise.all([
        post('/api/authorize-patch', 'p1b-race', {}),
        post('/api/authorize-patch', 'p1b-race', {})
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 402], `concurrent authorizes must split 200/402, got ${a.status}/${b.status}`);
    assert.equal(liveHolds('p1b-race'), 1, 'exactly one live hold after the race');
    assert.equal((await balance('p1b-race')).credits, 1, 'balance untouched by holds');
});

test('P1B-CONFIRM-COMMITS: authorize (no deduct) -> confirm deducts exactly 1 + writes one usage_deduct ledger row', async () => {
    ensureUser('p1b-commit', 3);
    const auth = await post('/api/authorize-patch', 'p1b-commit', {});
    assert.equal(auth.status, 200);
    assert.equal((await balance('p1b-commit')).credits, 3, 'balance still 3 after authorize');
    const txBefore = txRows.length;
    const c = await post('/api/confirm-patch', 'p1b-commit', { authToken: auth.json.authToken });
    assert.equal(c.status, 200, `confirm must be 200, got ${c.status}: ${c.body}`);
    assert.equal(c.json.confirmed, true);
    const b = await balance('p1b-commit');
    assert.equal(b.credits, 2, 'confirm must deduct exactly 1');
    assert.equal(b.creditsHeld, 0, 'the hold converts to a deduction — no live hold left');
    const newTx = txRows.slice(txBefore);
    assert.equal(newTx.length, 1, `confirm must write exactly one ledger row, got ${newTx.length}`);
    assert.equal(newTx[0].type, 'usage_deduct');
    assert.equal(newTx[0].creditsChange, -1);
    assert.equal(newTx[0].newBalance, 2);
});

test('P1B-CONFIRM-REPEAT: second confirm is 200 alreadyConfirmed and deducts nothing more', async () => {
    ensureUser('p1b-repeat', 2);
    const auth = await post('/api/authorize-patch', 'p1b-repeat', {});
    assert.equal(auth.status, 200);
    const first = await post('/api/confirm-patch', 'p1b-repeat', { authToken: auth.json.authToken });
    assert.equal(first.status, 200);
    assert.equal((await balance('p1b-repeat')).credits, 1);
    const second = await post('/api/confirm-patch', 'p1b-repeat', { authToken: auth.json.authToken });
    assert.equal(second.status, 200, `repeat confirm must be 200, got ${second.status}`);
    assert.equal(second.json.alreadyConfirmed, true);
    assert.equal((await balance('p1b-repeat')).credits, 1, 'repeat confirm must not deduct again');
});

test('P1B-CONFIRM-402-ROLLBACK: held credit spent elsewhere -> confirm is 402, token stays live (fail closed)', async () => {
    ensureUser('p1b-rollback', 1);
    const auth = await post('/api/authorize-patch', 'p1b-rollback', {});
    assert.equal(auth.status, 200);
    // Spend the held credit through the unrelated deduct endpoint (Q10:
    // deduct does not respect holds) — the hold is now uncovered.
    const d = await post('/api/deduct', 'p1b-rollback', { amount: 1, reason: 'test spend' });
    assert.equal(d.status, 200, `deduct must be 200, got ${d.status}: ${d.body}`);
    assert.equal((await balance('p1b-rollback')).credits, 0);
    const c = await post('/api/confirm-patch', 'p1b-rollback', { authToken: auth.json.authToken });
    assert.equal(c.status, 402, `uncovered confirm must be 402, got ${c.status}: ${c.body}`);
    assert.equal(c.json.confirmed, false);
    const row = findRow(auth.json.authToken);
    assert.ok(row, 'row must still exist after a failed confirm');
    assert.equal(row.used, false, 'failed confirm must NOT flip used — the token stays usable');
    const c2 = await post('/api/confirm-patch', 'p1b-rollback', { authToken: auth.json.authToken });
    assert.equal(c2.status, 402, 'retry confirm must still be 402 (not alreadyConfirmed, not 404)');
});

test('P1B-RELEASE: release frees the hold (balance untouched), authorize works again; unknown/wrong-user -> 404', async () => {
    ensureUser('p1b-release', 2);
    const auth = await post('/api/authorize-patch', 'p1b-release', {});
    assert.equal(auth.status, 200);
    assert.equal((await balance('p1b-release')).creditsHeld, 1);
    const rel = await post('/api/release-patch', 'p1b-release', { authToken: auth.json.authToken });
    assert.equal(rel.status, 200, `release must be 200, got ${rel.status}: ${rel.body}`);
    assert.equal(rel.json.released, true);
    const b = await balance('p1b-release');
    assert.equal(b.credits, 2, 'release moves no money');
    assert.equal(b.creditsHeld, 0, 'hold must be freed');
    assert.equal(findRow(auth.json.authToken), undefined, 'released row must be gone');
    const again = await post('/api/authorize-patch', 'p1b-release', {});
    assert.equal(again.status, 200, 'authorize must work again after release');
    const relAgain = await post('/api/release-patch', 'p1b-release', { authToken: auth.json.authToken });
    assert.equal(relAgain.status, 404, 're-releasing the same token must be 404 (row is gone)');
    const relUnknown = await post('/api/release-patch', 'p1b-release', { authToken: 'no-such-token' });
    assert.equal(relUnknown.status, 404, 'releasing an unknown token must be 404');
    const relWrongUser = await post('/api/release-patch', 'p1b-release2', { authToken: again.json.authToken });
    assert.equal(relWrongUser.status, 404, 'releasing another user\'s token must be 404 (never reveals the row)');
    assert.equal(liveHolds('p1b-release'), 1, 'wrong-user release must not touch the live hold');
});

test('P1B-RELEASE-USED-409: releasing an already-confirmed token -> 409, deduction stands', async () => {
    ensureUser('p1b-relused', 2);
    const auth = await post('/api/authorize-patch', 'p1b-relused', {});
    assert.equal(auth.status, 200);
    const c = await post('/api/confirm-patch', 'p1b-relused', { authToken: auth.json.authToken });
    assert.equal(c.status, 200);
    assert.equal((await balance('p1b-relused')).credits, 1);
    const rel = await post('/api/release-patch', 'p1b-relused', { authToken: auth.json.authToken });
    assert.equal(rel.status, 409, `releasing a confirmed token must be 409, got ${rel.status}: ${rel.body}`);
    assert.equal(rel.json.released, false);
    assert.equal((await balance('p1b-relused')).credits, 1, 'the deduction must stand after a 409 release');
});

test('P1B-EXPIRY: an expired hold releases itself — authorize works again, confirm on it is 410', async () => {
    ensureUser('p1b-expiry', 1);
    const auth = await post('/api/authorize-patch', 'p1b-expiry', {});
    assert.equal(auth.status, 200);
    // Expire the row in place (the stub has no TTL sweeper; production
    // deletes it via TTL — either way the hold must stop counting).
    const row = findRow(auth.json.authToken);
    row.expiresAt = new Date(Date.now() - 60 * 1000);
    assert.equal(liveHolds('p1b-expiry'), 0, 'expired row must not count as a hold');
    assert.equal((await balance('p1b-expiry')).creditsAvailable, 1, 'available must recover on expiry');
    const again = await post('/api/authorize-patch', 'p1b-expiry', {});
    assert.equal(again.status, 200, `authorize after expiry must succeed, got ${again.status}: ${again.body}`);
    const c = await post('/api/confirm-patch', 'p1b-expiry', { authToken: auth.json.authToken });
    assert.equal(c.status, 410, `confirm on the expired token must be 410, got ${c.status}: ${c.body}`);
    assert.equal(c.json.confirmed, false);
    assert.equal((await balance('p1b-expiry')).credits, 1, 'expiry + 410 confirm must move no money');
});

test('P1B-RELEASE-RL: POST /api/release-patch 10/min/user — 11th request is 429 with Retry-After', async () => {
    const statuses = [];
    let retryAfter = null;
    for (let i = 0; i < 11; i++) {
        const r = await post('/api/release-patch', 'p1b-rl', { authToken: `p1b-rl-token-${i}` });
        statuses.push(r.status);
        if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    assert.ok(!statuses.slice(0, 10).includes(429), `first 10 releases must not be rate-limited, got ${statuses}`);
    assert.equal(statuses[10], 429, `11th release must be 429, got ${statuses}`);
    assert.ok(retryAfter, 'release-patch 429 must carry Retry-After');
});

test('P1B-RECIPE-COMMITS: Android flow — authorize (hold) -> requestRecipe deducts exactly 1 -> confirm is alreadyConfirmed, no second deduct', async () => {
    ensureUser('p1b-recipe', 2);
    const auth = await post('/api/authorize-patch', 'p1b-recipe', {});
    assert.equal(auth.status, 200);
    assert.equal((await balance('p1b-recipe')).credits, 2, 'balance still 2 after authorize');
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const devicePubkeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const rec = await post('/api/patch/request', 'p1b-recipe', {
        method: 'normal',
        devicePubkeyPem,
        deviceId: 'p1b-recipe-device',
        authToken: auth.json.authToken
    });
    assert.equal(rec.status, 200, `requestRecipe must be 200, got ${rec.status}: ${rec.body}`);
    assert.ok(rec.json.recipeId, 'recipe must be issued');
    const b = await balance('p1b-recipe');
    assert.equal(b.credits, 1, 'requestRecipe must commit the hold (deduct exactly 1)');
    assert.equal(b.creditsHeld, 0, 'no live hold left after the recipe commit');
    const c = await post('/api/confirm-patch', 'p1b-recipe', { authToken: auth.json.authToken });
    assert.equal(c.status, 200, `confirm after recipe must be 200 alreadyConfirmed, got ${c.status}: ${c.body}`);
    assert.equal(c.json.alreadyConfirmed, true);
    assert.equal((await balance('p1b-recipe')).credits, 1, 'confirm after recipe must NOT deduct a second credit');
});
