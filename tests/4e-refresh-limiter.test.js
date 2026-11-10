// 4E F-05 — refresh limiter regression test.
//
// Own process (own file) on purpose: the test deliberately exhausts the
// 30/min/IP refresh bucket, which would 429 every other refresh call in
// the same process. The limiter runs BEFORE the handler, so no cookies
// are needed — the first 30 attempts reach the handler (401, no cookie)
// and the 31st is 429 with a numeric Retry-After.
//
// Run: `node --test tests/4e-refresh-limiter.test.js`

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

describe('F-05 refresh limiter', () => {
    it('31st refresh in a minute -> 429 with numeric Retry-After 1..60', async () => {
        let last429 = null;
        let saw401 = 0;
        for (let i = 0; i < 31; i++) {
            const res = await fetch(`${base}/api/pwa/auth/refresh`, { method: 'POST' });
            if (res.status === 401) saw401 += 1;
            if (res.status === 429) last429 = res;
            await res.text();
        }
        assert.equal(saw401, 30, 'first 30 refresh attempts reach the handler (401, no cookie)');
        assert.ok(last429, 'expected a 429 from the refresh limiter on the 31st attempt');
        const retryAfter = last429.headers.get('retry-after');
        assert.ok(retryAfter !== null, '429 must carry a Retry-After header');
        const n = Number(retryAfter);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= 60, `Retry-After must be an integer 1..60, got ${retryAfter}`);
    });
});
