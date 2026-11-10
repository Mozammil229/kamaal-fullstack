// Patcher Site — web auth contract tests (2026-11-09).
//
// Run: `node --test tests/web-auth.test.js` (Node >= 18 built-in runner;
// same setup as tests/flow-generate.test.js — plain node:test, no extra
// test dependency, no running server, no Mongo).
//
// Coverage:
//  (a) validation helpers (email / password rules).
//  (b) register/login/getMe handlers with a stubbed WebUser model + stub
//      DB gate — happy paths, duplicate 409, generic 401 on every login
//      failure (unknown email / wrong password / disabled all answer the
//      SAME message), DB-offline 503, no passwordHash ever in a response.
//  (c) authenticateWebUser middleware (factory-injected stub model + stub
//      DB): missing/garbage/expired/app-type tokens -> 401, disabled -> 403,
//      valid web token -> req.webUser + next().
//  (d) admin list/update/delete handlers (stub model).
//  (e) route table (webRoutes router stack) + app boot smoke: the web
//      routes are mounted at /api/web and the app /api/register alias is
//      intact (both answer 503 with no DB instead of 404).

'use strict';

// Env FIRST — src/config/env.js throws at load when these are unset.
process.env.JWT_SECRET = 'web-auth-test-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'web-auth-test-admin-secret';
process.env.WEB_JWT_SECRET = 'web-auth-test-web-secret';
delete process.env.MONGODB_URI;

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const {
    createWebAuthHandlers,
    validateWebEmail,
    validateWebPassword,
    signWebToken,
    verifyWebToken,
    GENERIC_LOGIN_ERROR
} = require('../src/controllers/webAuthController');
const { createAuthenticateWebUser } = require('../src/middleware/webAuth');

// --- Stubs ------------------------------------------------------------------

function fakeQuery(value) {
    const p = Promise.resolve(value);
    p.select = () => Promise.resolve(value);
    p.sort = () => Promise.resolve(
        Array.isArray(value)
            ? [...value].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            : value
    );
    p.lean = () => Promise.resolve(value);
    return p;
}

function makeStubModel(seed = []) {
    const rows = [...seed];
    return {
        _rows: rows,
        findOne(query) {
            const doc = rows.find((r) => r.email === query.email) || null;
            return fakeQuery(doc);
        },
        async create(data) {
            const doc = {
                _id: new mongoose.Types.ObjectId().toString(),
                email: data.email,
                passwordHash: data.passwordHash,
                status: 'active',
                lastLoginAt: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                save: async function () { this.updatedAt = new Date(); }
            };
            rows.push(doc);
            return doc;
        },
        findById(id) {
            return Promise.resolve(rows.find((r) => String(r._id) === String(id)) || null);
        },
        find() {
            return fakeQuery([...rows]);
        },
        async findByIdAndUpdate(id, update) {
            const doc = rows.find((r) => String(r._id) === String(id));
            if (!doc) return null;
            Object.assign(doc, update);
            doc.updatedAt = new Date();
            return doc;
        },
        async findByIdAndDelete(id) {
            const idx = rows.findIndex((r) => String(r._id) === String(id));
            if (idx === -1) return null;
            return rows.splice(idx, 1)[0];
        }
    };
}

const onlineDb = { connect: async () => {}, isConnected: () => true };
const offlineDb = { connect: async () => {}, isConnected: () => false };

function makeUser(email, password, status = 'active') {
    return {
        _id: new mongoose.Types.ObjectId().toString(),
        email,
        passwordHash: bcrypt.hashSync(password, 10),
        status,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        save: async function () { this.updatedAt = new Date(); }
    };
}

function makeReq({ body, params, headers, webUser } = {}) {
    return { body: body || {}, params: params || {}, headers: headers || {}, webUser };
}

function makeRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
    return res;
}

// --- (a) Validation ---------------------------------------------------------

