'use strict';

const crypto = require('crypto');
const { connectToDatabase, isDbConnected } = require('../config/db');
const User = require('../models/User');
const PatchRecipe = require('../models/PatchRecipe');
const { getRecipe } = require('../patch/methods');

// Recipe lifetime: 5 minutes. The client must fetch + use the recipe inside
// this window; afterwards the row is unusable and TTL-deleted.
const RECIPE_TTL_MS = 5 * 60 * 1000;

/**
 * PHASE F — POST /api/patch/request
 *
 * Authenticated (JWT) + Kamal ID device-binding check + ~10/hr per-user rate
 * limit (enforced in patchRoutes). The existing authorize-patch credit
 * deduction is REUSED, not duplicated: the client calls /api/authorize-patch
 * first (1 credit deducted atomically there), then requests the recipe here.
 * This endpoint deducts nothing.
 *
 * Crypto envelope (all fresh per request — this is the replay protection):
 *   1. recipeId  = uuid, nonce = 12 random bytes, aesKey = 32 random bytes
 *   2. recipe JSON (from src/patch/methods.js) encrypted with AES-256-GCM
 *      using the nonce as IV  -> encRecipe = base64(ciphertext | tag)
 *   3. aesKey encrypted with the device's RSA public key (RSA-OAEP-SHA256,
 *      the device generated an ephemeral RSA-2048 keypair) -> encKey
 *   4. row stored {recipeId, username, kamalId, method, used:false, expiresAt}
 *
 * Response: {recipeId, nonce, encKey, encRecipe, expiresAt}.
 *
 * Residual risk (documented honestly): a rooted device could intercept the
 * decrypted recipe in RAM at patch time. Single-use + 5-min TTL + per-user
 * device binding bounds that exposure; the credit ledger and recipe audit
 * remain authoritative server-side.
 */
async function requestRecipe(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Patch recipe requires database connection.' });
    }
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    const { method, devicePubkeyPem, deviceId, subMode, authToken } = req.body || {};
    const recipe = getRecipe(method);
    if (!recipe) {
        return res.status(400).json({ success: false, error: 'Unknown patch method. Use "normal", "pro", "method3", "method4", "method5" or "method6".' });
    }
    // v91 (BugHunter backend F6): a recipe is issued ONLY against a
    // server-side authorization record created by /api/authorize-patch (1
    // credit deducted there). The record is consumed atomically here — a
    // client that skips authorize can no longer patch for free.
    if (!authToken || typeof authToken !== 'string') {
        return res.status(400).json({ success: false, error: 'Patch authorization required. Call /api/authorize-patch first.' });
    }
    const PatchAuthorization = require('../models/PatchAuthorization');
    const authRecord = await PatchAuthorization.findOneAndUpdate(
        { token: authToken.trim(), username, used: false, expiresAt: { $gt: new Date() } },
        { $set: { used: true, method: recipe.method } },
        { new: true }
    );
    if (!authRecord) {
        return res.status(400).json({ success: false, error: 'Patch authorization missing, already used, or expired. Call /api/authorize-patch first.' });
    }
    // v91 (BugHunter frontback F15): Moshi serializes an explicit JSON null,
    // and `subMode !== undefined` let null through as "provided" (400 for
    // Method 4). Null is now treated as absent, like undefined.
    if (recipe.method === 'method4' && subMode != null) {
        if (subMode !== 'tiktok' && subMode !== 'instagram') {
            return res.status(400).json({ success: false, error: 'Invalid subMode. Use "tiktok" or "instagram".' });
        }
        recipe.subMode = subMode;
    }

    let deviceKey;
    try {
        if (!devicePubkeyPem || typeof devicePubkeyPem !== 'string') throw new Error('missing');
        deviceKey = crypto.createPublicKey(devicePubkeyPem.trim());
        if (deviceKey.asymmetricKeyType !== 'rsa') throw new Error('not-rsa');
    } catch (_) {
        return res.status(400).json({ success: false, error: 'Invalid device public key (RSA PEM required).' });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Account banned.' });

        // Pro recipes are a Pro entitlement: UI gating alone is bypassable,
        // so the server enforces it here too. Method 4 + Method 5 are
        // PRO-gated like Forge (v90 decision); Method 6 is PRO-gated the
        // same way (v92 decision, user-approved on defaults); Method 3
        // stays free.
        if ((recipe.method === 'pro' || recipe.method === 'method4' || recipe.method === 'method5' || recipe.method === 'method6') && !user.isPro) {
            return res.status(403).json({ success: false, error: 'Pro patching requires a Pro plan.' });
        }

        // Kamal ID binding check (mirrors login semantics): a bound device
        // that does not match is rejected; first use binds the device.
        const cleanDevice = String(deviceId || '').trim();
        if (user.deviceId && cleanDevice && user.deviceId !== cleanDevice) {
            return res.status(403).json({
                success: false,
                error: `Device mismatch: this account is bound to another device. Please login from the bound device or contact Admin for a hardware reset.`
            });
        }
        if (!user.deviceId && cleanDevice) {
            // v91 (BugHunter DB P1-13): targeted $set, not whole-doc save().
            await User.updateOne({ _id: user._id }, { $set: { deviceId: cleanDevice } });
        }

        const recipeId = crypto.randomUUID();
        const nonce = crypto.randomBytes(12);
        const aesKey = crypto.randomBytes(32);
        const expiresAt = new Date(Date.now() + RECIPE_TTL_MS);

        const plaintext = Buffer.from(JSON.stringify(recipe), 'utf8');
        const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, nonce);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        const encRecipe = Buffer.concat([ct, tag]).toString('base64');

        const encKey = crypto.publicEncrypt(
            {
                key: deviceKey,
                padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            aesKey
        ).toString('base64');

        await PatchRecipe.create({
            recipeId,
            username,
            kamalId: cleanDevice || user.deviceId || '',
            method: recipe.method,
            used: false,
            expiresAt
        });

        return res.json({
            success: true,
            recipeId,
            nonce: nonce.toString('base64'),
            encKey,
            encRecipe,
            expiresAt: expiresAt.getTime()
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

/**
 * PHASE F — POST /api/patch/apply {recipeId, success}
 *
 * Marks the recipe used EXACTLY once (atomic findOneAndUpdate guarded by
 * used:false + unexpired). This is the audit trail; a second call for the
 * same recipeId is rejected. The client calls this best-effort after the
 * patch finishes — the TTL still expires the row if the call never lands.
 */
async function applyRecipe(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline.' });
    }
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    const { recipeId, success } = req.body || {};
    if (!recipeId || typeof recipeId !== 'string') {
        return res.status(400).json({ success: false, error: 'recipeId required.' });
    }

    try {
        const row = await PatchRecipe.findOneAndUpdate(
            {
                recipeId: recipeId.trim(),
                username,
                used: false,
                expiresAt: { $gt: new Date() }
            },
            { $set: { used: true, success: success === true, appliedAt: new Date() } },
            { new: true }
        );
        if (!row) {
            return res.status(410).json({
                success: false,
                error: 'Recipe not found, already used, or expired.'
            });
        }
        return res.json({ success: true, ok: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = { requestRecipe, applyRecipe };
