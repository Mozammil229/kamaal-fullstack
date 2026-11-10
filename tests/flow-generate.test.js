// Flow Engine X P2 — backend contract tests.
//
// Run: `node --test tests/flow-generate.test.js` (Node >= 18 built-in
// runner; no extra test dependency). The backend has no other test suite
// (no tests/ dir, no "test" script in package.json — mongodb-memory-server
// is a devDependency with zero callers), so this file IS the P2 backend
// suite, in the backend's own test setup (plain node:test).
//
// Coverage:
//  (a) flowGenerateService — prompt, reply parsing, shape mirror.
//  (b) flowController via createGenerateFlowHandler with stubbed
//      generateAIReply / DB / models — the full route contract without a
//      running server or Mongo: valid -> flow envelope, malformed AI
//      output -> clean error (never a half-flow), vague -> clarify.
//
// The GREEN sentence used by the primary test (AVAILABLE-only trigger +
// LOW actions — the P2 green test; see the headphone note below):
//   "Roz subah 7 baje taaza khabrein nikaal kar mujhe notification mein dikhao."
//
// HEADPHONE sentence (plan §15.1, line 746) —
//   "Jab Bluetooth headphones connect hon, music player open karo. Jab
//    disconnect hon to music pause kar do."
// — P7 UNBLOCKED it (2026-11-09): bluetooth.connected/disconnected are
// AVAILABLE triggers now (app registry + this allow-list flipped them
// when the P7 trigger engine shipped). The tests below assert green:
// the shape mirror validates the headphone flow with 0 errors and
// classifyModelReply turns the model reply into a {type:"flow"}.
// Line-746 is GREEN. (Geofence stays PLANNED — its spike is UNVERIFIED.)

'use strict';
// 4A: dummy secrets for boot only (same pattern as tests/web-auth.test.js).
// env.js is fail-closed (F-02 fix, pre-existing) — without these, requiring
// any controller that loads env.js throws before the first test runs.
process.env.JWT_SECRET = 'test-jwt-secret-4a-only';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-4a-only';
delete process.env.MONGODB_URI;


const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    AVAILABLE_TRIGGERS,
    PLANNED_TRIGGERS,
    AVAILABLE_ACTIONS,
    buildFlowSystemPrompt,
    extractJson,
    validateFlowShape,
    classifyModelReply,
} = require('../src/services/flowGenerateService');
const { createGenerateFlowHandler } = require('../src/controllers/flowController');

// --- Fixtures ---------------------------------------------------------------
// What a good model returns for the GREEN sentence (7 AM news -> notify).
const GREEN_MODEL_REPLY = JSON.stringify({
    type: 'flow',
    flow: {
        dslVersion: 1,
        id: 'flow-7am-news-001',
        name: 'Subah 7 baje khabrein',
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        enabled: true,
        permissions: ['notification.post'],
        triggers: [{ type: 'time', hour: 7, minute: 0 }],
        variables: [],
        steps: [
            { id: 's1', kind: 'action', action: 'news.latest', args: {}, confirm: 'first_run', verify: 'Headlines list wapas mili.' },
            { id: 's2', kind: 'action', action: 'notification.show', args: { title: 'Subah ki khabrein', text: 'Taaza khabrein dekh lo.' }, confirm: 'first_run', verify: 'Notification posted.' },
        ],
    },
});

// What a model returns for the HEADPHONE sentence — bluetooth triggers are
// AVAILABLE since P7, so this comes back as a green flow.
const HEADPHONE_MODEL_REPLY = JSON.stringify({
    type: 'flow',
    flow: {
        dslVersion: 1,
        id: 'flow-headphones-001',
        name: 'Headphones wala flow',
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        enabled: true,
        permissions: ['app.open'],
        triggers: [
            { type: 'bluetooth.connected', deviceName: 'headphones' },
            { type: 'bluetooth.disconnected', deviceName: 'headphones' },
        ],
        variables: [],
        steps: [
            { id: 's1', kind: 'action', action: 'app.open', args: { query: 'Spotify' }, confirm: 'first_run', verify: 'Player foreground mein hai.' },
            { id: 's2', kind: 'action', action: 'media.control', args: { action: 'pause' }, confirm: 'first_run', verify: 'Media paused.' },
        ],
    },
});

