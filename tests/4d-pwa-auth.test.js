// 4D (PWA cookie auth) — functional contract tests.
//
// Run: `node --test tests/4d-pwa-auth.test.js` (Node built-in runner, no
// extra test dependency). Real HTTP against a real Express app (fetch +
// a manual cookie jar); the User / RefreshToken / RevokedToken /
// AppConfig models and the DB gate are stubbed in-memory via
// tests/4d-pwa-stubs.js (injected into require.cache before the app
// loads) — same pattern as tests/web-auth.test.js, no Mongo.
//
// Coverage: login sets all three cookies (httpOnly, paths, no Secure on
// plain http, NO token value in the body, Android stored token untouched);
// wrong password / unknown user -> same generic 401, no cookies; refresh
// rotates (old -> 401); reuse after rotation revokes the WHOLE family;
// logout revokes (refresh + cookie-verify -> 401); logout-everywhere
// revokes all sessions; cookie auth grants GET /api/auth/verify; Bearer
// 30d token still works and Bearer POST skips CSRF; CSRF missing on a
// cookie POST -> 403 CSRF_INVALID, present -> OK; refresh token used as
// an access token -> 401; admin cookie login/logout + admin/user token
// separation.
//
// Login-count budget: the pwa login limiters (10/min/IP, 5/min/username)
// are live in this process, so logins are spread over the 4 seeded
// users and kept to 10 total (see the rate-limit suite for the 429s).

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
    return { status: res.status, json, text, setCookies };
}

async function pwaLogin(username, password = PASSWORD) {
    const jar = {};
    const res = await call('POST', '/api/pwa/auth/login', { jar, body: { username, password } });
    return { jar, res };
}

