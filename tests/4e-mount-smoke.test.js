// 4E F-10 / T3 (mount half) — backend mount-smoke test.
//
// Boots the REAL app and hits EVERY inventoried endpoint — all 62 rows in
// `~/workspace/kamaal-pwa/docs/CONTRACT_INVENTORY.md` (58 ApiService rows +
// 4 PWA rows), with the correct method per row — and asserts the response
// is NOT 404. 401/400/503/200 all prove the route is mounted; a 500 also
// proves mount but is logged (console) if it occurs so a real handler
// crash is visible, not hidden.
//
// Runs WITHOUT MongoDB: User / RefreshToken / RevokedToken / AppConfig /
// db are stubbed in-memory via tests/4d-pwa-stubs.js (same pattern as the
// 4D suites), plus two extra stubs installed here before the app loads:
//   - Device: register/resolve would otherwise hit a real unconnected
//     Mongoose model (10s buffer timeout each).
//   - Poll: GET /api/polls/active is public and reads Poll the same way.
// Anything else un-stubbed sits BEHIND authenticateUser, so the 401 fires
// before any DB touch.
//
// This closes the MOUNT half of T3 only. Full BEHAVIOUR tests for the 30
// untested rows need real MongoDB and stay owed to staging — do not read
// a green run here as behaviour coverage.
//
// Run: `node --test tests/4e-mount-smoke.test.js`

'use strict';

require('./4d-pwa-stubs');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// --- extra stubs (see header comment) ---------------------------------------
function fakeQuery(value) {
    const q = {
        select() { return q; },
        sort() { return q; },
        limit() { return q; },
        lean() { return Promise.resolve(value); },
        then(res, rej) { return Promise.resolve(value).then(res, rej); },
        catch(err) { return Promise.resolve(value).catch(err); }
    };
    return q;
}

function installStub(relativePath, exportsObj) {
    const resolved = require.resolve(relativePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

installStub('../src/models/Device', {
    async findOneAndUpdate() {
        return { displayId: 'KML-SMOKE', userId: null };
    },
    async findOne() { return null; }
});
installStub('../src/models/Poll', {
    findOne() { return fakeQuery(null); },
    findById() { return fakeQuery(null); }
});

const app = require('../src/app');

let server;
let base;

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

// All 62 rows of CONTRACT_INVENTORY.md, method + path. Bodies are minimal
// plausible payloads (auth-gated rows 401 before reading them; public rows
// get what they need to answer instead of 400ing on validation).
const ROWS = [
    ['POST', '/api/auth/register', { username: 'smokeuser', email: 'smoke@kamaal.test', password: 'SmokePass123' }],
    ['POST', '/api/register', { username: 'smokeuser', email: 'smoke@kamaal.test', password: 'SmokePass123' }],
    ['POST', '/api/auth/login', { username: 'smokeuser', password: 'wrong' }],
    ['POST', '/api/auth/logout', {}],
    ['POST', '/api/login', { username: 'smokeuser', password: 'wrong' }],
    ['POST', '/api/device/register', { deviceHash: 'a'.repeat(64), displayId: 'KML-SMOKE', model: 'smoke', appVersion: '1.0' }],
    ['POST', '/api/device/resolve', { deviceHash: 'a'.repeat(64) }],
    ['POST', '/api/deduct', {}],
    ['POST', '/api/authorize-patch', {}],
    ['POST', '/api/patch/request', {}],
    ['POST', '/api/patch/apply', {}],
    ['GET', '/api/auth/pubkey', null],
    ['GET', '/api/news', null],
    ['GET', '/api/news/search?q=test', null],
    ['GET', '/api/credits', null],
    ['POST', '/api/redeem', {}],
    ['POST', '/api/support/send', {}],
    ['GET', '/api/support/messages', null],
    ['GET', '/api/auth/verify', null],
    ['GET', '/api/verify', null],
    ['POST', '/api/referral/apply', {}],
    ['GET', '/api/referral/my', null],
    ['GET', '/api/health', null],
    ['GET', '/api/app-config', null],
    ['GET', '/api/chat/messages', null],
    ['POST', '/api/chat/send', {}],
    ['POST', '/api/chat/react', {}],
    ['POST', '/api/payment/submit-proof', {}],
    ['GET', '/api/polls/active', null],
    ['POST', '/api/polls/vote', {}],
    ['POST', '/api/chat', { message: 'hi' }],
    ['POST', '/api/flow/generate', {}],
    ['POST', '/api/wink/sign', {}],
    ['POST', '/api/wink/policy', {}],
    ['POST', '/api/wink/video-info', {}],
    ['POST', '/api/wink/transcode/start', {}],
    ['GET', '/api/wink/transcode/status', null],
    ['POST', '/api/wink/delivery', {}],
    ['GET', '/api/wink/result', null],
    ['GET', '/api/app/status', null],
    ['GET', '/api/ai/system-prompt', null],
    ['POST', '/api/ai/system-prompt', {}],
    ['POST', '/api/ai/chat', { message: 'hi' }],
    ['GET', '/api/ai/usage', null],
    ['POST', '/api/ai/usage/report', {}],
    ['POST', '/api/live/token', {}],
    ['GET', '/api/ai/memory', null],
    ['DELETE', '/api/ai/memory/test-fact-id', null],
    ['DELETE', '/api/ai/memory', null],
    ['POST', '/api/ai/memory/settings', {}],
    ['POST', '/api/extract', {}],
    ['POST', '/api/extract/resolve', {}],
    ['GET', '/api/app/version', null],
    ['GET', '/api/donut/feed', null],
    ['POST', '/api/online-tool/token', {}],
    ['POST', '/api/crash-reports', {}],
    ['GET', '/api/messages', null],
    ['POST', '/api/messages', {}],
    ['POST', '/api/pwa/auth/login', { username: 'smokeuser', password: 'wrong' }],
    ['POST', '/api/pwa/auth/refresh', null],
    ['POST', '/api/pwa/auth/logout', null],
    ['POST', '/api/pwa/auth/logout-everywhere', null]
];

describe('T3 mount smoke: all 62 inventoried endpoints are mounted', () => {
    it('no row returns 404', async () => {
        assert.equal(ROWS.length, 62, 'inventory row count must stay 62 (58 + 4 PWA)');
        const failures = [];
        const fiveHundreds = [];
        for (const [method, path, body] of ROWS) {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: body !== null && body !== undefined ? { 'Content-Type': 'application/json' } : {},
                body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(20000)
            });
            await res.text();
            if (res.status === 404) failures.push(`${method} ${path}`);
            if (res.status >= 500) fiveHundreds.push(`${method} ${path} -> ${res.status}`);
        }
        if (fiveHundreds.length > 0) {
            // 500 proves mount, but log it — a real handler crash must stay visible.
            console.log('[mount-smoke] 500s (mounted, handler errored — see staging for behaviour):', fiveHundreds.join(', '));
        }
        assert.deepEqual(failures, [], `unmounted endpoints (404): ${failures.join(', ')}`);
    });
});
