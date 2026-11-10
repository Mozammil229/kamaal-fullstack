// 4F (W1) — prod/staging fail-fast env validation regressions.
//
// Proves, with real `node src/server.js` subprocess boots plus direct
// unit checks of src/config/validateEnv.js:
//   - staging/production REFUSE to start (non-zero exit, clear message,
//     no stack trace, no secret values) when MONGODB_URI is localhost /
//     a test database / missing, when a required secret is a placeholder
//     or too short, when CORS_ALLOWED_ORIGINS contains '*', and when
//     NODE_ENV is unset or ambiguous.
//   - development/test keep booting with the existing dummy env (no
//     MongoDB, short dummy secrets) — the test suite's behaviour.
//   - staging boots fine with valid (long, non-placeholder) values and
//     reports the DB honestly down (GET /api/health -> 503) when the
//     database host is unreachable.
//
// Spawned boots use a minimal explicit env (PATH + the listed vars
// only) so no ambient sandbox variable can mask a failure. Ports are
// fixed high ports to avoid clashing with any other local stack.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');

const { validateEnv } = require('../src/config/validateEnv');

const BACKEND = '/home/hatch/workspace/kamaal-fullstack-deploy';
const SERVER = `${BACKEND}/src/server.js`;

// Long random-looking staging values: valid shape, NOT real secrets
// (generated fresh for these tests; never used in production).
const GOOD = {
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    WEB_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_PASS: 'staging-admin-pass-' + crypto.randomBytes(8).toString('hex'),
    MONGODB_URI: 'mongodb+srv://staging-user:staging-pass-0123456789abcdef@staging.invalid/kamaal-staging?retryWrites=true&w=majority',
    CORS_ALLOWED_ORIGINS: 'http://localhost:4173,http://127.0.0.1:4173',
};

const hasProblem = (problems, variable) => problems.some((p) => p.variable === variable);

// ---------------- unit: validateEnv() ----------------

test('4F env: staging with valid values passes', () => {
    assert.deepEqual(validateEnv({ NODE_ENV: 'staging', PORT: '3100', ...GOOD }), []);
    assert.deepEqual(validateEnv({ NODE_ENV: 'production', PORT: '3100', ...GOOD }), []);
});

test('4F env: NODE_ENV unset / blank / unknown refuses', () => {
    for (const bad of [undefined, '', '   ', 'Staging', 'qa', 'prod']) {
        const env = { ...GOOD };
        if (bad === undefined) delete env.NODE_ENV; else env.NODE_ENV = bad;
        const problems = validateEnv(env);
        assert.ok(hasProblem(problems, 'NODE_ENV'), `NODE_ENV=${JSON.stringify(bad)} must be refused`);
    }
});

test('4F env: staging refuses localhost / 127.0.0.1 / ::1 MongoDB hosts', () => {
    for (const uri of [
        'mongodb://localhost:27017/kamaal-staging',
        'mongodb://127.0.0.1:27017/kamaal-staging',
        'mongodb://[::1]:27017/kamaal-staging',
        'mongodb+srv://user:pass@localhost/kamaal-staging',
    ]) {
        const problems = validateEnv({ NODE_ENV: 'staging', ...GOOD, MONGODB_URI: uri });
        assert.ok(hasProblem(problems, 'MONGODB_URI'), `${uri} must be refused`);
    }
});

test('4F env: staging refuses test database names and a missing database name', () => {
    for (const uri of [
        'mongodb+srv://u:p@cluster.example/test',
        'mongodb+srv://u:p@cluster.example/test-db',
        'mongodb+srv://u:p@cluster.example/kamaal-test',
        'mongodb+srv://u:p@cluster.example/kamaal_test',
        'mongodb+srv://u:p@cluster.example/', // no db -> driver defaults to 'test'
        'mongodb+srv://u:p@cluster.example',
    ]) {
        const problems = validateEnv({ NODE_ENV: 'staging', ...GOOD, MONGODB_URI: uri });
        assert.ok(hasProblem(problems, 'MONGODB_URI'), `${uri} must be refused`);
    }
    // A real staging database name passes.
    assert.deepEqual(validateEnv({ NODE_ENV: 'staging', ...GOOD, MONGODB_URI: 'mongodb+srv://u:p@cluster.example/kamaal-staging' }), []);
});

test('4F env: staging refuses a missing MONGODB_URI', () => {
    const env = { NODE_ENV: 'staging', ...GOOD };
    delete env.MONGODB_URI;
    assert.ok(hasProblem(validateEnv(env), 'MONGODB_URI'));
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, MONGODB_URI: '' }), 'MONGODB_URI'));
});

