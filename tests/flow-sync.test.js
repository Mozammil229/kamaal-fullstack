// Flow Engine X P13 — backend contract tests.
//
// Run: `node --test tests/flow-sync.test.js` (Node >= 18 built-in
// runner; no extra test dependency). Same tradition as P2's
// flow-generate.test.js: handlers via createFlowSyncHandlers with
// fake in-memory models — no running server, no Mongo, no live backend.
//
// Coverage:
//  (a) push/pull round-trip (opaque blob stored byte-identical);
//  (b) per-user isolation — user A can never read user B's record
//      (pull 404, list shows own records only);
//  (c) conflict — baseVersionHash mismatch is a 409 with server
//      version + hash, and nothing is overwritten;
//  (d) banned fields — any secret/credential/body/recipient key in
//      the request is a 400 and nothing is stored;
//  (e) shares — owner-only share, recipient pull via share, stranger 404;
//  (f) templates — owner-only publish, scoped list (owner + shared-with-me,
//      no public listing), review validation;
//  (g) workspaces — create, owner-only add-member, member list;
//  (h) stored-copy snapshot — the stored record contains zero fake
//      secret/body strings (the P9 T6 property, server-side).
//
// All fixture values are clearly fake ("TEST-NOT-A-SECRET" etc.) — no
// real secret, credential, or message body anywhere in this file.

'use strict';
// 4A: dummy secrets for boot only (same pattern as tests/web-auth.test.js).
// env.js is fail-closed (F-02 fix, pre-existing) — without these, requiring
// any controller that loads env.js throws before the first test runs.
process.env.JWT_SECRET = 'test-jwt-secret-4a-only';
process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret-4a-only';
delete process.env.MONGODB_URI;


const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createFlowSyncHandlers, validatePushBody } = require('../src/controllers/flowSyncController');

const FAKE_SECRET = 'TEST-NOT-A-SECRET';
const FAKE_BODY = 'TEST-BODY-HELLO-WORLD';
const FAKE_RECIPIENT = 'TEST-RECIPIENT-NAME';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// --- Fake Mongoose-ish models (in-memory arrays) ---------------------------
function fakeModel() {
    const rows = [];
    let seq = 0;
    const match = (doc, filter) =>
        Object.entries(filter).every(([k, v]) => String(doc[k]) === String(v));
    return {
        rows,
        async findOne(filter) { return rows.find((d) => match(d, filter)) || null; },
        async find(filter) { return rows.filter((d) => match(d, filter)); },
        async create(doc) {
            const row = { ...doc, _id: `fake-id-${++seq}` };
            rows.push(row);
            return row;
        },
        async updateOne(filter, update) {
            const row = rows.find((d) => match(d, filter));
            if (!row) return { modifiedCount: 0 };
            Object.assign(row, (update && update.$set) || {});
            return { modifiedCount: 1 };
        }
    };
}

function handlersFor() {
    const models = {
        FlowSkill: fakeModel(),
        FlowShare: fakeModel(),
        FlowWorkspace: fakeModel(),
        FlowMembership: fakeModel(),
        FlowReview: fakeModel(),
        FlowVersion: fakeModel()
    };
    const handlers = createFlowSyncHandlers({
        ...models,
        connectToDatabase: async () => {}
    });
    return { handlers, models };
}

// --- Fake req/res ------------------------------------------------------------
function req(user, body, params) {
    return { user: user ? { username: user } : null, body: body || {}, params: params || {} };
}
function resCapture() {
    const res = { statusCode: 200, payload: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.payload = payload; return res; };
    return res;
}

function pushBody(overrides) {
    const body = {
        metadata: {
            flowId: 'flow-green', projectId: 'project-a', name: 'Subah ki khabrein',
            dslVersion: 1, registryVersion: 1, version: 1,
            baseVersionHash: '', contentHash: HASH_A,
            permissions: ['notification.post'], triggerTypes: ['time'],
            actionNames: ['news.latest'], variableNames: ['city']
        },
        encryptedBlob: {
            packed: 'CIPHERTEXT-PLACEHOLDER-BASE64',
            sha256Hex: HASH_A, saltB64: 'U0FMVC1CUk9ORV9GQUtF'
        }
    };
    return { ...body, ...(overrides || {}) };
}

