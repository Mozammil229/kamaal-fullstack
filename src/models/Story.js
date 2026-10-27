// PHASE E — Stories (blueprint E3).
// Photo-only, 24h expiry. The server filters expired rows on read
// (stories/feed); clients additionally hide anything past expiresAt.
const mongoose = require('mongoose');

const StorySchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    photoUrl: { type: String, required: true },
    // v91 (BugHunter DB P1-11): MongoDB TTL only acts on Date fields — the old
    // Number type meant expired stories were never auto-deleted. Date now.
    expiresAt: { type: Date, required: true, index: true },
    createdAt: { type: Number, default: Date.now }
});

// Auto-delete expired stories in Mongo (safety net; reads filter too).
StorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.Story || mongoose.model('Story', StorySchema);
