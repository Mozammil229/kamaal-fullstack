// 4E F-09 — resolveKey DB-failure leak regression test.
//
// Own process (own file) on purpose: it installs a THROWING KamaalApiKey
// stub into require.cache before the app loads, which no other suite may
// share. The thrown error carries a distinctive fake secret
// ('MONGO-SECRET-LEAK-…'); the response must NEVER contain it — a
// DB-layer failure inside resolveKey must surface only the generic
// 503 'Database offline. Please try again.', never the raw message.
//
// Run: `node --test tests/4e-resolvekey-leak.test.js`

'use strict';

require('./4d-pwa-stubs');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Throwing KamaalApiKey stub — installed BEFORE the app (and therefore
// kamaalApiController) is required.
const LEAK_MARKER = 'MONGO-SECRET-LEAK-9f27c1';
const resolved = require.resolve('../src/models/KamaalApiKey');
require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
        findOne() {
            return {
                lean() {
                    throw new Error(`query failed: ${LEAK_MARKER} mongodb://admin:hunter2@atlas`);
                }
            };
        }
    }
};

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

describe('F-09 resolveKey DB-failure leak', () => {
    it('POST /api/v1/chat with a failing key lookup -> generic 503, no raw internals', async () => {
        const res = await fetch(`${base}/api/v1/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Kamaal-Key': 'kml_testkey' },
            body: JSON.stringify({ message: 'hello' })
        });
        const text = await res.text();
        assert.equal(res.status, 503);
        assert.ok(!text.includes(LEAK_MARKER), 'response must not leak the raw DB error');
        assert.ok(!text.includes('hunter2'), 'response must not leak raw internals');
        assert.ok(text.includes('Database offline'), 'response carries the generic message');
    });

    it('GET /api/v1/status with a failing key lookup -> generic 503, no raw internals', async () => {
        const res = await fetch(`${base}/api/v1/status`, {
            headers: { 'X-Kamaal-Key': 'kml_testkey' }
        });
        const text = await res.text();
        assert.equal(res.status, 503);
        assert.ok(!text.includes(LEAK_MARKER), 'response must not leak the raw DB error');
    });
});