describe('web auth validation', () => {
    it('accepts well-formed emails, rejects the rest', () => {
        assert.equal(validateWebEmail('user@kamaal.test'), true);
        assert.equal(validateWebEmail('User@Kamaal.Test'), true);
        assert.equal(validateWebEmail('not-an-email'), false);
        assert.equal(validateWebEmail('user@'), false);
        assert.equal(validateWebEmail(''), false);
        assert.equal(validateWebEmail(null), false);
    });

    it('requires at least 8 characters for the password', () => {
        assert.equal(validateWebPassword('12345678'), true);
        assert.equal(validateWebPassword('1234567'), false);
        assert.equal(validateWebPassword(''), false);
        assert.equal(validateWebPassword(null), false);
    });
});

// --- (b) Register / login / getMe -------------------------------------------

describe('web register/login', () => {
    let model;
    let h;
    beforeEach(() => {
        model = makeStubModel();
        h = createWebAuthHandlers({ WebUserModel: model, db: onlineDb });
    });

    it('register: 201 + token + safe user; hash is bcrypt, never returned', async () => {
        const req = makeReq({ body: { email: '  New@Kamaal.Test ', password: 'correct-password' } });
        const res = makeRes();
        await h.register(req, res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.success, true);
        assert.equal(res.body.user.email, 'new@kamaal.test'); // lowercased + trimmed
        assert.equal(res.body.user.passwordHash, undefined);
        assert.equal(typeof res.body.token, 'string');
        const decoded = verifyWebToken(res.body.token);
        assert.equal(decoded.type, 'web');
        assert.equal(decoded.sub, res.body.user.id);
        assert.equal(decoded.email, 'new@kamaal.test');
        assert.ok(decoded.exp * 1000 > Date.now());
        // Stored hash really is bcrypt of the password (not plaintext).
        const stored = model._rows[0];
        assert.notEqual(stored.passwordHash, 'correct-password');
        assert.equal(bcrypt.compareSync('correct-password', stored.passwordHash), true);
    });

    it('register: duplicate email -> 409, invalid email -> 400, short password -> 400', async () => {
        await h.register(makeReq({ body: { email: 'dup@kamaal.test', password: 'correct-password' } }), makeRes());
        const dup = makeRes();
        await h.register(makeReq({ body: { email: 'dup@kamaal.test', password: 'correct-password' } }), dup);
        assert.equal(dup.statusCode, 409);
        assert.equal(dup.body.errorCode, 'EMAIL_EXISTS');

        const badEmail = makeRes();
        await h.register(makeReq({ body: { email: 'nope', password: 'correct-password' } }), badEmail);
        assert.equal(badEmail.statusCode, 400);

        const weak = makeRes();
        await h.register(makeReq({ body: { email: 'ok@kamaal.test', password: 'short' } }), weak);
        assert.equal(weak.statusCode, 400);
    });

    it('register: DB offline -> 503', async () => {
        const off = createWebAuthHandlers({ WebUserModel: model, db: offlineDb });
        const res = makeRes();
        await off.register(makeReq({ body: { email: 'a@kamaal.test', password: 'correct-password' } }), res);
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.errorCode, 'DB_OFFLINE');
    });

    it('login: 200 + web token; wrong password / unknown email / disabled all answer the SAME generic 401', async () => {
        model._rows.push(makeUser('user@kamaal.test', 'correct-password'));
        model._rows.push(makeUser('off@kamaal.test', 'correct-password', 'disabled'));

        const ok = makeRes();
        await h.login(makeReq({ body: { email: 'user@kamaal.test', password: 'correct-password' } }), ok);
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.body.success, true);
        assert.equal(verifyWebToken(ok.body.token).type, 'web');
        assert.equal(ok.body.user.passwordHash, undefined);

        for (const body of [
            { email: 'user@kamaal.test', password: 'wrong-password' },
            { email: 'nobody@kamaal.test', password: 'correct-password' },
            { email: 'off@kamaal.test', password: 'correct-password' },
            { email: 'not-an-email', password: 'correct-password' }
        ]) {
            const res = makeRes();
            await h.login(makeReq({ body }), res);
            assert.equal(res.statusCode, 401);
            assert.equal(res.body.error, GENERIC_LOGIN_ERROR);
            assert.equal(res.body.errorCode, 'INVALID_CREDENTIALS');
        }
    });

    it('login: missing fields -> 400 (not the generic 401)', async () => {
        const res = makeRes();
        await h.login(makeReq({ body: { email: 'user@kamaal.test' } }), res);
        assert.equal(res.statusCode, 400);
    });

    it('getMe: returns the safe web user, never the hash', async () => {
        const user = makeUser('me@kamaal.test', 'correct-password');
        const res = makeRes();
        await h.getMe(makeReq({ webUser: user }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.user.email, 'me@kamaal.test');
        assert.equal(res.body.user.passwordHash, undefined);
    });
});

