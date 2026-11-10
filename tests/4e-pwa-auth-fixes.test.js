// 4E — PWA backend auth fixes (BugHunter 4E findings F-01..F-09).
//
// Run: `node --test tests/4e-pwa-auth-fixes.test.js` (Node built-in runner).
// Real HTTP against a real Express app; User / RefreshToken / RevokedToken /
// AppConfig are stubbed in-memory via tests/4d-pwa-stubs.js — same pattern
// as the 4D suites, no Mongo.
//
// Login-count budget: the pwa login limiters (10/min/IP, 5/min/username)
// are live in this process, so logins are spread over the 4 seeded users
// and kept well under 10 total. The refresh limiter test lives in its own
// file (tests/4e-refresh-limiter.test.js) because it deliberately exhausts
// the 30/min refresh bucket for the whole process IP.

'use strict';

const stubs = require('./4d-pwa-stubs');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const app = require('../src/app');

const PASSWORD = 'correct-password';
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

// --- tiny cookie jar over fetch --------------------------------------------

function storeCookies(jar, res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
        const pair = c.split(';')[0];
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1);
        if (val === '') delete jar[name];
        else jar[name] = val;
    }
    return setCookies;
}

function jarHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function call(method, path, { jar = null, headers = {}, body = undefined } = {}) {
    const h = { ...headers };
    if (jar && Object.keys(jar).length > 0) h.Cookie = jarHeader(jar);
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
        method,
        headers: h,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    const setCookies = storeCookies(jar || {}, res);
    return { status: res.status, json, text, setCookies, headers: res.headers };
}

async function pwaLogin(username, extraHeaders = {}) {
    const jar = {};
    const res = await call('POST', '/api/pwa/auth/login', { jar, headers: extraHeaders, body: { username, password: PASSWORD } });
    return { jar, res };
}

function cookieAttrs(setCookies, name) {
    const line = setCookies.find((c) => c.split(';')[0].split('=')[0] === name);
    assert.ok(line, `expected a Set-Cookie for ${name}`);
    return line.toLowerCase();
}

// --- F-01: SameSite=None on HTTPS, Lax on plain HTTP -----------------------

describe('F-01 SameSite', () => {
    it('HTTPS login: all session cookies are SameSite=None; Secure', async () => {
        const { res } = await pwaLogin('pwauser', { 'X-Forwarded-Proto': 'https' });
        assert.equal(res.status, 200);
        for (const name of ['kamaal_access', 'kamaal_refresh', 'kamaal_csrf']) {
            const attrs = cookieAttrs(res.setCookies, name);
            assert.ok(attrs.includes('samesite=none'), `${name} must be SameSite=None on HTTPS, got: ${attrs}`);
            assert.ok(attrs.includes('secure'), `${name} must be Secure on HTTPS, got: ${attrs}`);
        }
    });

    it('plain HTTP login: all session cookies stay SameSite=Lax, no Secure', async () => {
        const { res } = await pwaLogin('pwauser2');
        assert.equal(res.status, 200);
        for (const name of ['kamaal_access', 'kamaal_refresh', 'kamaal_csrf']) {
            const attrs = cookieAttrs(res.setCookies, name);
            assert.ok(attrs.includes('samesite=lax'), `${name} must stay SameSite=Lax on plain HTTP, got: ${attrs}`);
            assert.ok(!attrs.includes('secure'), `${name} must NOT be Secure on plain HTTP, got: ${attrs}`);
        }
    });
});

// --- F-02 (endpoint): GET /api/pwa/auth/csrf --------------------------------

describe('F-02 csrf endpoint', () => {
    it('401 with no cookie', async () => {
        const res = await call('GET', '/api/pwa/auth/csrf');
        assert.equal(res.status, 401);
    });

    it('200 + token echo with a valid access cookie', async () => {
        const { jar } = await pwaLogin('pwauser3');
        const res = await call('GET', '/api/pwa/auth/csrf', { jar });
        assert.equal(res.status, 200);
        assert.equal(res.json.csrfToken, jar.kamaal_csrf);
    });

    it('200 + mint-and-set when the csrf cookie is absent', async () => {
        const { jar } = await pwaLogin('pwauser4');
        delete jar.kamaal_csrf;
        const res = await call('GET', '/api/pwa/auth/csrf', { jar });
        assert.equal(res.status, 200);
        assert.ok(typeof res.json.csrfToken === 'string' && res.json.csrfToken.length >= 32);
        // The minted value must arrive as the kamaal_csrf cookie too.
        assert.equal(jar.kamaal_csrf, res.json.csrfToken);
        assert.ok(res.setCookies.some((c) => c.startsWith('kamaal_csrf=')));
    });

    it('200 with a valid admin cookie (admin sessions need a CSRF value too)', async () => {
        const jar = {};
        const login = await call('POST', '/api/admin/login', { jar, body: { username: 'admin', password: 'correct-admin-pass' } });
        assert.equal(login.status, 200);
        assert.ok(jar.kamaal_admin, 'admin cookie set');
        assert.ok(jar.kamaal_csrf, 'admin login also sets/rotates the csrf cookie (F-02)');
        const res = await call('GET', '/api/pwa/auth/csrf', { jar });
        assert.equal(res.status, 200);
        assert.equal(res.json.csrfToken, jar.kamaal_csrf);
    });
});

