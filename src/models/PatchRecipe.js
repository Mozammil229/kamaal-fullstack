'use strict';

const mongoose = require('mongoose');

/**
 * PHASE F — single-use patch recipe rows.
 *
 * One row per POST /api/patch/request. The row is the server-side record of
 * the encrypted recipe handed to the device: {recipeId, username, kamalId
 * (device binding), method, used, expiresAt}. POST /api/patch/apply flips
 * `used` exactly once (atomic findOneAndUpdate on used:false + unexpired),
 * which is the audit trail and the replay backstop: a captured recipeId can
 * never be applied twice, and rows self-delete 5 minutes after expiry via
 * the TTL index.
 */
const patchRecipeSchema = new mongoose.Schema({
    recipeId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, index: true },
    kamalId: { type: String, default: '' },
    method: { type: String, enum: ['normal', 'pro', 'method3', 'method4', 'method5'], required: true },
    used: { type: Boolean, default: false, index: true },
    success: { type: Boolean, default: null },
    createdAt: { type: Date, default: Date.now },
    // TTL index: MongoDB deletes the row once this timestamp passes.
    expiresAt: { type: Date, required: true, index: true },
    appliedAt: { type: Date, default: null }
});

patchRecipeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PatchRecipe || mongoose.model('PatchRecipe', patchRecipeSchema);