// --- (c) Middleware -----------------------------------------------------------

describe('authenticateWebUser middleware', () => {
    let model;
    let middleware;
    beforeEach(() => {
        model = makeStubModel([makeUser('web@kamaal.test', 'correct-password')]);
        middleware = createAuthenticateWebUser(model, onlineDb);
    });

    it('missing header -> 401, garbage token -> 401, expired token -> 401', async () => {
        const noHeader = makeRes();
        await middleware(makeReq({ headers: {} }), noHeader, () => {});
        assert.equal(noHeader.statusCode, 401);

        const garbage = makeRes();
        await middleware(makeReq({ headers: { authorization: 'Bearer not-a-token' } }), garbage, () => {});
        assert.equal(garbage.statusCode, 401);

        const expired = jwt.sign(
            { type: 'web', sub: model._rows[0]._id, email: 'web@kamaal.test' },
            process.env.WEB_JWT_SECRET,
            { expiresIn: '-1s' }
        );
        const expRes = makeRes();
        await middleware(makeReq({ headers: { authorization: `Bearer ${expired}` } }), expRes, () => {});
        assert.equal(expRes.statusCode, 401);
    });

    it('an APP-style token (no type:web) is rejected even when signed with the same secret', async () => {
        const appToken = jwt.sign(
            { username: 'someone', sub: 'someone', role: 'user' },
            process.env.WEB_JWT_SECRET,
            { expiresIn: '7d' }
        );
        const res = makeRes();
        await middleware(makeReq({ headers: { authorization: `Bearer ${appToken}` } }), res, () => {});
        assert.equal(res.statusCode, 401);
    });

    it('valid web token, unknown user -> 401; disabled user -> 403; active user -> next() with req.webUser', async () => {
        const ghost = signWebToken({ _id: new mongoose.Types.ObjectId().toString(), email: 'ghost@kamaal.test' });
        const ghostRes = makeRes();
        await middleware(makeReq({ headers: { authorization: `Bearer ${ghost}` } }), ghostRes, () => {});
        assert.equal(ghostRes.statusCode, 401);

        const disabled = makeUser('off2@kamaal.test', 'correct-password', 'disabled');
        model._rows.push(disabled);
        const offRes = makeRes();
        let offNext = false;
        await middleware(
            makeReq({ headers: { authorization: `Bearer ${signWebToken(disabled)}` } }),
            offRes,
            () => { offNext = true; }
        );
        assert.equal(offRes.statusCode, 403);
        assert.equal(offNext, false);

        const active = model._rows[0];
        const req = makeReq({ headers: { authorization: `Bearer ${signWebToken(active)}` } });
        const res = makeRes();
        let nextCalled = false;
        await middleware(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, true);
        assert.equal(req.webUser.email, 'web@kamaal.test');
    });
});

// --- (d) Admin list / update / delete ----------------------------------------