describe('P13 flow sync — push/pull + isolation + conflict', () => {
    it('push creates a record (version 1) and pull returns the opaque blob byte-identical', async () => {
        const { handlers } = handlersFor();
        const pushRes = resCapture();
        await handlers.pushFlow(req('user-a', pushBody()), pushRes);
        assert.equal(pushRes.statusCode, 200);
        assert.equal(pushRes.payload.success, true);
        assert.equal(pushRes.payload.version, 1);
        assert.equal(pushRes.payload.contentHash, HASH_A);

        const pullRes = resCapture();
        await handlers.pullFlow(req('user-a', {}, { flowId: 'flow-green' }), pullRes);
        assert.equal(pullRes.statusCode, 200);
        assert.equal(pullRes.payload.skill.flowId, 'flow-green');
        assert.equal(pullRes.payload.skill.encryptedBlob.packed, 'CIPHERTEXT-PLACEHOLDER-BASE64');
        assert.equal(pullRes.payload.skill.encryptedBlob.sha256Hex, HASH_A);
        assert.equal(pullRes.payload.skill.owner, 'user-a');
    });

    it('push with the correct baseVersionHash appends version 2 + a version row', async () => {
        const { handlers, models } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const second = pushBody();
        second.metadata.baseVersionHash = HASH_A;
        second.metadata.contentHash = HASH_B;
        second.encryptedBlob.sha256Hex = HASH_B;
        const pushRes = resCapture();
        await handlers.pushFlow(req('user-a', second), pushRes);
        assert.equal(pushRes.statusCode, 200);
        assert.equal(pushRes.payload.version, 2);
        assert.equal(models.FlowVersion.rows.length, 2);
        assert.equal(models.FlowVersion.rows[1].contentHash, HASH_B);
    });

    it('push with a stale baseVersionHash is a 409 with server version + hash, nothing overwritten', async () => {
        const { handlers, models } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const stale = pushBody();
        stale.metadata.baseVersionHash = 'stale-base-hash';
        stale.metadata.contentHash = HASH_B;
        const pushRes = resCapture();
        await handlers.pushFlow(req('user-a', stale), pushRes);
        assert.equal(pushRes.statusCode, 409);
        assert.equal(pushRes.payload.error, 'conflict');
        assert.equal(pushRes.payload.serverVersion, 1);
        assert.equal(pushRes.payload.serverHash, HASH_A);
        // Stored record untouched: still version 1, still HASH_A.
        assert.equal(models.FlowSkill.rows.length, 1);
        assert.equal(models.FlowSkill.rows[0].version, 1);
        assert.equal(models.FlowSkill.rows[0].contentHash, HASH_A);
        assert.equal(models.FlowVersion.rows.length, 1);
    });

    it('user B cannot pull user A’s record (404) and list shows only own records', async () => {
        const { handlers } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const pullRes = resCapture();
        await handlers.pullFlow(req('user-b', {}, { flowId: 'flow-green' }), pullRes);
        assert.equal(pullRes.statusCode, 404);
        const listA = resCapture();
        await handlers.listFlows(req('user-a'), listA);
        assert.equal(listA.payload.flows.length, 1);
        const listB = resCapture();
        await handlers.listFlows(req('user-b'), listB);
        assert.equal(listB.payload.flows.length, 0);
    });

    it('list returns metadata only — no encryptedBlob, no internals', async () => {
        const { handlers } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const listRes = resCapture();
        await handlers.listFlows(req('user-a'), listRes);
        const row = listRes.payload.flows[0];
        assert.equal(row.flowId, 'flow-green');
        assert.equal('encryptedBlob' in row, false);
        assert.equal('_id' in row, false);
    });

    it('unauthenticated push/pull/list are 401', async () => {
        const { handlers } = handlersFor();
        for (const [fn, r] of [
            [handlers.pushFlow, req(null, pushBody())],
            [handlers.pullFlow, req(null, {}, { flowId: 'flow-green' })],
            [handlers.listFlows, req(null)]
        ]) {
            const captured = resCapture();
            await fn(r, captured);
            assert.equal(captured.statusCode, 401);
        }
    });
});