test('4F env: staging refuses placeholder or short required secrets', () => {
    for (const bad of ['changeme', 'CHANGEME', '<generate-a-long-random-secret>', 'dummy-secret', 'test', '']) {
        assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, JWT_SECRET: bad }), 'JWT_SECRET'), `JWT_SECRET=${JSON.stringify(bad)} must be refused`);
        assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, ADMIN_JWT_SECRET: bad }), 'ADMIN_JWT_SECRET'), `ADMIN_JWT_SECRET=${JSON.stringify(bad)} must be refused`);
    }
    // Short but non-placeholder values are refused by length (min 32).
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, JWT_SECRET: 'a'.repeat(31) }), 'JWT_SECRET'));
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, JWT_SECRET: 'a'.repeat(32) }), 'JWT_SECRET') === false);
    // Missing required secret is refused (not silently defaulted).
    const env = { NODE_ENV: 'staging', ...GOOD };
    delete env.JWT_SECRET;
    assert.ok(hasProblem(validateEnv(env), 'JWT_SECRET'));
});

test('4F env: staging refuses placeholder / short optional secrets when set, allows unset', () => {
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, CRON_SECRET: 'changeme' }), 'CRON_SECRET'));
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, ADMIN_PASS: 'short' }), 'ADMIN_PASS'));
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, OPS_INTERNAL_KEY: 'dummy' }), 'OPS_INTERNAL_KEY'));
    assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, RSA_PRIVATE_KEY_PEM: 'not-a-pem' }), 'RSA_PRIVATE_KEY_PEM'));
    // Unset optional keys are fine (each feature degrades by design).
    const env = { NODE_ENV: 'staging', ...GOOD };
    delete env.CRON_SECRET; delete env.ADMIN_PASS; delete env.WEB_JWT_SECRET;
    assert.deepEqual(validateEnv(env), []);
});

test('4F env: staging refuses wildcard / malformed CORS origins', () => {
    for (const cors of ['*', 'https://pwa.example, *', 'https://pwa.example/*', 'pwa.example', 'https://pwa.example/app']) {
        assert.ok(hasProblem(validateEnv({ NODE_ENV: 'staging', ...GOOD, CORS_ALLOWED_ORIGINS: cors }), 'CORS_ALLOWED_ORIGINS'), `CORS=${JSON.stringify(cors)} must be refused`);
    }
    // Explicit origins pass; unset is allowed (default allowlist, warn only).
    assert.deepEqual(validateEnv({ NODE_ENV: 'staging', ...GOOD, CORS_ALLOWED_ORIGINS: 'https://pwa.example,http://localhost:4173' }), []);
    const env = { NODE_ENV: 'staging', ...GOOD };
    delete env.CORS_ALLOWED_ORIGINS;
    assert.deepEqual(validateEnv(env), []);
});

test('4F env: all problems are listed at once (no single-var crash loop)', () => {
    const problems = validateEnv({
        NODE_ENV: 'staging',
        MONGODB_URI: 'mongodb://localhost:27017/test',
        JWT_SECRET: 'changeme',
        ADMIN_JWT_SECRET: 'short',
        CORS_ALLOWED_ORIGINS: '*',
    });
    for (const v of ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET', 'CORS_ALLOWED_ORIGINS']) {
        assert.ok(hasProblem(problems, v), `${v} must be listed`);
    }
    assert.ok(problems.length >= 4, `expected >=4 problems, got ${problems.length}`);
    // No secret value is echoed in any problem message.
    assert.ok(!JSON.stringify(problems).includes('changeme'));
});

