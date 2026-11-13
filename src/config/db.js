const mongoose = require('mongoose');
const env = require('./env');

// One MongoClient per function instance, ever.
//
// The previous version cached only the RESOLVED connection. After a drop
// (readyState 0 — Vercel freeze/thaw, Atlas idle-close) the next request
// called mongoose.connect() again, which creates a NEW MongoClient while
// the old one was never closed (no close/disconnect call existed anywhere
// in src/ or api/). The old client's monitor ALSO reconnects on its own,
// so one instance ended up with 2+ live pools. Proven by repro against
// a local mongod (mongoose 8.24.8): 1 drop -> createClient 1 -> 2,
// c1 !== c2, old client still answering pings. The cold-start race was
// NOT a leak: 8 concurrent connectToDatabase() calls create exactly 1
// client (mongoose guards it via _connectionString).
//
// Fix: cache the in-flight promise (concurrent callers share one attempt),
// and close any previous client BEFORE opening a new one, so at most one
// live client ever exists per instance. maxPoolSize 10 -> 5: handlers are
// mostly sequential (observed max fan-out is 2 parallel queries, a
// handful for social unread counts); 10/instance multiplied across warm
// Vercel instances is what pushes the M0 cluster toward its limit.

let cachedConnection = null;
let connectPromise = null;

async function connectToDatabase() {
    if (cachedConnection && mongoose.connection.readyState === 1) {
        return cachedConnection;
    }

    // A connect is already in flight (e.g. api/index.js fire-and-forget
    // at cold start + a simultaneous request): share it, never start a
    // second one.
    if (connectPromise) return connectPromise;

    if (!env.MONGODB_URI) {
        console.warn('⚠️ [MONGODB] MONGODB_URI not provided. Running in memory / offline mode.');
        return null;
    }

    connectPromise = (async () => {
        try {
            // Close any previous client first — a dropped connection or a
            // failed earlier attempt leaves one behind, and opening a new
            // client without closing it orphans its whole pool.
            if (cachedConnection || mongoose.connection.client) {
                try { await mongoose.connection.close(); } catch (_) {}
                cachedConnection = null;
            }

            const conn = await mongoose.connect(env.MONGODB_URI, {
                serverSelectionTimeoutMS: 5000,
                socketTimeoutMS: 45000,
                maxPoolSize: 5
            });
            cachedConnection = conn;
            console.log('✅ [MONGODB] Connected to MongoDB Atlas cluster.');
            return cachedConnection;
        } catch (err) {
            console.error('❌ [MONGODB] Connection error:', err.message);
            return null;
        } finally {
            connectPromise = null;
        }
    })();

    return connectPromise;
}

module.exports = {
    connectToDatabase,
    isDbConnected: () => mongoose.connection.readyState === 1
};
