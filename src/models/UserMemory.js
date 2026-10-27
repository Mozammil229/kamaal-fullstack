const mongoose = require('mongoose');

// AI MEMORY ENGINE (user order 2026-10-20): per-user LONG-TERM memory for
// PRO users. Facts are things the USER stated about themselves in chat
// (name, family, friends, own phone number, preferences, projects,
// decisions, corrections), extracted server-side after each reply.
// Fact VALUES are stored AES-256-GCM encrypted (valueEnc) — the plaintext
// never touches the database, and there is NO admin route to this data:
// a user can only ever read/delete their own memory via /api/ai/memory.
const MemoryFactSchema = new mongoose.Schema({
    category: {
        type: String,
        enum: ['identity', 'family', 'friends', 'contact', 'preference', 'project', 'decision', 'other'],
        default: 'other',
    },
    // Short stable label for the fact, e.g. "father_name", "best_friend".
    key: { type: String, required: true },
    // AES-256-GCM ciphertext (see services/memoryCrypto.js) — NOT plaintext.
    valueEnc: { type: String, required: true },
    kind: { type: String, enum: ['confirmed', 'preference'], default: 'confirmed' },
    source: { type: String, default: 'chat' },
    updatedAt: { type: Date, default: Date.now },
}, { _id: true });

const UserMemorySchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, index: true },
    // User-controlled ON/OFF switch (POST /api/ai/memory/settings).
    enabled: { type: Boolean, default: true },
    facts: { type: [MemoryFactSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    // v91 (BugHunter DB P2-17): optimistic concurrency — two concurrent
    // chat replies used to load the same doc and last-writer-wins overwrite
    // each other's extracted facts. With this on, save() throws VersionError
    // on a stale __v and extractAndSave retries once against fresh data.
}, { optimisticConcurrency: true });

module.exports = mongoose.models.UserMemory || mongoose.model('UserMemory', UserMemorySchema);