describe('P13 flow sync — banned fields + stored-copy snapshot', () => {
    it('a secret/credential/body/recipient key anywhere in the push is a 400 and nothing is stored', async () => {
        const { handlers, models } = handlersFor();
        const badBodies = [
            { ...pushBody(), secret: FAKE_SECRET },
            { ...pushBody(), metadata: { ...pushBody().metadata, password: FAKE_SECRET } },
            { ...pushBody(), encryptedBlob: { ...pushBody().encryptedBlob, apiKey: FAKE_SECRET } },
            { ...pushBody(), metadata: { ...pushBody().metadata, messageBody: FAKE_BODY } },
            { ...pushBody(), metadata: { ...pushBody().metadata, recipient: FAKE_RECIPIENT } }
        ];
        for (const bad of badBodies) {
            const captured = resCapture();
            await handlers.pushFlow(req('user-a', bad), captured);
            assert.equal(captured.statusCode, 400);
        }
        assert.equal(models.FlowSkill.rows.length, 0);
        assert.equal(models.FlowVersion.rows.length, 0);
    });

    it('an unknown metadata field is a 400; a missing blob is a 400; a bad hash is a 400', async () => {
        const { handlers } = handlersFor();
        const cases = [
            { ...pushBody(), metadata: { ...pushBody().metadata, steps: [] } },
            { metadata: pushBody().metadata },
            { ...pushBody(), metadata: { ...pushBody().metadata, contentHash: 'not-a-hash' } }
        ];
        for (const bad of cases) {
            const captured = resCapture();
            await handlers.pushFlow(req('user-a', bad), captured);
            assert.equal(captured.statusCode, 400);
        }
    });

    it('stored copy contains zero fake secret/body/recipient strings (T6, server-side)', async () => {
        const { handlers, models } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const stored = JSON.stringify(models.FlowSkill.rows) + JSON.stringify(models.FlowVersion.rows);
        assert.equal(stored.includes(FAKE_SECRET), false);
        assert.equal(stored.includes(FAKE_BODY), false);
        assert.equal(stored.includes(FAKE_RECIPIENT), false);
    });
});

describe('P13 flow sync — validatePushBody on the canonical nested envelope (F-01)', () => {
    it('accepts the canonical nested envelope (the app wire shape) incl. variableNames', () => {
        assert.equal(validatePushBody(pushBody()), null);
    });

    it('rejects a client-supplied updatedAt and the old flat shape (no metadata key)', () => {
        const withUpdatedAt = pushBody();
        withUpdatedAt.metadata = { ...withUpdatedAt.metadata, updatedAt: 1 };
        assert.equal(validatePushBody(withUpdatedAt), 'Unknown metadata field: updatedAt.');
        const flat = { ...pushBody().metadata, encryptedBlob: pushBody().encryptedBlob };
        assert.equal(validatePushBody(flat), 'metadata required.');
    });

    it('rejects a non-string variableNames entry', () => {
        const bad = pushBody();
        bad.metadata = { ...bad.metadata, variableNames: ['city', 7] };
        assert.equal(validatePushBody(bad), 'variableNames invalid.');
    });
});

