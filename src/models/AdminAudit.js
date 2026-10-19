// PHASE C — admin audit log (blueprint §6: "log broadcasts (who sent,
// audience size, timestamp) in an audit collection"). A broadcast channel to
// every user is powerful — treat it like one.
const mongoose = require('mongoose');

const AdminAuditSchema = new mongoose.Schema({
    adminId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true }, // e.g. 'broadcast'
    audience: { type: String, default: '' },               // e.g. 'all' | 'language:ur' | 'status:active'
    count: { type: Number, default: 0 },                   // recipient count
    createdAt: { type: Number, default: Date.now }
});

AdminAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.models.AdminAudit || mongoose.model('AdminAudit', AdminAuditSchema);