// --- F-04: atomic refresh rotation -----------------------------------------
//
// Best test the stub-based suite allows: spy on the stub model's
// findOneAndUpdate and prove the rotation claims the row atomically
// (live-row filter) instead of check-then-act via updateOne. TRUE
// concurrency proof (two simultaneous presenters, one winner) needs real
// MongoDB — the in-memory stub has no concurrent writers — and stays owed
// to staging.

describe('F-04 atomic refresh rotation', () => {
    it('refresh claims the row via findOneAndUpdate with a live-row filter, never updateOne', async () => {
        const { jar } = await pwaLogin('pwauser');
        const oldRefresh = jar.kamaal_refresh;
        const seen = [];
        const origFindOneAndUpdate = stubs.stubRefreshToken.findOneAndUpdate;
        const origUpdateOne = stubs.stubRefreshToken.updateOne;
        let updateOneCalls = 0;
        stubs.stubRefreshToken.findOneAndUpdate = async (...args) => {
            seen.push(args);
            return origFindOneAndUpdate.apply(stubs.stubRefreshToken, args);
        };
        stubs.stubRefreshToken.updateOne = async (...args) => {
            updateOneCalls += 1;
            return origUpdateOne.apply(stubs.stubRefreshToken, args);
        };
        try {
            const res = await call('POST', '/api/pwa/auth/refresh', { jar });
            assert.equal(res.status, 200);
            assert.equal(seen.length, 1, 'rotation must claim via exactly one findOneAndUpdate');
            const [filter, update] = seen[0];
            assert.ok(filter.tokenHash, 'filter matches the presented token hash');
            assert.equal(filter.revokedAt, null, 'filter requires the row still live (revokedAt null)');
            assert.equal(filter.replacedByHash, null, 'filter requires the row still live (replacedByHash null)');
            assert.ok(update.$set.revokedAt, 'claim revokes the old row');
            assert.ok(update.$set.replacedByHash, 'claim records the replacement hash');
            assert.equal(updateOneCalls, 0, 'rotation must not use check-then-act updateOne');
        } finally {
            stubs.stubRefreshToken.findOneAndUpdate = origFindOneAndUpdate;
            stubs.stubRefreshToken.updateOne = origUpdateOne;
        }
        // The rotated-away token is now reuse: presenting the OLD value 401s.
        const reuse = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: oldRefresh } });
        assert.equal(reuse.status, 401);
    });
});

// --- F-07: logout by refresh cookie ---------------------------------------
//
// The access token lives 15 min; after 15 idle minutes a plain logout
// 401d and the 30-day refresh row survived. These tests present an
// EXPIRED / garbage access token with a live refresh cookie and require
// the logout to still revoke (200) — and the refresh row to be dead after.

