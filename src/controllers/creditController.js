const User = require('../models/User');
const RedeemKey = require('../models/RedeemKey');
const PaymentProof = require('../models/PaymentProof');
const SupportMessage = require('../models/SupportMessage');
const Transaction = require('../models/Transaction');
const { modifyCredits } = require('../services/ledgerService');
const { connectToDatabase, isDbConnected } = require('../config/db');

// Get Credits (JWT-authenticated; username from verified token only)
async function getCredits(req, res) {
    await connectToDatabase();
    // v91 (BugHunter backend F29): the 503 guard its siblings have.
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline.' });
    }
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        // v91 (BugHunter frontback F2): the ban watchdog polls this endpoint
        // expecting a 403 for banned users — it never got one.
        if (user.status === 'banned') return res.status(403).json({ success: false, error: 'Account banned.' });

        return res.json({
            success: true,
            credits: user.credits,
            tier: user.tier,
            isPro: user.isPro,
            plan: user.proPlan,
            planExpiry: user.planExpiry
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Deduct Credit (Concurrency-Safe)
async function deductCredit(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Financial operations require authoritative database connection.' });
    }

    const { amount, reason } = req.body;
    // SECURITY FIX: username comes from the verified JWT only — never from
    // the body — so one user cannot deduct another user's credits.
    const targetUser = req.user?.username;
    if (!targetUser) return res.status(401).json({ success: false, error: 'Authentication required.' });

    // SECURITY FIX: amount must be a positive finite number. Previously
    // amount=-100 was flipped to +100 credits via modifyCredits (free money).
    const decAmt = Number(amount);
    if (!Number.isFinite(decAmt) || decAmt <= 0) {
        return res.status(400).json({ success: false, error: 'Amount must be a positive number.' });
    }
    // v91 (BugHunter backend F7): a non-string `reason` threw TypeError on
    // `reason?.includes('4K')` AFTER modifyCredits had already deducted —
    // the 500 made the client retry and double-deduct. Validate first.
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
        return res.status(400).json({ success: false, error: 'Reason must be a string.' });
    }

    try {
        const user = await User.findOne({ username: targetUser });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        // Deduct using atomic ledger service
        const { user: updatedUser } = await modifyCredits({
            username: targetUser,
            amount: -decAmt,
            type: 'usage_deduct',
            description: `Credit deducted for ${reason || 'video patch'}`,
            adminUser: 'System'
        });

        // v91 (BugHunter backend F7): the stats save used to run as a whole-
        // doc save AFTER the deduct — a failure there 500d with the credit
        // already spent. Stats are now a best-effort atomic $inc.
        try {
            const statField = (typeof reason === 'string' && reason.includes('4K'))
                ? 'stats.videosEnhanced4K' : 'stats.videosPatched';
            await User.updateOne({ username: targetUser }, { $inc: { [statField]: 1 } });
        } catch (_) { /* stats are non-critical */ }

        return res.json({ success: true, remaining: updatedUser.credits, isPro: updatedUser.isPro });
    } catch (e) {
        if (e.message.includes('Insufficient credits')) {
            return res.status(402).json({ success: false, error: 'Insufficient credits. Please upgrade or redeem voucher.' });
        }
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Authorize + Atomic Deduct (single server-side operation)
// This endpoint BOTH authorizes and deducts exactly 1 credit atomically.
// The client must never deduct on its own: only a 2xx {authorized:true}
// response means a credit was consumed server-side. Offline / unverifiable
// requests can therefore never yield a free patch.
async function authorizePatch(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ authorized: false, error: 'Database offline. Authorization requires authoritative database connection.' });
    }
    // Username comes from the verified JWT (route uses authenticateUser) —
    // never from the body — so an attacker cannot spend a victim's credits.
    const target = req.user?.username;
    if (!target) return res.status(401).json({ authorized: false, error: 'Authentication required.' });

    try {
        const user = await User.findOne({ username: target });
        if (!user) return res.status(404).json({ authorized: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ authorized: false, error: 'Account banned.' });

        // Atomic check-and-deduct: exactly 1 credit in a single ledger op.
        // modifyCredits uses findOneAndUpdate with a credits >= 1 filter, so
        // concurrent requests cannot overdraw; it throws 'Insufficient credits'
        // when the balance is too low.
        try {
            const { user: updatedUser } = await modifyCredits({
                username: target,
                amount: -1,
                type: 'usage_deduct',
                description: 'Credit deducted for video_patch (authorize-patch)',
                adminUser: 'System'
            });
            // v91 (BugHunter backend F7): stats as best-effort atomic $inc,
            // never a whole-doc save after the money moved.
            try {
                await User.updateOne({ username: target }, { $inc: { 'stats.videosPatched': 1 } });
            } catch (_) { /* stats are non-critical */ }
            // v91 (BugHunter backend F6): mint the server-side authorization
            // record that requestRecipe must consume. Without it, any
            // authenticated user with 0 credits could mint recipes for free.
            // If the record cannot be created, REFUND the credit — the user
            // must never lose a credit for an authorization that never existed.
            const crypto = require('crypto');
            const PatchAuthorization = require('../models/PatchAuthorization');
            const authToken = crypto.randomBytes(24).toString('base64url');
            try {
                await PatchAuthorization.create({
                    token: authToken,
                    username: target,
                    method: '',
                    used: false,
                    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
                });
            } catch (authErr) {
                try {
                    await modifyCredits({
                        username: target,
                        amount: 1,
                        type: 'admin_grant',
                        description: 'Refund: patch authorization record could not be created',
                        adminUser: 'System'
                    });
                } catch (_) { /* refund is best-effort; the failure is logged below */ }
                console.error('[authorize-patch] auth record failed, credit refunded:', authErr.message);
                return res.status(500).json({ success: false, authorized: false, error: 'Authorization could not be recorded. Credit refunded — please try again.' });
            }
            return res.json({ success: true, authorized: true, authToken, credits: updatedUser.credits, creditsRemaining: updatedUser.credits, isPro: updatedUser.isPro });
        } catch (e) {
            if (e.message && e.message.includes('Insufficient credits')) {
                return res.status(402).json({ authorized: false, error: 'No credits remaining. Please upgrade or redeem voucher.' });
            }
            throw e;
        }
    } catch (e) {
        return res.status(500).json({ authorized: false, error: e.message });
    }
}

