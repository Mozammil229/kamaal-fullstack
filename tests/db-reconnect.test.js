'use strict';
// Regression test: one MongoClient per function instance, ever.
//
// Proven leak (2026-11-13, mongoose 8.24.8, local mongod repro): after a
// drop (readyState 0) the next connectToDatabase() called mongoose.connect()
// again, creating a SECOND MongoClient while the old one was never closed;
// the old client's monitor also reconnects on its own, so one instance
// ended up with 2+ live pools. The cold-start race was NOT a leak (8
// concurrent calls create exactly 1 client).
//
// The fix (src/config/db.js): cache the in-flight promise, and close any
// previous client BEFORE opening a new one.
//
// Runs a real mongod binary on a fixed port (same uri across stop/start).
// Skips gracefully when the cached mongod binary is absent.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

process.env.JWT_SECRET = 'test-jwt-secret-for-db-reconnect-test';
process.env.ADMIN_JWT_SECRET = 'test-admin-secret-for-db-reconnect-test';
process.env.NODE_ENV = 'test';

const MONGOD = path.join(os.homedir(), '.cache', 'mongodb-binaries', 'mongod-x64-ubuntu-8.2.6');
const PORT = 27199;
const URI = `mongodb://127.0.0.1:${PORT}/`;
const DBPATH = path.join(os.tmpdir(), 'kamaal-db-reconnect-test');
const LOGPATH = path.join(os.tmpdir(), 'kamaal-db-reconnect-test.log');
const PIDPATH = path.join(os.tmpdir(), 'kamaal-db-reconnect-test.pid');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function mongodStart() {
  fs.mkdirSync(DBPATH, { recursive: true });
  execSync(`"${MONGOD}" --dbpath "${DBPATH}" --port ${PORT} --bind_ip 127.0.0.1 --fork --logpath "${LOGPATH}" --pidfilepath "${PIDPATH}"`, { stdio: 'ignore' });
}
function mongodStop() {
  try {
    const pid = fs.readFileSync(PIDPATH, 'utf8').trim();
    if (pid) process.kill(Number(pid), 'SIGTERM');
  } catch (_) { /* already down */ }
}
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch (_) { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}
async function pingResilient(mongoose) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mongoose.connection.db.admin().ping();
      return;
    } catch (_) { await sleep(500); }
  }
  throw new Error('ping still failing after retries');
}

describe('db reconnect — one MongoClient per instance', { skip: !fs.existsSync(MONGOD) }, () => {
  let mongoose;
  let connectToDatabase;
  let createClientCalls = 0;
  let createdClients = [];
  let origCreate;

  before(async () => {
    try { mongodStop(); } catch (_) {}
    await sleep(500);
    fs.rmSync(DBPATH, { recursive: true, force: true });
    mongodStart();
    process.env.MONGODB_URI = URI;
    mongoose = require('mongoose');
    const NativeConnection = require('mongoose/lib/drivers/node-mongodb-native/connection');
    origCreate = NativeConnection.prototype.createClient;
    NativeConnection.prototype.createClient = async function (...args) {
      createClientCalls++;
      const r = await origCreate.apply(this, args);
      createdClients.push(this.client);
      return r;
    };
    delete require.cache[require.resolve('../src/config/db')];
    ({ connectToDatabase } = require('../src/config/db'));
    await waitFor(async () => {
      try { await connectToDatabase(); return mongoose.connection.readyState === 1; } catch (_) { return false; }
    }, 30000, 'initial connect');
  });

  after(async () => {
    // Close EVERY client created during the run (on old code the orphaned
    // one keeps the event loop alive otherwise — that hang is itself a
    // symptom of the leak this test guards against).
    for (const c of createdClients) { try { await c.close(); } catch (_) {} }
    try { await mongoose.disconnect(); } catch (_) {}
    try { mongodStop(); } catch (_) {}
    try { fs.rmSync(DBPATH, { recursive: true, force: true }); } catch (_) {}
  });

  it('concurrent cold-start calls create exactly one client', async () => {
    // Fresh process state for this check is the before() connect; the
    // count assertion below covers the whole file run, so re-assert the
    // total stays 1 after another concurrent burst.
    await Promise.all(Array.from({ length: 5 }, () => connectToDatabase()));
    assert.equal(createClientCalls, 1, 'concurrent calls must share one client');
    assert.equal(mongoose.connection.readyState, 1);
  });

  it('after a drop, no orphaned live client remains', async () => {
    const clientBeforeDrop = mongoose.connection.client;
    assert.ok(clientBeforeDrop, 'expected a live client before the drop');

    mongodStop();
    // Force the drop to register: an op fails and readyState drops to 0.
    await waitFor(async () => {
      try { await mongoose.connection.db.admin().ping(); return false; } catch (_) { /* down */ }
      return mongoose.connection.readyState === 0;
    }, 20000, 'readyState 0 after drop');
    assert.equal(mongoose.connection.readyState, 0);

    mongodStart();
    // Call IMMEDIATELY (no sleep): this is the window where the old code
    // opened a second client while the old one was still alive.
    const clientsBefore = createdClients.length;
    await connectToDatabase();
    assert.equal(mongoose.connection.readyState, 1, 'reconnected');
    await pingResilient(mongoose);

    if (createdClients.length > clientsBefore) {
      // Reconnect path was taken: the old client must be CLOSED, not
      // orphaned and live (the old code left it answering pings).
      let oldAlive = false;
      try { await clientBeforeDrop.db('admin').command({ ping: 1 }); oldAlive = true; } catch (_) { oldAlive = false; }
      assert.equal(oldAlive, false, 'previous client must be closed after reconnect, not orphaned-live');
    } else {
      // Cache/recovery path: same client, still the one live client.
      assert.equal(mongoose.connection.client, clientBeforeDrop);
    }

    // At most one live client may hold server connections.
    await Promise.allSettled(Array.from({ length: 10 }, () => mongoose.connection.db.admin().ping()));
    await pingResilient(mongoose);
    const status = await mongoose.connection.db.admin().serverStatus();
    assert.ok(status.connections.current <= 12,
      `expected at most one live pool (<=12 conns), got ${status.connections.current}`);
  });
});