describe('P13 flow sync — shares + templates + workspaces', () => {
    it('owner shares with B: B pulls via the share, a stranger still 404s', async () => {
        const { handlers } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const shareRes = resCapture();
        await handlers.shareFlow(req('user-a', { flowId: 'flow-green', sharedWith: 'user-b' }), shareRes);
        assert.equal(shareRes.statusCode, 200);
        assert.equal(shareRes.payload.success, true);

        const pullB = resCapture();
        await handlers.pullFlow(req('user-b', {}, { flowId: 'flow-green' }), pullB);
        assert.equal(pullB.statusCode, 200);
        assert.equal(pullB.payload.skill.owner, 'user-a');

        const pullC = resCapture();
        await handlers.pullFlow(req('user-c', {}, { flowId: 'flow-green' }), pullC);
        assert.equal(pullC.statusCode, 404);

        const shared = resCapture();
        await handlers.listSharedWithMe(req('user-b'), shared);
        assert.equal(shared.payload.flows.length, 1);
        assert.equal(shared.payload.flows[0].flowId, 'flow-green');
    });

    it('share by a non-owner is 404; sharing with yourself is 400', async () => {
        const { handlers } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const byB = resCapture();
        await handlers.shareFlow(req('user-b', { flowId: 'flow-green', sharedWith: 'user-c' }), byB);
        assert.equal(byB.statusCode, 404);
        const self = resCapture();
        await handlers.shareFlow(req('user-a', { flowId: 'flow-green', sharedWith: 'user-a' }), self);
        assert.equal(self.statusCode, 400);
    });

    it('only the owner publishes a template; templates list is scoped (owner + shared-with-me), metadata-only; reviews validate', async () => {
        const { handlers, models } = handlersFor();
        await handlers.pushFlow(req('user-a', pushBody()), resCapture());
        const byB = resCapture();
        await handlers.publishTemplate(req('user-b', { flowId: 'flow-green' }), byB);
        assert.equal(byB.statusCode, 404);
        const byA = resCapture();
        await handlers.publishTemplate(req('user-a', { flowId: 'flow-green' }), byA);
        assert.equal(byA.statusCode, 200);

        // No public listing (F-03): a non-owner, non-shared user lists 0.
        const listB = resCapture();
        await handlers.listTemplates(req('user-b'), listB);
        assert.equal(listB.payload.templates.length, 0);
        const listC = resCapture();
        await handlers.listTemplates(req('user-c'), listC);
        assert.equal(listC.payload.templates.length, 0);
        // The owner lists their own template.
        const listA = resCapture();
        await handlers.listTemplates(req('user-a'), listA);
        assert.equal(listA.payload.templates.length, 1);
        assert.equal('encryptedBlob' in listA.payload.templates[0], false);
        // Shared-with-me: once user-a shares the flow with user-b, user-b lists 1.
        await handlers.shareFlow(req('user-a', { flowId: 'flow-green', sharedWith: 'user-b' }), resCapture());
        const listBShared = resCapture();
        await handlers.listTemplates(req('user-b'), listBShared);
        assert.equal(listBShared.payload.templates.length, 1);
        assert.equal(listBShared.payload.templates[0].flowId, 'flow-green');
        assert.equal('encryptedBlob' in listBShared.payload.templates[0], false);

        const reviewRes = resCapture();
        await handlers.reviewTemplate(
            req('user-b', { decision: 'approve', note: 'Kaam karta hai.' }, { flowId: 'flow-green' }),
            reviewRes
        );
        assert.equal(reviewRes.statusCode, 200);
        assert.equal(models.FlowReview.rows.length, 1);

        const badDecision = resCapture();
        await handlers.reviewTemplate(
            req('user-b', { decision: 'love-it' }, { flowId: 'flow-green' }), badDecision
        );
        assert.equal(badDecision.statusCode, 400);
        const longNote = resCapture();
        await handlers.reviewTemplate(
            req('user-b', { decision: 'approve', note: 'x'.repeat(501) }, { flowId: 'flow-green' }),
            longNote
        );
        assert.equal(longNote.statusCode, 400);
        const noTemplate = resCapture();
        await handlers.reviewTemplate(
            req('user-b', { decision: 'approve' }, { flowId: 'flow-nope' }), noTemplate
        );
        assert.equal(noTemplate.statusCode, 404);
    });

    it('workspace: owner creates, only owner adds members, member sees it in list', async () => {
        const { handlers } = handlersFor();
        const createRes = resCapture();
        await handlers.createWorkspace(req('user-a', { name: 'Team Kamaal' }), createRes);
        assert.equal(createRes.statusCode, 200);
        const wsId = createRes.payload.workspaceId;

        const addByB = resCapture();
        await handlers.addMember(req('user-b', { user: 'user-c', role: 'Developer' }, { id: wsId }), addByB);
        assert.equal(addByB.statusCode, 403);
        const badRole = resCapture();
        await handlers.addMember(req('user-a', { user: 'user-b', role: 'SuperUser' }, { id: wsId }), badRole);
        assert.equal(badRole.statusCode, 400);
        const addRes = resCapture();
        await handlers.addMember(req('user-a', { user: 'user-b', role: 'Developer' }, { id: wsId }), addRes);
        assert.equal(addRes.statusCode, 200);

        const listB = resCapture();
        await handlers.listWorkspaces(req('user-b'), listB);
        assert.equal(listB.payload.workspaces.length, 1);
        assert.equal(listB.payload.workspaces[0].name, 'Team Kamaal');
        const listC = resCapture();
        await handlers.listWorkspaces(req('user-c'), listC);
        assert.equal(listC.payload.workspaces.length, 0);
    });
});
