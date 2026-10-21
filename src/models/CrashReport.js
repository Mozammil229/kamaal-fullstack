const mongoose = require('mongoose');

// One-tap crash reports sent from the Kamaal Android app (POST /api/crash-reports).
// The app sends stack trace + device/build diagnostics; the username ALWAYS comes
// from the verified JWT (never the request body). Admin reviews/deletes via
// GET/DELETE /api/admin/crash-reports. No TTL — reports are kept until the admin
// deletes them manually (per-report or clear-all).
const CrashReportSchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    deviceModel: { type: String, default: '' },
    androidVersion: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    appVersionCode: { type: Number },
    stackTrace: { type: String, default: '' },
    crashedAt: { type: Date },
    createdAt: { type: Date, default: Date.now, index: true } // newest-first listing
});

module.exports = mongoose.models.CrashReport || mongoose.model('CrashReport', CrashReportSchema);