test('4F env: development / test keep the existing dummy-env behaviour', () => {
    // The exact dummy shape the test suite boots with: short dummy
    // secrets, no MongoDB, wildcard-ish CORS — all refused in staging,
    // all fine in development/test.
    const dummy = {
        JWT_SECRET: 'test-jwt-secret-4a-only',
        ADMIN_JWT_SECRET: 'test-admin-jwt-secret-4a-only',
        CORS_ALLOWED_ORIGINS: 'https://kamaal-fullstack-ten.vercel.app,http://localhost:5173',
    };
    assert.deepEqual(validateEnv({ NODE_ENV: 'development', ...dummy }), []);
    assert.deepEqual(validateEnv({ NODE_ENV: 'test', ...dummy }), []);
    assert.deepEqual(validateEnv({ NODE_ENV: 'development' }), []); // no vars at all
    assert.deepEqual(validateEnv({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://localhost:27017/test', CORS_ALLOWED_ORIGINS: '*' }), []);
});

// ---------------- boot: real `node src/server.js` subprocess ----------------

function bootEnv(overrides) {
    // Minimal explicit env: nothing ambient can mask a failure.
    return { PATH: process.env.PATH, HOME: process.env.HOME, ...overrides };
}

function runServer(env) {
    return new Promise((resolve) => {
        execFile(process.execPath, [SERVER], { env: bootEnv(env), cwd: BACKEND, timeout: 20000 },
            (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
}

test('4F boot: staging with localhost MONGODB_URI refuses (non-zero, clear, no stack)', async () => {
    const r = await runServer({ NODE_ENV: 'staging', PORT: '31991', ...GOOD, MONGODB_URI: 'mongodb://localhost:27017/kamaal-staging' });
    assert.notEqual(r.code, 0, 'must exit non-zero');
    assert.match(r.stderr, /FATAL: invalid environment/);
    assert.match(r.stderr, /MONGODB_URI/);
    assert.match(r.stderr, /localhost/);
    assert.ok(!r.stderr.includes('\n    at '), 'must not leak a stack trace');
    assert.ok(!r.stderr.includes(GOOD.JWT_SECRET), 'must not echo secret values');
});

test('4F boot: staging with a placeholder secret refuses', async () => {
    const r = await runServer({ NODE_ENV: 'staging', PORT: '31991', ...GOOD, JWT_SECRET: 'changeme' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /FATAL: invalid environment/);
    assert.match(r.stderr, /JWT_SECRET/);
    assert.ok(!r.stderr.includes('changeme'), 'must not echo the bad value');
});

test('4F boot: staging with CORS * refuses', async () => {
    const r = await runServer({ NODE_ENV: 'staging', PORT: '31991', ...GOOD, CORS_ALLOWED_ORIGINS: '*' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /CORS_ALLOWED_ORIGINS/);
});

test('4F boot: unset NODE_ENV refuses with an explicit message', async () => {
    const env = { PORT: '31991', ...GOOD };
    const r = await runServer(env); // no NODE_ENV at all
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /NODE_ENV/);
    assert.match(r.stderr, /explicitly/);
});

test('4F boot: production with a test database refuses', async () => {
    const r = await runServer({ NODE_ENV: 'production', PORT: '31991', ...GOOD, MONGODB_URI: 'mongodb+srv://u:p@cluster.example/test' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /MONGODB_URI/);
});

function bootAndPollHealth(env, port) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [SERVER], { env: bootEnv(env), cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        const deadline = Date.now() + 20000;
        const poll = () => {
            const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/health' }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    child.kill('SIGTERM');
                    resolve({ status: res.statusCode, body: data, stderr });
                });
            });
            req.on('error', () => {
                if (Date.now() > deadline) {
                    child.kill('SIGTERM');
                    reject(new Error(`health never answered; stderr: ${stderr.slice(0, 500)}`));
                } else setTimeout(poll, 250);
            });
            req.end();
        };
        child.on('exit', (code) => {
            if (code !== 0 && code !== null) reject(new Error(`server exited code=${code}; stderr: ${stderr.slice(0, 500)}`));
        });
        setTimeout(poll, 500);
    });
}

test('4F boot: staging with valid values boots; health is honestly 503 with no DB', async () => {
    const port = 31991;
    const r = await bootAndPollHealth({ NODE_ENV: 'staging', PORT: String(port), ...GOOD }, port);
    assert.equal(r.status, 503, 'unreachable staging.invalid host must report DB down');
    const body = JSON.parse(r.body);
    assert.equal(body.status, 'DEGRADED');
    assert.match(body.database, /Disconnected/);
    assert.equal(body.pwa.cookieAuth, true);
});

test('4F boot: development with dummy env still boots (existing behaviour)', async () => {
    const port = 31992;
    const r = await bootAndPollHealth({
        NODE_ENV: 'development', PORT: String(port),
        JWT_SECRET: 'test-jwt-secret-4a-only',
        ADMIN_JWT_SECRET: 'test-admin-jwt-secret-4a-only',
        CORS_ALLOWED_ORIGINS: 'https://kamaal-fullstack-ten.vercel.app,http://localhost:5173',
    }, port);
    assert.equal(r.status, 503, 'no MongoDB in dev must still report DB down, not crash');
    assert.equal(JSON.parse(r.body).status, 'DEGRADED');
});
