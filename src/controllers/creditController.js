const User = require('../models/User');
const { serverError } = require('../utils/serverError');
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

        // P-1b (D-12c, HOLD MODEL): credits currently reserved by live
        // (unused + unexpired) patch authorizations, and what is left to
        // authorize with. Additive fields — the balance itself is unchanged
        // by a hold; only confirm / recipe-issue deducts.
        const held = await countLiveHolds(username);
        return res.json({
            success: true,
            credits: user.credits,
            creditsHeld: held,
            creditsAvailable: Math.max(0, (Number(user.credits) || 0) - held),
            tier: user.tier,
            isPro: user.isPro,
            plan: user.proPlan,
            planExpiry: user.planExpiry
        });
    } catch (e) {
        return serverError(res, e);
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
        return serverError(res, e);
    }
}

// P-1b (D-12c, HOLD MODEL) — what a "hold" is, and why this shape:
// A hold IS a live PatchAuthorization row (used:false, expiresAt > now).
// No creditsHeld counter is stored on the User: available = credits -
// count(live rows), computed on demand. That makes expiry release
// automatic — the row's 10-min TTL deletes it at expiry (and even before
// the TTL fires, the expiresAt guard excludes it from the count), so a
// hold can never be stranded by a crashed request or a missed sweep.
// Race safety: only authorize mints rows. The count -> mint sequence is
// serialized by optimistic concurrency on User.holdSeq: an atomic
// findOneAndUpdate guarded on the observed seq bumps it; the loser
// retries (bounded) and re-counts. Two concurrent authorizes for the
// last credit cannot both succeed — the loser re-counts the winner's
// row and gets 402. The commit step (confirm-patch, and requestRecipe
// for the Android flow) deducts via the same atomic used:false->true
// flip, so a hold converts to exactly one deduction.
const HOLD_TTL_MS = 10 * 60 * 1000;
const HOLD_MAX_ATTEMPTS = 5;

async function countLiveHolds(username) {
    const PatchAuthorization = require('../models/PatchAuthorization');
    return PatchAuthorization.countDocuments({ username, used: false, expiresAt: { $gt: new Date() } });
}

// Authorize + HOLD (P-1b, D-12c) — reserves 1 credit, deducts NOTHING.
// The client must never deduct on its own: only a 2xx {authorized:true}
// response means a credit is held server-side. The deduct happens at
// the commit step (confirm-patch, or requestRecipe for Android) — a
// failed / abandoned / expired patch costs nothing: expiry deletes the
// row (TTL) and the hold releases itself; release-patch frees it early.
// 402 when the AVAILABLE balance (credits minus live holds) is < 1, so
// one credit can never be held twice.
async function authorizePatch(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ authorized: false, error: 'Database offline. Authorization requires authoritative database connection.' });
    }
    // Username comes from the verified JWT (route uses authenticateUser) —
    // never from the body — so an attacker cannot hold a victim's credits.
    const target = req.user?.username;
    if (!target) return res.status(401).json({ authorized: false, error: 'Authentication required.' });

    try {
        const PatchAuthorization = require('../models/PatchAuthorization');
        const crypto = require('crypto');
        // Optimistic-concurrency loop: read balance + live holds, then
        // claim the sequence. A concurrent authorize that minted first
        // bumped holdSeq, so our guarded bump misses and we retry with a
        // fresh count (which now includes the winner's hold).
        for (let attempt = 0; attempt < HOLD_MAX_ATTEMPTS; attempt++) {
            const user = await User.findOne({ username: target });
            if (!user) return res.status(404).json({ authorized: false, error: 'User not found.' });
            if (user.status === 'banned') return res.status(403).json({ authorized: false, error: 'Account banned.' });

            const held = await countLiveHolds(target);
            const available = (Number(user.credits) || 0) - held;
            if (available < 1) {
                return res.status(402).json({ authorized: false, error: 'No credits remaining. Please upgrade or redeem voucher.' });
            }

            const locked = await User.findOneAndUpdate(
                { username: target, holdSeq: user.holdSeq || 0 },
                { $inc: { holdSeq: 1 } },
                { new: true }
            );
            if (!locked) continue; // lost the race — re-read and re-count

            // We own the sequence: mint the 10-minute authorization row.
            // No credit moves here — the hold IS this row. A mint failure
            // costs the user nothing (the seq bump only serializes
            // authorize attempts); report 500 and let the client retry.
            const authToken = crypto.randomBytes(24).toString('base64url');
            try {
                await PatchAuthorization.create({
                    token: authToken,
                    username: target,
                    method: '',
                    used: false,
                    expiresAt: new Date(Date.now() + HOLD_TTL_MS)
                });
            } catch (authErr) {
                console.error('[authorize-patch] auth record failed, no credit moved:', authErr.message);
                return res.status(500).json({ success: false, authorized: false, error: 'Authorization could not be recorded. No credit was held — please try again.' });
            }
            return res.json({
                success: true,
                authorized: true,
                authToken,
                credits: user.credits,
                creditsRemaining: user.credits,
                creditsHeld: held + 1,
                creditsAvailable: available - 1,
                isPro: user.isPro
            });
        }
        // Every attempt lost the sequence race (sustained contention) —
        // fail closed without minting anything; the client retries.
        return res.status(503).json({ success: false, authorized: false, error: 'Authorization is busy. Please try again.' });
    } catch (e) {
        return serverError(res, e, 500, 'Something went wrong. Please try again.', { authorized: false });
    }
}