describe('F-07 logout by refresh cookie', () => {
    function expiredAccess(username) {
        return jwt.sign(
            { username, sub: username, role: 'user', typ: 'pwa-access', exp: Math.floor(Date.now() / 1000) - 60 },
            process.env.JWT_SECRET
        );
    }

    it('logout with expired access + live refresh cookie -> 200 and the refresh row dies', async () => {
        const { jar } = await pwaLogin('pwauser2');
        const oldRefresh = jar.kamaal_refresh;
        jar.kamaal_access = expiredAccess('pwauser2');
        const res = await call('POST', '/api/pwa/auth/logout', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf }
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        // The refresh row is revoked: presenting it again 401s.
        const again = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: oldRefresh } });
        assert.equal(again.status, 401);
    });

    it('logout-everywhere with garbage access + live refresh cookie -> 200 and ALL sessions die', async () => {
        const a = await pwaLogin('pwauser3');
        const b = await pwaLogin('pwauser3');
        const refreshB = b.jar.kamaal_refresh;
        a.jar.kamaal_access = 'garbage-not-a-jwt';
        const res = await call('POST', '/api/pwa/auth/logout-everywhere', {
            jar: a.jar,
            headers: { 'X-CSRF-Token': a.jar.kamaal_csrf }
        });
        assert.equal(res.status, 200);
        // The OTHER session's refresh token is dead too.
        const againB = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: refreshB } });
        assert.equal(againB.status, 401);
        const againA = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: a.jar.kamaal_refresh } });
        assert.equal(againA.status, 401);
    });

    it('logout with no cookies at all -> 401 (refresh fallback needs a live row)', async () => {
        const res = await call('POST', '/api/pwa/auth/logout', { jar: {} });
        assert.equal(res.status, 401);
    });

    // W6 (4F re-hunt): the exact W4 probe shape, replayed at HTTP level.
    // A refresh in another tab rotates the csrf cookie (T1 -> T2) while
    // the client still holds the stale T1; the access then expires. The
    // stale-header logout MUST 403 at the csrfGuard (before logoutAuth),
    // and the fixed client flow — refresh first (CSRF-exempt), then retry
    // logout with the fresh token — MUST land 200 and kill the refresh row.
    it('W6 replay: stale-CSRF logout -> 403; refresh-first retry -> 200 and the refresh row dies', async () => {
        const { jar } = await pwaLogin('pwauser4');
        const staleCsrf = jar.kamaal_csrf;
        const firstRefresh = jar.kamaal_refresh;
        // Out-of-band rotation (another tab refreshed): csrf T1 -> T2,
        // refresh R1 -> R2. The client cache still holds T1.
        const rotated = await call('POST', '/api/pwa/auth/refresh', { jar });
        assert.equal(rotated.status, 200);
        assert.notEqual(jar.kamaal_csrf, staleCsrf);
        assert.notEqual(jar.kamaal_refresh, firstRefresh);
        // 15 idle minutes: the access token expires.
        jar.kamaal_access = expiredAccess('pwauser4');
        // Step 1 — the pre-fix client shape: stale header, live refresh.
        const blocked = await call('POST', '/api/pwa/auth/logout', {
            jar,
            headers: { 'X-CSRF-Token': staleCsrf }
        });
        assert.equal(blocked.status, 403);
        assert.equal(blocked.json.errorCode, 'CSRF_INVALID');
        // Step 2 — the fixed client flow: refresh first, then retry logout
        // with the fresh token from the jar (as the CSRF endpoint returns).
        const refreshed = await call('POST', '/api/pwa/auth/refresh', { jar });
        assert.equal(refreshed.status, 200);
        const liveRefresh = jar.kamaal_refresh;
        const res = await call('POST', '/api/pwa/auth/logout', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf }
        });
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        // The refresh row the logout revoked is dead: presenting it 401s.
        const again = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: liveRefresh } });
        assert.equal(again.status, 401);
    });
});

// --- F-03: donut GET refresh is cron-secret-only ---------------------------

describe('F-03 donut GET refresh', () => {
    it('admin cookie alone -> 401/403, never 200', async () => {
        const jar = {};
        const login = await call('POST', '/api/admin/login', { jar, body: { username: 'admin', password: 'correct-admin-pass' } });
        assert.equal(login.status, 200);
        assert.ok(jar.kamaal_admin, 'admin cookie set');
        const res = await call('GET', '/api/donut/refresh', { jar });
        assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
    });

    it('no auth at all -> 401, never 200', async () => {
        const res = await call('GET', '/api/donut/refresh');
        assert.equal(res.status, 401);
    });

    it('wrong cron secret -> 401, never 200', async () => {
        const res = await call('GET', '/api/donut/refresh', { headers: { Authorization: 'Bearer not-the-cron-secret' } });
        assert.equal(res.status, 401);
    });
});

describe('F-02 admin CSRF guard', () => {
    it('admin-cookie POST without X-CSRF-Token -> 403 CSRF_INVALID', async () => {
        const jar = {};
        const login = await call('POST', '/api/admin/login', { jar, body: { username: 'admin', password: 'correct-admin-pass' } });
        assert.equal(login.status, 200);
        // Cookie-only auth: no Bearer header, so the guard (not the auth
        // middleware) is what must reject this.
        const res = await call('POST', '/api/admin/user/update', { jar, body: { username: 'nobody' } });
        assert.equal(res.status, 403);
        assert.equal(res.json.errorCode, 'CSRF_INVALID');
    });

    it('admin-cookie POST with X-CSRF-Token passes the guard (not 403)', async () => {
        const jar = {};
        const login = await call('POST', '/api/admin/login', { jar, body: { username: 'admin', password: 'correct-admin-pass' } });
        assert.equal(login.status, 200);
        const res = await call('POST', '/api/admin/user/update', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf },
            body: { username: 'nobody' }
        });
        // Passes the guard; the handler itself 404s (stub DB has no such
        // user). The assertion is only that the guard did not 403 it.
        assert.notEqual(res.status, 403);
        assert.equal(res.status, 404);
    });
});
