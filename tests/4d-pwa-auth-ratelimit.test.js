// 4D (PWA cookie auth) — rate-limit tests, separate file on purpose:
// node --test runs each file in its own process, so the in-memory login
// buckets start empty here. (The functional suite keeps its own login
// count under the same limits; mixing the 429 probes in would trip them.)
//
// Run: `node --test tests/4d-pwa-auth-ratelimit.test.js`

'use strict';

require('./4d-pwa-stubs');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

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

async function loginAttempt(username, password = 'wrong-password') {
    const res = await fetch(`${base}/api/pwa/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return res.status;
}

describe('PWA login rate limits', () => {
    it('5/min per username: the 6th attempt for one username -> 429', async () => {
        const statuses = [];
        for (let i = 0; i < 6; i++) statuses.push(await loginAttempt('rluser'));
        assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
        assert.equal(statuses[5], 429);
    });

    it('10/min per IP: a 429 appears once the IP budget is spent', async () => {
        // 6 attempts above already spent 6 of the 10/IP budget.
        const statuses = [];
        for (let i = 0; i < 6; i++) statuses.push(await loginAttempt(`ipuser${i}`));
        assert.ok(statuses.includes(429), `expected a 429 within the IP-budget probe, got ${statuses}`);
    });
});