// P-1b (D-12c, HOLD MODEL — server confirm is now the COMMIT step):
// confirm a patch authorization minted by authorize-patch. The atomic
// used:false->true flip is the single-winner lock (shared with
// requestRecipe, the Android commit point): the winner deducts exactly
// 1 credit via modifyCredits; a repeat confirm returns 200
// alreadyConfirmed and deducts nothing. If the deduct cannot happen
// (e.g. the held credit was spent elsewhere via /api/deduct while the
// hold was live), the flip is ROLLED BACK and the call fails 402 — the
// token stays live and usable, and no credit is taken for an
// unconfirmed patch. Idempotent by construction: a client retry after a
// dropped response can never double-deduct. NOTE on 404 vs 410: rows
// whose TTL already fired are DELETED by Mongo, so a long-expired token
// presents as 404, not 410; 410 only fires while the row still exists
// with a past expiresAt.
async function confirmPatch(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, confirmed: false, error: 'Database offline. Confirmation requires authoritative database connection.' });
    }
    // Username comes from the verified JWT (route uses authenticateUser) —
    // never from the body — so one user cannot confirm another user's
    // authorization.
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, confirmed: false, error: 'Authentication required.' });

    const authToken = typeof req.body?.authToken === 'string' ? req.body.authToken.trim() : '';
    if (!authToken) return res.status(400).json({ success: false, confirmed: false, error: 'authToken is required.' });

    try {
        const PatchAuthorization = require('../models/PatchAuthorization');
        // Atomic flip: only a live (unused + unexpired) row flips, guarded
        // on used:false + expiresAt > now in ONE update — two concurrent
        // confirms cannot both win. The loser falls through to the read
        // below and gets alreadyConfirmed.
        const flipped = await PatchAuthorization.findOneAndUpdate(
            { token: authToken, username, used: false, expiresAt: { $gt: new Date() } },
            { $set: { used: true } },
            { new: true }
        );
        if (flipped) {
            // Commit: deduct 1 against the live hold. modifyCredits is
            // itself atomic (credits >= 1 filter) and writes the ledger
            // row, so the deduction is exactly-once per flipped token.
            try {
                const { user: updatedUser } = await modifyCredits({
                    username,
                    amount: -1,
                    type: 'usage_deduct',
                    description: 'Credit deducted for video_patch (confirm-patch commit)',
                    adminUser: 'System'
                });
                // v91 (BugHunter backend F7): stats as best-effort atomic
                // $inc, never a whole-doc save after the money moved. The
                // patch count lands at COMMIT time now, not authorize.
                try {
                    await User.updateOne({ username }, { $inc: { 'stats.videosPatched': 1 } });
                } catch (_) { /* stats are non-critical */ }
                return res.json({ success: true, confirmed: true, credits: updatedUser.credits, creditsRemaining: updatedUser.credits });
            } catch (deductErr) {
                // Fail closed WITHOUT flipping used: roll the flip back so
                // the token stays live and the client can retry after a
                // top-up. The patch itself is not undone — only the
                // charge is withheld until a confirm can actually pay.
                try {
                    await PatchAuthorization.findOneAndUpdate(
                        { token: authToken, username, used: true },
                        { $set: { used: false } },
                        { new: true }
                    );
                } catch (rollbackErr) {
                    console.error('[confirm-patch] deduct failed AND flip rollback failed:', rollbackErr.message);
                }
                if (deductErr.message && deductErr.message.includes('Insufficient credits')) {
                    return res.status(402).json({ success: false, confirmed: false, error: 'No credits remaining. Please upgrade or redeem voucher.' });
                }
                throw deductErr;
            }
        }
        // Not flipped: distinguish the three states. A wrong-user token
        // reads as 404 (row lookup is scoped to the JWT username), so the
        // existence of another user's authorization is never revealed.
        const row = await PatchAuthorization.findOne({ token: authToken, username });
        if (!row) return res.status(404).json({ success: false, confirmed: false, error: 'Patch authorization not found.' });
        if (row.used) return res.json({ success: true, confirmed: true, alreadyConfirmed: true });
        if (row.expiresAt && new Date(row.expiresAt) <= new Date()) {
            return res.status(410).json({ success: false, confirmed: false, error: 'Patch authorization expired.' });
        }
        // Unreachable in practice (the flip guard covers every live state)
        // — fail closed rather than confirming silently.
        return res.status(500).json({ success: false, confirmed: false, error: 'Could not confirm patch authorization. Please try again.' });
    } catch (e) {
        return serverError(res, e, 500, 'Something went wrong. Please try again.', { success: false, confirmed: false });
    }
}

