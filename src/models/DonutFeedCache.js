const mongoose = require('mongoose');

// Donut feed cache (YouTube Data API v3, nightly server-side fetch).
// One document per section, keyed by _id = sectionId ('trending', 'dramas',
// 'films', ...), plus ONE meta document with _id 'meta' holding the last
// run's quota usage + error. NO TTL delete: the last-good cache is kept
// indefinitely and overwritten on each successful run; a failed run never
// wipes the cache — it only updates lastError on the meta doc.
// Privacy (§4.2 of the Donut plan): this cache is the SAME for every user.
// No per-user data is ever stored here.
const DonutFeedItemSchema = new mongoose.Schema({
    videoId: { type: String, required: true },
    title: { type: String, default: '' },
    channelTitle: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    durationSeconds: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    publishedAt: { type: Date }
}, { _id: false });

const DonutFeedCacheSchema = new mongoose.Schema({
    // Section docs: _id IS the sectionId. Meta doc: _id 'meta'.
    _id: { type: String, required: true },
    sectionId: { type: String, default: '' },
    title: { type: String, default: '' },
    // 'trending' | 'genre' for section docs; 'meta' for the meta doc.
    kind: { type: String, enum: ['trending', 'genre', 'meta'], default: 'genre' },
    items: { type: [DonutFeedItemSchema], default: [] },
    // Null until the first successful run for this doc.
    fetchedAt: { type: Date, default: null },
    // Per-run quota accounting (written on the meta doc only).
    searchCallsUsed: { type: Number, default: 0 },
    unitsUsed: { type: Number, default: 0 },
    // Last run's failure, '' when the last run was clean. A failed run
    // updates this and leaves fetchedAt (and the items) untouched.
    lastError: { type: String, default: '' }
});

module.exports = mongoose.models.DonutFeedCache || mongoose.model('DonutFeedCache', DonutFeedCacheSchema);