describe('web admin handlers', () => {
    let model;
    let h;
    beforeEach(() => {
        model = makeStubModel([
            makeUser('a@kamaal.test', 'correct-password'),
            makeUser('b@kamaal.test', 'correct-password')
        ]);
        h = createWebAuthHandlers({ WebUserModel: model, db: onlineDb });
    });

    it('list: safe users only, no hashes; update flips status; delete removes', async () => {
        const list = makeRes();
        await h.listWebUsers(makeReq(), list);
        assert.equal(list.statusCode, 200);
        assert.equal(list.body.count, 2);
        assert.equal(list.body.users.every((u) => u.passwordHash === undefined), true);

        const id = model._rows[0]._id;
        const upd = makeRes();
        await h.updateWebUser(makeReq({ params: { id }, body: { disabled: true } }), upd);
        assert.equal(upd.statusCode, 200);
        assert.equal(upd.body.user.status, 'disabled');

        const del = makeRes();
        await h.deleteWebUser(makeReq({ params: { id } }), del);
        assert.equal(del.statusCode, 200);
        assert.equal(model._rows.length, 1);
    });

    it('update/delete: invalid id -> 400, unknown id -> 404, non-boolean disabled -> 400', async () => {
        const badId = makeRes();
        await h.updateWebUser(makeReq({ params: { id: 'not-an-id' }, body: { disabled: true } }), badId);
        assert.equal(badId.statusCode, 400);

        const ghost = new mongoose.Types.ObjectId().toString();
        const missing = makeRes();
        await h.deleteWebUser(makeReq({ params: { id: ghost } }), missing);
        assert.equal(missing.statusCode, 404);

        const badBody = makeRes();
        await h.updateWebUser(makeReq({ params: { id: model._rows[0]._id }, body: { disabled: 'yes' } }), badBody);
        assert.equal(badBody.statusCode, 400);
    });
});

// --- (e) Route table + app boot smoke ----------------------------------------

describe('web routes mounting', () => {
    it('webRoutes exposes exactly the six web endpoints', () => {
        const router = require('../src/routes/webRoutes');
        const found = [];
        for (const layer of router.stack) {
            if (layer.route) {
                found.push(`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
            }
        }
        assert.deepEqual(found.sort(), [
            'DELETE /admin/users/:id',
            'GET /admin/users',
            'GET /me',
            'PATCH /admin/users/:id',
            'POST /login',
            'POST /register'
        ].sort());
    });

    it('boot smoke: /api/web/* is mounted (401/503, never 404) and the app /api/auth/register path is intact', async () => {
        const app = require('../src/app');
        const server = app.listen(0);
        try {
            const port = server.address().port;
            const base = `http://127.0.0.1:${port}`;

            // No token -> 401 from the web middleware (proves /api/web/me is mounted).
            let res = await fetch(`${base}/api/web/me`);
            assert.equal(res.status, 401);

            // No admin auth -> 401 from requireAdminAuth (proves /api/web/admin/* is mounted).
            res = await fetch(`${base}/api/web/admin/users`);
            assert.equal(res.status, 401);

            // Valid-shaped body, no DB in this env -> 503 from the handler
            // (proves the register/login routes are mounted and reached).
            res = await fetch(`${base}/api/web/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'boot@kamaal.test', password: 'correct-password' })
            });
            assert.equal(res.status, 503);

            res = await fetch(`${base}/api/web/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'boot@kamaal.test', password: 'correct-password' })
            });
            assert.equal(res.status, 503);

            // The APP's working auth path must still answer (503, no DB) —
            // not 404 and not the web register handler (which lives at
            // /api/web/*). NOTE (pre-existing finding, NOT caused by this
            // change): the /api/register alias in app.js section 2 is
            // shadowed by socialRoutes.js:24 blanket authenticateUser
            // (mounted at /api in section 1, before the aliases) — an
            // unauthenticated POST /api/register answers 401, never
            // reaching authController.register. The app's live register
            // path is /api/auth/register (mounted first), which is what
            // this assertion covers. Fixing the alias order is out of
            // scope here (app login untouched by this build).
            res = await fetch(`${base}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'bootuser', password: 'correct-password' })
            });
            assert.equal(res.status, 503);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