function bearer30d(username) {
    return jwt.sign(
        { username, sub: username, role: 'user' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
    );
}

// --- login -------------------------------------------------------------------

describe('PWA login', () => {
    it('sets access + refresh + csrf cookies, no token in the body, Android token untouched', async () => {
        const { jar, res } = await pwaLogin('pwauser');
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        assert.equal(res.json.user.username, 'pwauser');
        assert.equal(res.json.token, undefined);
        assert.ok(jar.kamaal_access, 'access cookie set');
        assert.ok(jar.kamaal_refresh, 'refresh cookie set');
        assert.ok(jar.kamaal_csrf, 'csrf cookie set');
        // No token value anywhere in the body — incl. the stored Android token.
        assert.ok(!res.text.includes(jar.kamaal_access));
        assert.ok(!res.text.includes(jar.kamaal_refresh));
        assert.ok(!res.text.includes('android-stored-30d-token'));
        // Access token is a short-lived PWA JWT (15 min, typ pwa-access).
        const decoded = jwt.verify(jar.kamaal_access, process.env.JWT_SECRET);
        assert.equal(decoded.typ, 'pwa-access');
        assert.equal(decoded.username, 'pwauser');
        assert.ok(decoded.exp * 1000 - Date.now() <= 15 * 60 * 1000 + 5000);
        assert.ok(decoded.exp * 1000 > Date.now());
        // Cookie attributes: httpOnly on the two session cookies, NOT on csrf.
        const byName = Object.fromEntries(res.setCookies.map((c) => [c.split(';')[0].split('=')[0], c]));
        assert.match(byName.kamaal_access, /HttpOnly/i);
        assert.match(byName.kamaal_access, /Path=\/api/i);
        assert.match(byName.kamaal_refresh, /HttpOnly/i);
        assert.match(byName.kamaal_refresh, /Path=\/api\/pwa\/auth/i);
        assert.ok(!/HttpOnly/i.test(byName.kamaal_csrf), 'csrf cookie must NOT be httpOnly');
        assert.match(byName.kamaal_csrf, /Path=\//i);
        for (const c of res.setCookies) {
            assert.match(c, /SameSite=Lax/i);
            assert.ok(!/;\s*Secure/i.test(c), 'no Secure on plain http (local dev must work)');
        }
        // PWA login did NOT overwrite the stored Android token.
        const row = stubs.users.find((u) => u.username === 'pwauser');
        assert.equal(row.token, 'android-stored-30d-token');
    });

    it('wrong password -> 401 generic, no cookies; unknown user -> SAME 401 (no enumeration)', async () => {
        const bad = await call('POST', '/api/pwa/auth/login', { jar: {}, body: { username: 'pwauser', password: 'wrong-password' } });
        assert.equal(bad.status, 401);
        assert.equal(bad.json.error, 'Invalid credentials.');
        assert.equal(bad.setCookies.length, 0);

        const ghost = await call('POST', '/api/pwa/auth/login', { jar: {}, body: { username: 'nosuchuser', password: 'correct-password' } });
        assert.equal(ghost.status, 401);
        assert.equal(ghost.json.error, 'Invalid credentials.');
        assert.equal(ghost.setCookies.length, 0);
    });
});

// --- refresh / rotation / reuse ----------------------------------------------

describe('PWA refresh rotation', () => {
    it('rotates: new refresh cookie differs, old refresh -> 401', async () => {
        const { jar, res } = await pwaLogin('pwauser2');
        assert.equal(res.status, 200);
        const oldRefresh = jar.kamaal_refresh;

        const rotated = await call('POST', '/api/pwa/auth/refresh', { jar });
        assert.equal(rotated.status, 200);
        assert.equal(rotated.json.success, true);
        assert.notEqual(jar.kamaal_refresh, oldRefresh);
        // The new access token verifies as a PWA token (its VALUE may
        // legitimately equal the old one — JWT iat/exp are second-granular
        // and the claims are identical within the same second).
        assert.equal(jwt.verify(jar.kamaal_access, process.env.JWT_SECRET).typ, 'pwa-access');

        // The opaque refresh token is NOT accepted as an access token.
        const asAccess = await call('GET', '/api/auth/verify', {
            jar: { kamaal_access: jar.kamaal_refresh }
        });
        assert.equal(asAccess.status, 401);

        // The old refresh token is dead.
        const stale = { kamaal_refresh: oldRefresh };
        const dead = await call('POST', '/api/pwa/auth/refresh', { jar: stale });
        assert.equal(dead.status, 401);
    });

    it('reuse after rotation revokes the WHOLE family (new token stops working too)', async () => {
        const { jar, res } = await pwaLogin('pwauser3');
        assert.equal(res.status, 200);
        const firstRefresh = jar.kamaal_refresh;

        const rotated = await call('POST', '/api/pwa/auth/refresh', { jar });
        assert.equal(rotated.status, 200);
        const secondRefresh = jar.kamaal_refresh;
        assert.notEqual(secondRefresh, firstRefresh);

        // Replay the already-rotated token: reuse detected -> 401.
        const replay = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: firstRefresh } });
        assert.equal(replay.status, 401);

        // The whole family is revoked: the NEW token is dead too.
        const newDead = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: secondRefresh } });
        assert.equal(newDead.status, 401);
    });

    it('missing / unknown refresh cookie -> 401', async () => {
        const missing = await call('POST', '/api/pwa/auth/refresh', { jar: {} });
        assert.equal(missing.status, 401);
        const unknown = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: '00'.repeat(32) } });
        assert.equal(unknown.status, 401);
    });
});

// --- logout ------------------------------------------------------------------

describe('PWA logout', () => {
    it('logout revokes: refresh after logout -> 401 and cookie-verify -> 401', async () => {
        const { jar, res } = await pwaLogin('pwauser4');
        assert.equal(res.status, 200);
        const refresh = jar.kamaal_refresh;

        const out = await call('POST', '/api/pwa/auth/logout', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf }
        });
        assert.equal(out.status, 200);
        // Cookies cleared (expired Set-Cookie).
        assert.ok(out.setCookies.some((c) => c.startsWith('kamaal_access=;') || c.startsWith('kamaal_access=;')));

        const after = await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: refresh } });
        assert.equal(after.status, 401);

        const verify = await call('GET', '/api/auth/verify', { jar });
        assert.equal(verify.status, 401);
    });

    it('logout-everywhere revokes all sessions (both logins of the same user dead)', async () => {
        const a = await pwaLogin('pwauser');
        assert.equal(a.res.status, 200);
        const b = await pwaLogin('pwauser');
        assert.equal(b.res.status, 200);
        const refreshA = a.jar.kamaal_refresh;
        const refreshB = b.jar.kamaal_refresh;

        const out = await call('POST', '/api/pwa/auth/logout-everywhere', {
            jar: a.jar,
            headers: { 'X-CSRF-Token': a.jar.kamaal_csrf }
        });
        assert.equal(out.status, 200);

        assert.equal((await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: refreshA } })).status, 401);
        assert.equal((await call('POST', '/api/pwa/auth/refresh', { jar: { kamaal_refresh: refreshB } })).status, 401);
    });
});

