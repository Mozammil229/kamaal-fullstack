const mongoose = require('mongoose');

// Single-use access tokens for the gated "Online Tool" page.
// Issued by POST /api/online-tool/token (auth + credits gate), redeemed once by
// GET /<onlineToolCustomPath>?token=... . Atomic findOneAndDelete on redeem
// guarantees single-use even across concurrent serverless invocations.
// MongoDB TTL prunes stale docs; expiry is ALSO enforced explicitly in code
// (TTL sweeps run ~every 60s, so it cannot be the sole expiry check).
const OnlineToolTokenSchema = new mongoose.Schema({
    tokenHash: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now, expires: '15m' } // auto-prune leftovers
});

module.exports = mongoose.models.OnlineToolToken || mongoose.model('OnlineToolToken', OnlineToolTokenSchema);
