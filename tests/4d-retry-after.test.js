// 4D (W4) — Retry-After regression tests for the BESPOKE route limiters.
//
// W2 put Retry-After on the shared middleware (src/middleware/rateLimit.js)
// and on the 4D PWA limiters, but the pre-4D bespoke in-memory limiters
// (aiRoutes, authRoutes login, kamaalApiRoutes, newsRoutes, opsRoutes,
// flowSyncRoutes, patchRoutes) still answered 429 with no Retry-After.
// W4 added the one-line header to all 10 sites; this file proves it:
//
//   1. LIVE: the legacy Android login limiter (POST /api/auth/login,
//      10/min/IP) returns 429 with a numeric Retry-After in 1..60.
//   2. STATIC: every bespoke 429 site in those 7 route files sets
//      Retry-After first (10 sites total).
//
// Run: `node --test tests/4d-retry-after.test.js`
// (Own process, like the other 4D suites, so the login bucket starts empty.)

'use strict';

require('./4d-pwa-stubs');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

describe('bespoke limiter Retry-After (W4)', () => {
    it('legacy login limiter: 11th attempt -> 429 with numeric Retry-After 1..60', async () => {
        let last429 = null;
        for (let i = 0; i < 11; i++) {
            const res = await fetch(`${base}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: `retryuser${i}`, password: 'wrong-password' })
            });
            if (res.status === 429) last429 = res;
            await res.text();
        }
        assert.ok(last429, 'expected a 429 from the login limiter within 11 attempts');
        const retryAfter = last429.headers.get('retry-after');
        assert.ok(retryAfter !== null, '429 must carry a Retry-After header');
        const n = Number(retryAfter);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= 60, `Retry-After must be an integer 1..60, got ${retryAfter}`);
    });

    it('all 10 bespoke 429 sites set Retry-After (static)', () => {
        const files = [
            'src/routes/aiRoutes.js',
            'src/routes/authRoutes.js',
            'src/routes/kamaalApiRoutes.js',
            'src/routes/newsRoutes.js',
            'src/routes/opsRoutes.js',
            'src/routes/flowSyncRoutes.js',
            'src/routes/patchRoutes.js'
        ];
        let sites = 0;
        for (const f of files) {
            const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
            const hits = src.match(/res\.setHeader\('Retry-After'/g) || [];
            const returns = src.match(/return res\.status\(429\)/g) || [];
            assert.equal(hits.length, returns.length, `${f}: every 429 return needs a Retry-After set (${hits.length} headers vs ${returns.length} returns)`);
            sites += hits.length;
        }
        assert.equal(sites, 10, `expected 10 bespoke Retry-After sites, got ${sites}`);
    });
});
