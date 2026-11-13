'use strict';

// Shared stubs for the 4D PWA-auth suites (NOT a test file itself —
// `node --test tests/*.test.js` only picks up *.test.js).
//
// Injects stub modules into require.cache BEFORE the app is required, so
// every controller/middleware that requires these paths gets the stub:
//   - src/config/db: online, no real Mongo.
//   - src/models/User: 4 seeded app users (password 'correct-password').
//   - src/models/RefreshToken: in-memory rows.
//   - src/models/RevokedToken: in-memory revocation set.
//   - src/models/AppConfig: maintenance OFF (getActiveConfig path).
// Env secrets are set here first (src/config/env.js throws without them).

process.env.JWT_SECRET = 'pwa-4d-test-jwt-secret';
process.env.ADMIN_JWT_SECRET = 'pwa-4d-test-admin-secret';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'correct-admin-pass';
delete process.env.MONGODB_URI;

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

function fakeQuery(value) {
    const q = {
        select() { return q; },
        sort() { return q; },
        limit() { return q; },
        lean() { return Promise.resolve(value); },
        then(res, rej) { return Promise.resolve(value).then(res, rej); },
        catch(err) { return Promise.resolve(value).catch(err); }
    };
    return q;
}

function matches(row, query) {
    if (!query || typeof query !== 'object') return true;
    for (const [key, val] of Object.entries(query)) {
        if (key === '$or') {
            if (!Array.isArray(val) || !val.some((clause) => matches(row, clause))) return false;
            continue;
        }
        if (row[key] === undefined) return false;
        if (String(row[key]) !== String(val)) return false;
    }
    return true;
}

// P-1b: operator-aware matcher for findOneAndUpdate filters — the ledger
// (modifyCredits) filters on credits: {$gte: n} and authorize-patch on
// holdSeq equality. Equality falls through to the plain matcher above.
function matchesUpdateFilter(row, query) {
    if (!query || typeof query !== 'object') return true;
    for (const [key, val] of Object.entries(query)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            if ('$gte' in val && !(row[key] >= val.$gte)) return false;
            if ('$gt' in val && !(row[key] > val.$gt)) return false;
            if ('$lte' in val && !(row[key] <= val.$lte)) return false;
            if ('$lt' in val && !(row[key] < val.$lt)) return false;
            if ('$ne' in val && String(row[key]) === String(val.$ne)) return false;
            continue;
        }
        if (row[key] === undefined) return false;
        if (String(row[key]) !== String(val)) return false;
    }
    return true;
}