// --- cookie auth vs Bearer vs CSRF -------------------------------------------

describe('cookie auth, Bearer compat, CSRF', () => {
    it('cookie auth grants a protected route (GET /api/auth/verify with only cookies)', async () => {
        const { jar, res } = await pwaLogin('pwauser3');
        assert.equal(res.status, 200);
        const verify = await call('GET', '/api/auth/verify', { jar });
        assert.equal(verify.status, 200);
        assert.equal(verify.json.success, true);
        assert.equal(verify.json.user.username, 'pwauser3');
    });

    it('Bearer 30d token still works; Bearer POST without CSRF is NOT 403', async () => {
        const token = bearer30d('pwauser');
        const verify = await call('GET', '/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(verify.status, 200);

        const out = await call('POST', '/api/auth/logout', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(out.status, 200);
        assert.notEqual(out.status, 403);

        // ...and the revoked Bearer token is dead afterwards.
        const dead = await call('GET', '/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(dead.status, 401);
    });

    it('CSRF missing on a cookie POST -> 403 CSRF_INVALID; present -> OK', async () => {
        // pwauser2 has only logged in once so far (refresh test), inside
        // the 5/min per-username budget; the IP budget is at 9/10.
        const { jar, res } = await pwaLogin('pwauser2');
        assert.equal(res.status, 200);

        const noHeader = await call('POST', '/api/auth/logout', { jar });
        assert.equal(noHeader.status, 403);
        assert.equal(noHeader.json.errorCode, 'CSRF_INVALID');

        const withHeader = await call('POST', '/api/auth/logout', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf }
        });
        assert.equal(withHeader.status, 200);
    });
});

// --- admin cookie ------------------------------------------------------------

describe('admin cookie', () => {
    it('admin login sets the kamaal_admin cookie; cookie grants admin routes; logout clears + revokes', async () => {
        const jar = {};
        const login = await call('POST', '/api/admin/login', {
            jar,
            body: { username: 'admin', password: 'correct-admin-pass' }
        });
        assert.equal(login.status, 200);
        assert.equal(login.json.success, true);
        assert.ok(typeof login.json.token === 'string', 'admin token still in body (compat)');
        assert.ok(jar.kamaal_admin, 'admin cookie set');
        const byName = Object.fromEntries(login.setCookies.map((c) => [c.split(';')[0].split('=')[0], c]));
        assert.match(byName.kamaal_admin, /HttpOnly/i);
        assert.match(byName.kamaal_admin, /Path=\/api\/admin/i);

        // Cookie-only admin access (no header at all).
        const users = await call('GET', '/api/admin/users', { jar });
        assert.equal(users.status, 200);
        assert.equal(users.json.success, true);

        // 4E F-02: the guard now enforces on the admin cookie too, so the
        // cookie-authenticated logout POST must carry X-CSRF-Token — exactly
        // what the real panel sends via getAuthHeaders() in admin.html.
        const out = await call('POST', '/api/admin/logout', {
            jar,
            headers: { 'X-CSRF-Token': jar.kamaal_csrf }
        });
        assert.equal(out.status, 200);

        // Revoked: the old admin cookie is dead.
        const dead = await call('GET', '/api/admin/users', { jar });
        assert.equal(dead.status, 401);
    });

    it('admin/user tokens never mix', async () => {
        // User Bearer token as admin -> 401.
        const userToken = bearer30d('pwauser');
        const asAdmin = await call('GET', '/api/admin/users', { headers: { Authorization: `Bearer ${userToken}` } });
        assert.equal(asAdmin.status, 401);

        // Admin JWT as a user token -> 401.
        const adminToken = jwt.sign(
            { sub: 'admin', role: 'admin', iss: 'kammal-auth' },
            process.env.ADMIN_JWT_SECRET,
            { expiresIn: '24h' }
        );
        const asUser = await call('GET', '/api/auth/verify', { headers: { Authorization: `Bearer ${adminToken}` } });
        assert.equal(asUser.status, 401);
    });
});