// P-1b (D-12c, HOLD MODEL) — POST /api/release-patch: release the hold
// for a live unused token (patch cancelled / abandoned by the client).
// The row is deleted atomically (guarded on used:false + unexpired), so
// the hold frees immediately and the credit is spendable again — no
// money moves, because nothing was deducted yet. Repeat release of the
// same token is 404 (the row is gone); a released token can never be
// confirmed afterwards (confirm reads 404 too). States mirror confirm:
// unknown/wrong-user -> 404, already-confirmed (used) -> 409 (the credit
// was deducted — release cannot refund it), expired row still present
// -> 410 (in production the TTL usually deletes it first -> 404).
async function releasePatch(req, res) {
    await connectToDatabase();
    if (!isDbConnected()) {
        return res.status(503).json({ success: false, released: false, error: 'Database offline. Release requires authoritative database connection.' });
    }
    // Username comes from the verified JWT — never from the body.
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, released: false, error: 'Authentication required.' });

    const authToken = typeof req.body?.authToken === 'string' ? req.body.authToken.trim() : '';
    if (!authToken) return res.status(400).json({ success: false, released: false, error: 'authToken is required.' });

    try {
        const PatchAuthorization = require('../models/PatchAuthorization');
        // Atomic delete: only a live (unused + unexpired) row is released.
        // A concurrent confirm that flipped first wins instead — the
        // delete then misses and the state read below reports 409.
        const released = await PatchAuthorization.findOneAndDelete(
            { token: authToken, username, used: false, expiresAt: { $gt: new Date() } }
        );
        if (released) {
            const user = await User.findOne({ username });
            return res.json({
                success: true,
                released: true,
                credits: user ? user.credits : undefined,
                creditsHeld: await countLiveHolds(username)
            });
        }
        const row = await PatchAuthorization.findOne({ token: authToken, username });
        if (!row) return res.status(404).json({ success: false, released: false, error: 'Patch authorization not found.' });
        if (row.used) return res.status(409).json({ success: false, released: false, error: 'Patch already confirmed — the credit was deducted and cannot be released.' });
        if (row.expiresAt && new Date(row.expiresAt) <= new Date()) {
            return res.status(410).json({ success: false, released: false, error: 'Patch authorization expired — the hold already released.' });
        }
        return res.status(500).json({ success: false, released: false, error: 'Could not release patch authorization. Please try again.' });
    } catch (e) {
        return serverError(res, e, 500, 'Something went wrong. Please try again.', { success: false, released: false });
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
        return serverError(res, e);
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
        return serverError(res, e);
    }
}

module.exports = {
    getCredits,
    deductCredit,
    authorizePatch,
    confirmPatch,
    releasePatch,
    redeemKey,
    submitPaymentProof
};