function setPath(row, path, value) {
    const parts = String(path).split('.');
    let cur = row;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

function applyUpdate(row, update) {
    if (!update) return;
    for (const [path, delta] of Object.entries(update.$inc || {})) {
        const parts = String(path).split('.');
        let cur = row;
        for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
        const leaf = parts[parts.length - 1];
        cur[leaf] = (Number(cur[leaf]) || 0) + Number(delta);
    }
    for (const [path, value] of Object.entries(update.$set || {})) setPath(row, path, value);
}

function makeUser(username, email, phone) {
    return {
        _id: new mongoose.Types.ObjectId().toString(),
        username,
        name: `PWA ${username}`,
        email,
        phone,
        // The Android client's stored 30d token — PWA login must NEVER
        // overwrite it and NEVER return it in a body.
        token: 'android-stored-30d-token',
        passwordHash: bcrypt.hashSync('correct-password', 10),
        deviceId: '',
        credits: 5,
        creditsEarned: 0,
        isPro: false,
        status: 'active',
        tier: 'FREE',
        proPlan: 'trial',
        planExpiry: '',
        role: 'user',
        referralCode: 'KML-TEST',
        customPrompt: '',
        stats: { videosPatched: 0, videosEnhanced4K: 0, totalBandwidthBytes: 0 },
        lastActiveAt: new Date(),
        createdAt: new Date()
    };
}

const users = [
    makeUser('pwauser', 'pwa@kamaal.test', '+923001234567'),
    makeUser('pwauser2', 'pwa2@kamaal.test', '+923001234568'),
    makeUser('pwauser3', 'pwa3@kamaal.test', '+923001234569'),
    makeUser('pwauser4', 'pwa4@kamaal.test', '+923001234570')
];

const refreshRows = [];
const revokedHashes = new Set();

const stubUser = {
    _rows: users,
    findOne(query) {
        return fakeQuery(users.find((u) => matches(u, query)) || null);
    },
    findById(id) {
        return Promise.resolve(users.find((u) => String(u._id) === String(id)) || null);
    },
    find() {
        return fakeQuery([...users]);
    },
    async updateOne(filter, update) {
        const row = users.find((u) => matches(u, filter));
        if (!row) return { modifiedCount: 0 };
        Object.assign(row, (update && update.$set) || {});
        return { modifiedCount: 1 };
    },
    // P-1b: atomic findOneAndUpdate for the ledger (modifyCredits:
    // credits {$gte: n} + $inc) and authorize-patch (holdSeq CAS + $inc).
    // Single-threaded in-memory apply = atomic for the test harness.
    async findOneAndUpdate(filter, update, options) {
        const row = users.find((u) => matchesUpdateFilter(u, filter));
        if (!row) return null;
        applyUpdate(row, update);
        return row;
    }
};

const stubRefreshToken = {
    _rows: refreshRows,
    async create(data) {
        const row = { ...data, _id: new mongoose.Types.ObjectId().toString() };
        refreshRows.push(row);
        return row;
    },
    async findOne(query) {
        return refreshRows.find((r) => matches(r, query)) || null;
    },
    async updateOne(filter, update) {
        const row = refreshRows.find((r) => matches(r, filter));
        if (!row) return { modifiedCount: 0 };
        Object.assign(row, (update && update.$set) || {});
        return { modifiedCount: 1 };
    },
    // Atomic claim for the 4E F-04 rotation: matches the filter (incl.
    // revokedAt:null + replacedByHash:null) and applies $set in one step;
    // returns the updated row ({ new:true }) or null when no live row
    // matched — the same contract as Mongoose findOneAndUpdate.
    async findOneAndUpdate(filter, update, options) {
        const row = refreshRows.find((r) => matches(r, filter));
        if (!row) return null;
        Object.assign(row, (update && update.$set) || {});
        return options && options.new ? row : row;
    },
    async updateMany(filter, update) {
        let n = 0;
        for (const row of refreshRows.filter((r) => matches(r, filter))) {
            Object.assign(row, (update && update.$set) || {});
            n += 1;
        }
        return { modifiedCount: n };
    }
};

const stubRevokedToken = {
    async findOne(query) {
        return revokedHashes.has(query.tokenHash) ? { tokenHash: query.tokenHash } : null;
    },
    async create(data) {
        revokedHashes.add(data.tokenHash);
        return data;
    }
};

const stubAppConfig = {
    async findOneAndUpdate() {
        return { key: 'global_config', maintenance: { enabled: false }, defaultSignupCredits: 2 };
    },
    async findOne() {
        return { key: 'global_config', maintenance: { enabled: false }, defaultSignupCredits: 2 };
    }
};

// P-1b: in-memory Transaction ledger. modifyCredits writes its audit row
// best-effort; without this stub the real Mongoose model would buffer
// against the unconnected test DB (~10s timeout per money call). Rows are
// inspectable via the exported txRows (commit-path assertions).
const txRows = [];

const stubTransaction = {
    _rows: txRows,
    async create(data) {
        const row = { ...data, _id: new mongoose.Types.ObjectId().toString(), createdAt: new Date() };
        txRows.push(row);
        return row;
    },
    async findOne(query) {
        return txRows.find((r) => matches(r, query)) || null;
    }
};

function installStub(relativePath, exportsObj) {
    const resolved = require.resolve(relativePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

installStub('../src/config/db', {
    connectToDatabase: async () => {},
    isDbConnected: () => true
});
installStub('../src/models/User', stubUser);
installStub('../src/models/RefreshToken', stubRefreshToken);
installStub('../src/models/RevokedToken', stubRevokedToken);
installStub('../src/models/AppConfig', stubAppConfig);
installStub('../src/models/Transaction', stubTransaction);

module.exports = { users, refreshRows, revokedHashes, txRows, stubUser, stubRefreshToken, stubTransaction };
