const mongoose = require('mongoose');

/**
 * PHASE B — Kamal ID device identity (blueprint §4, §7).
 *
 * One document per physical device, keyed by the client-computed SHA-256
 * deviceHash (ANDROID_ID + build values, hashed on-device; the raw ANDROID_ID
 * never leaves the phone). The displayId (KML-XXXX-XXXX-XX) is the masked,
 * human-readable form safe to quote to support.
 *
 * userId binds the device to the account that registered / logged in on it.
 * Identity for binding ALWAYS comes from the verified JWT — never from a
 * client-supplied username (BYOK lesson, Oct 2026).
 */
const DeviceSchema = new mongoose.Schema({
    deviceHash: { type: String, unique: true, required: true, index: true },
    displayId: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    model: { type: String, default: '' },
    appVersion: { type: String, default: '' }
});

module.exports = mongoose.models.Device || mongoose.model('Device', DeviceSchema);