const VAGUE_MODEL_REPLY = JSON.stringify({
    type: 'clarify',
    question: 'Kis kaam ke liye flow banau — subah alarm, khabrein, ya kuch aur?',
});

function greenFlow() {
    return JSON.parse(GREEN_MODEL_REPLY).flow;
}

// --- Fake req/res for controller tests --------------------------------------
function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

function stubDeps(modelReply, opts = {}) {
    const calls = { generate: [], findOne: [] };
    const generateAIReply = async (message, systemPrompt, userKey, model) => {
        calls.generate.push({ message, systemPrompt, userKey, model });
        if (opts.generateThrows) throw opts.generateThrows;
        return typeof modelReply === 'function' ? modelReply(message) : modelReply;
    };
    return {
        calls,
        deps: {
            generateAIReply,
            connectToDatabase: async () => {},
            AppConfig: {
                findOne: async (q) => {
                    calls.findOne.push({ model: 'AppConfig', query: q });
                    return opts.maintenance ? { maintenance: { enabled: true, message: 'Maintenance.' } } : null;
                },
            },
            User: {
                findOne: async (q) => {
                    calls.findOne.push({ model: 'User', query: q });
                    return opts.banned ? { status: 'banned' } : null;
                },
            },
        },
    };
}

// --- (a) Service tests --------------------------------------------------------
describe('flowGenerateService', () => {
    it('allow-lists match P7: 13 AVAILABLE triggers, 2 PLANNED, 19 actions', () => {
        assert.equal(Object.keys(AVAILABLE_TRIGGERS).length, 13);
        assert.equal(PLANNED_TRIGGERS.length, 2);
        assert.equal(Object.keys(AVAILABLE_ACTIONS).length, 19);
        assert.ok(!PLANNED_TRIGGERS.includes('bluetooth.connected'));
        assert.ok(!PLANNED_TRIGGERS.includes('bluetooth.disconnected'));
        assert.ok(PLANNED_TRIGGERS.includes('geofence.enter'));
        assert.ok(PLANNED_TRIGGERS.includes('geofence.exit'));
    });

    it('system prompt is server-built: lists allow-lists, clarify rule, no-password rule', () => {
        const prompt = buildFlowSystemPrompt();
        assert.match(prompt, /dslVersion/);
        assert.match(prompt, /bluetooth/i); // named in the trigger list (P7: available)
        assert.match(prompt, /clarify/);
        assert.match(prompt, /Never put passwords, OTPs, PINs, tokens/);
        assert.match(prompt, /news\.latest/);
        assert.match(prompt, /"confirm":"always"/);
    });

    it('green sentence flow validates against the P1 shape mirror (0 errors)', () => {
        const errors = validateFlowShape(greenFlow());
        assert.deepEqual(errors, []);
    });

    it('classify: green model reply -> {type:flow} with a valid flow', () => {
        const out = classifyModelReply(GREEN_MODEL_REPLY);
        assert.equal(out.type, 'flow');
        assert.deepEqual(validateFlowShape(out.flow), []);
        assert.equal(out.flow.triggers[0].type, 'time');
    });

    it('classify: fenced ```json reply is accepted', () => {
        const out = classifyModelReply('```json\n' + GREEN_MODEL_REPLY + '\n```');
        assert.equal(out.type, 'flow');
    });

    it('classify: bare DSL object (no envelope) is accepted as a flow', () => {
        const out = classifyModelReply(JSON.stringify(greenFlow()));
        assert.equal(out.type, 'flow');
    });

    it('classify: malformed AI output -> clean error, never a half-flow', () => {
        for (const bad of ['not json at all', '{"type":"flow","flow":', '{"type":"flow"}', '', '   ']) {
            const out = classifyModelReply(bad);
            assert.equal(out.type, 'error', bad);
            assert.equal(out.flow, undefined);
            assert.match(out.error, /dobara try karo/);
        }
    });

    it('classify: vague request -> clarify passthrough, not a guessed flow', () => {
        const out = classifyModelReply(VAGUE_MODEL_REPLY);
        assert.equal(out.type, 'clarify');
        assert.match(out.question, /Kis kaam/);
        assert.equal(out.flow, undefined);
    });

    it('headphone sentence (P7): bluetooth triggers validate GREEN (0 errors)', () => {
        const flow = JSON.parse(HEADPHONE_MODEL_REPLY).flow;
        const errors = validateFlowShape(flow);
        assert.deepEqual(errors, []);
    });

    it('headphone sentence (P7): classify turns it into a {type:flow}', () => {
        const out = classifyModelReply(HEADPHONE_MODEL_REPLY);
        assert.equal(out.type, 'flow');
        assert.deepEqual(validateFlowShape(out.flow), []);
        assert.equal(out.flow.triggers.length, 2);
    });

    it('shape mirror: unknown action rejected (V2, near-miss never fuzzy-matched)', () => {
        const flow = greenFlow();
        flow.steps[0].action = 'news.latestt';
        const errors = validateFlowShape(flow);
        assert.ok(errors.some((e) => e.startsWith('V2:')));
    });

    it('shape mirror: unknown trigger rejected (V1)', () => {
        const flow = greenFlow();
        flow.triggers = [{ type: 'time.travel', hour: 7, minute: 0 }];
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V1:')));
    });

    it('shape mirror: missing trigger arg rejected (V1)', () => {
        const flow = greenFlow();
        flow.triggers = [{ type: 'time', hour: 7 }];
        assert.ok(validateFlowShape(flow).some((e) => e.includes('minute')));
    });

    it('shape mirror: HIGH action without confirm always rejected (V6)', () => {
        const flow = greenFlow();
        flow.steps = [
            { id: 's1', kind: 'action', action: 'whatsapp.send', args: { recipient: 'Ali Khan', text: 'Good night' }, confirm: 'first_run', verify: 'sent' },
        ];
        flow.permissions = ['whatsapp.send', 'contacts.read'];
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V6:')));
    });

    it('shape mirror: credential-shaped text rejected (V8)', () => {
        const flow = greenFlow();
        flow.steps[1].args.text = 'my password is hunter2';
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V8:')));
    });

    it('shape mirror: total wait over 60s rejected (V5)', () => {
        const flow = greenFlow();
        flow.steps = [
            { id: 's1', kind: 'wait', seconds: 60 },
            { id: 's2', kind: 'wait', seconds: 60 },
            { id: 's3', kind: 'action', action: 'news.latest', args: {}, confirm: 'first_run', verify: 'ok' },
        ];
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V5:') && e.includes('Total wait')));
    });

    it('shape mirror: forward step-output ref rejected (V3)', () => {
        const flow = greenFlow();
        flow.variables = [{ name: 'x', type: 'string', initial: '' }];
        flow.steps = [
            { id: 's1', kind: 'set_variable', variable: 'x', value: 'steps.s2.sent' },
            { id: 's2', kind: 'action', action: 'whatsapp.send', args: { recipient: 'Ali Khan', text: 'hi' }, confirm: 'always', verify: 'sent' },
        ];
        flow.permissions = ['whatsapp.send', 'contacts.read'];
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V3:') && e.includes('Forward')));
    });

    it('shape mirror: dslVersion 2 rejected as app-update (V10)', () => {
        const flow = greenFlow();
        flow.dslVersion = 2;
        assert.ok(validateFlowShape(flow).some((e) => e.includes('app update')));
    });

    it('shape mirror: dead step rejected (V7)', () => {
        const flow = greenFlow();
        flow.steps = [
            { id: 's1', kind: 'condition', if: { var: 'battery', op: '>=', value: 20 }, then: ['s3'], else: ['s3'] },
            { id: 's2', kind: 'action', action: 'news.latest', args: {}, confirm: 'first_run', verify: 'ok' },
            { id: 's3', kind: 'action', action: 'news.latest', args: {}, confirm: 'first_run', verify: 'ok' },
        ];
        // s2 is unreachable: s1 branches only to s3, and no step falls through into s2.
        assert.ok(validateFlowShape(flow).some((e) => e.startsWith('V7:') && e.includes('s2')));
    });

    it('extractJson throws on garbage (no silent parse)', () => {
        assert.throws(() => extractJson('hello world'), /No JSON object/);
        assert.throws(() => extractJson('{"a": }'), /not valid JSON/);
    });
});