// Redeem Voucher Key
async function redeemKey(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline. Voucher redemption requires authoritative database connection.' });
    }

    const { key } = req.body;
    // SECURITY FIX: username from verified JWT only.
    const target = req.user?.username;
    if (!target) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!key) return res.status(400).json({ success: false, error: 'Username and Key required.' });

    const cleanKey = String(key).trim();
    try {
        // Atomic voucher claim to prevent race-condition double redemption
        const voucher = await RedeemKey.findOneAndUpdate(
            { key: cleanKey, isUsed: false },
            { $set: { isUsed: true, usedBy: target, usedAt: new Date() } },
            { new: true }
        );

        if (!voucher) {
            const exists = await RedeemKey.findOne({ key: cleanKey });
            if (!exists) return res.status(404).json({ success: false, error: 'Invalid license voucher.' });
            return res.status(400).json({ success: false, error: `Voucher already used by '${exists.usedBy}'.` });
        }

        const user = await User.findOne({ username: target });
        if (!user) {
            // v91 (BugHunter backend F9): the voucher is already claimed — if
            // the user row is gone, roll the claim back so the key stays usable.
            await RedeemKey.updateOne({ _id: voucher._id }, { $set: { isUsed: false, usedBy: '', usedAt: null } });
            return res.status(404).json({ success: false, error: 'User not found.' });
        }

        // v91 (BugHunter DB P0-1): voucher.plan speaks marketing vocabulary
        // ('PRO'/'VIP'/'LIFETIME') but User.proPlan is a strict enum — the
        // old raw assignment threw ValidationError on EVERY default redeem
        // (500, voucher burned, no credits). Map first, assign second.
        const { mapPlanToEnum } = require('../services/planService');
        const { computeSocialTag } = require('../services/socialTagService');
        const mappedPlan = mapPlanToEnum(voucher.plan);
        const newEarned = (Number(user.creditsEarned) || 0) + Number(voucher.credits || 0);

        // v91 (BugHunter backend F9 / DB P1-6): the grant is ONE atomic
        // update ($inc credits/earned + $set plan fields) — the old
        // read-modify-write save() could lose increments and failed AFTER
        // the irreversible claim. On grant failure the claim is rolled back.
        let updated;
        try {
            updated = await User.findOneAndUpdate(
                { username: target },
                {
                    $inc: { credits: Number(voucher.credits || 0), creditsEarned: Number(voucher.credits || 0) },
                    $set: {
                        isPro: voucher.isPro,
                        proPlan: mappedPlan,
                        tier: voucher.isPro ? 'VIP' : user.tier,
                        planExpiry: 'Lifetime',
                        tag: computeSocialTag(newEarned)
                    }
                },
                { new: true }
            );
        } catch (grantErr) {
            await RedeemKey.updateOne({ _id: voucher._id }, { $set: { isUsed: false, usedBy: '', usedAt: null } });
            throw grantErr;
        }
        if (!updated) {
            await RedeemKey.updateOne({ _id: voucher._id }, { $set: { isUsed: false, usedBy: '', usedAt: null } });
            return res.status(404).json({ success: false, error: 'User not found.' });
        }

        // Audit row is best-effort: the grant already landed; a ledger
        // failure must not 500 the redemption (BugHunter backend F7).
        try {
            await Transaction.create({
                username: updated.username,
                type: 'voucher_redeem',
                creditsChange: voucher.credits,
                newBalance: updated.credits,
                plan: mappedPlan,
                planExpiry: updated.planExpiry,
                description: `Redeemed VIP Voucher: ${cleanKey}`,
                adminUser: 'Voucher Engine'
            });
        } catch (e) {
            console.error('[redeem] audit row failed after grant:', e.message);
        }

        return res.json({
            success: true,
            message: `Success! Granted ${voucher.credits} credits & ${mappedPlan} VIP Plan.`,
            credits: updated.credits,
            isPro: updated.isPro,
            plan: updated.proPlan
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Submit Payment Proof
// BH-6 FIX: granted credits come from a SERVER-SIDE plan table — the old
// `Number(amount) >= 1000 ? 9999999 : 500` let the client mint 9,999,999
// credits by sending amount=1000.
const PLAN_CREDITS = { PRO: 500, VIP: 5000, LIFETIME: 9999999 };
async function submitPaymentProof(req, res) {
    await connectToDatabase();
    // v91 (BugHunter backend F22): the 503 guard its siblings have.
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, error: 'Database offline.' });
    }
    const { method, transactionId, amount, requestedPlan, screenshotUrl } = req.body;
    // SECURITY FIX: username from verified JWT only.
    const target = req.user?.username;
    if (!target) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!transactionId) {
        return res.status(400).json({ success: false, error: 'Username and Transaction ID are required.' });
    }
    // v91 (BugHunter DB P1-14): method is an enum — 'JazzCash'/'card' used to
    // 500 on Mongoose validation. Normalise + validate up front (400, not 500).
    const cleanMethod = String(method || 'jazzcash').trim().toLowerCase();
    if (!['jazzcash', 'easypaisa', 'bank'].includes(cleanMethod)) {
        return res.status(400).json({ success: false, error: 'Payment method must be jazzcash, easypaisa or bank.' });
    }
    // v91 (BugHunter backend F22): screenshotUrl was uncapped.
    const cleanScreenshot = String(screenshotUrl || '').slice(0, 2048);

    try {
        // BH-5 FIX: reject replayed transaction IDs (same TxID submitted twice).
        const txid = String(transactionId).trim();
        const dup = await PaymentProof.findOne({ transactionId: txid });
        if (dup) {
            return res.status(409).json({
                success: false,
                error: 'This transaction ID was already submitted.',
                status: dup.status
            });
        }
        const plan = String(requestedPlan || 'PRO').toUpperCase();
        let proof;
        try {
            proof = await PaymentProof.create({
                username: target.trim(),
                method: cleanMethod,
                transactionId: txid,
                amount: Number(amount) || 500,
                requestedPlan: plan,
                requestedCredits: PLAN_CREDITS[plan] || PLAN_CREDITS.PRO,
                screenshotUrl: cleanScreenshot,
                status: 'pending'
            });
        } catch (createErr) {
            // v91 (BugHunter DB P1-8): the pre-check + create race — a
            // concurrent duplicate hits the unique index as E11000. That is
            // a 409 (already submitted), never a 500.
            if (createErr && createErr.code === 11000) {
                return res.status(409).json({ success: false, error: 'This transaction ID was already submitted.' });
            }
            throw createErr;
        }

        await SupportMessage.create({
            sender: '👑 Owner Desk',
            message: `Assalam-o-Alaikum! Your payment proof (TxID: ${transactionId}) has been submitted to Owner Desk. Once verified, your VIP credits will be activated instantly.`,
            isAdmin: true
        });

        return res.json({
            success: true,
            message: 'Payment proof submitted to Admin for approval.',
            proofId: proof._id
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    getCredits,
    deductCredit,
    authorizePatch,
    redeemKey,
    submitPaymentProof
};