// --- (b) Controller contract tests -------------------------------------------
describe('flowController.generateFlow (stubbed deps)', () => {
    it('valid request -> {type:flow} envelope; flow validates green; prompt is server-built', async () => {
        const { calls, deps } = stubDeps(GREEN_MODEL_REPLY);
        const handler = createGenerateFlowHandler(deps);
        const req = { body: { message: 'Roz subah 7 baje taaza khabrein nikaal kar mujhe notification mein dikhao.' }, user: { username: 'testuser' } };
        const res = fakeRes();
        await handler(req, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.success, true);
        assert.equal(res.body.type, 'flow');
        assert.deepEqual(validateFlowShape(res.body.flow), []);
        assert.equal(res.body.model, 'gemini-3.6-flash');
        // The provider got the SERVER-BUILT prompt, never a client one:
        // the request carried no systemInstruction/systemPrompt field.
        assert.equal(calls.generate.length, 1);
        assert.equal(calls.generate[0].message, req.body.message);
        assert.match(calls.generate[0].systemPrompt, /dslVersion/);
        assert.equal(calls.generate[0].userKey, '');
        // No writes anywhere: only findOne reads happened (AppConfig + User).
        assert.ok(calls.findOne.every((c) => c.query && typeof c.query === 'object'));
    });

    it('malformed AI output -> clean {type:error}, never a half-flow', async () => {
        const { deps } = stubDeps('this is not json {{{');
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'kuch banao' }, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.type, 'error');
        assert.equal(res.body.flow, undefined);
        assert.match(res.body.error, /dobara try karo/);
    });

    it('headphone model reply (P7) -> clean {type:flow} envelope, flow validates green', async () => {
        const { deps } = stubDeps(HEADPHONE_MODEL_REPLY);
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'Jab Bluetooth headphones connect hon, music player open karo.' }, user: { username: 'u' } }, res);
        assert.equal(res.body.type, 'flow');
        assert.deepEqual(validateFlowShape(res.body.flow), []);
    });

    it('vague request -> {type:clarify} passthrough, not a guessed flow', async () => {
        const { deps } = stubDeps(VAGUE_MODEL_REPLY);
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'kuch acha sa banao' }, user: { username: 'u' } }, res);
        assert.equal(res.body.type, 'clarify');
        assert.match(res.body.question, /Kis kaam/);
        assert.equal(res.body.flow, undefined);
    });

    it('missing message -> 400, provider never called', async () => {
        const { calls, deps } = stubDeps(GREEN_MODEL_REPLY);
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: {}, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(calls.generate.length, 0);
    });

    it('over-long message -> 400, provider never called', async () => {
        const { calls, deps } = stubDeps(GREEN_MODEL_REPLY);
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'x'.repeat(16385) }, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 400);
        assert.equal(calls.generate.length, 0);
    });

    it('banned user -> 403, provider never called', async () => {
        const { calls, deps } = stubDeps(GREEN_MODEL_REPLY, { banned: true });
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'kuch banao' }, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 403);
        assert.equal(calls.generate.length, 0);
    });

    it('maintenance on -> 503, provider never called', async () => {
        const { calls, deps } = stubDeps(GREEN_MODEL_REPLY, { maintenance: true });
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'kuch banao' }, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 503);
        assert.equal(calls.generate.length, 0);
    });

    it('provider key missing -> 503 with code, never a fabricated reply', async () => {
        const err = new Error('No AI provider is configured on the server.');
        err.code = 'AI_KEY_MISSING';
        const { deps } = stubDeps(null, { generateThrows: err });
        const handler = createGenerateFlowHandler(deps);
        const res = fakeRes();
        await handler({ body: { message: 'kuch banao' }, user: { username: 'u' } }, res);
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, 'AI_KEY_MISSING');
    });
});
