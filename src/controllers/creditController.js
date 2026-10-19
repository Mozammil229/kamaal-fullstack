const User = require('../models/User');
const RedeemKey = require('../models/RedeemKey');
const PaymentProof = require('../models/PaymentProof');
const SupportMessage = require('../models/SupportMessage');
const Transaction = require('../models/Transaction');
const { modifyCredits } = require('../services/ledgerService');
const { bumpEarnedAndRetag } = require('../services/socialTagService');
const { connectToDatabase, isDbConnected } = require('../config/db');

// Get Credits (JWT-authenticated; username from verified token only)
async function getCredits(req, res) {
    await connectToDatabase();
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

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

    try {
        const user = await User.findOne({ username: targetUser });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        // Pro users have unlimited access, don't deduct balance
        if (user.isPro) {
            if (reason?.includes('4K')) user.stats.videosEnhanced4K += 1;
            else user.stats.videosPatched += 1;
            await user.save();
            return res.json({ success: true, remaining: user.credits, isPro: true });
        }

        // Deduct using atomic ledger service
        const { user: updatedUser } = await modifyCredits({
            username: targetUser,
            amount: -decAmt,
            type: 'usage_deduct',
            description: `Credit deducted for ${reason || 'video patch'}`,
            adminUser: 'System'
        });

        if (reason?.includes('4K')) updatedUser.stats.videosEnhanced4K += 1;
        else updatedUser.stats.videosPatched += 1;
        await updatedUser.save();

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

        // Pro users: unlimited access, authorize without deducting.
        if (user.isPro) {
            user.stats.videosPatched += 1;
            await user.save();
            return res.json({ authorized: true, credits: user.credits, creditsRemaining: user.credits, isPro: true });
        }

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
            updatedUser.stats.videosPatched += 1;
            await updatedUser.save();
            return res.json({ authorized: true, credits: updatedUser.credits, creditsRemaining: updatedUser.credits, isPro: false });
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
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        user.credits += voucher.credits;
        // PHASE E: lifetime-earned grows the TAG badge.
        bumpEarnedAndRetag(user, voucher.credits);
        user.isPro = voucher.isPro;
        user.proPlan = voucher.plan;
        user.tier = voucher.isPro ? 'VIP' : user.tier;
        user.planExpiry = 'Lifetime';
        await user.save();

        await Transaction.create({
            username: user.username,
            type: 'voucher_redeem',
            creditsChange: voucher.credits,
            newBalance: user.credits,
            plan: voucher.plan,
            planExpiry: user.planExpiry,
            description: `Redeemed VIP Voucher: ${cleanKey}`,
            adminUser: 'Voucher Engine'
        });

        return res.json({
            success: true,
            message: `Success! Granted ${voucher.credits} credits & ${voucher.plan} VIP Plan.`,
            credits: user.credits,
            isPro: user.isPro,
            plan: user.proPlan
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
    const { method, transactionId, amount, requestedPlan, screenshotUrl } = req.body;
    // SECURITY FIX: username from verified JWT only.
    const target = req.user?.username;
    if (!target) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!transactionId) {
        return res.status(400).json({ success: false, error: 'Username and Transaction ID are required.' });
    }

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
        const proof = await PaymentProof.create({
            username: target.trim(),
            method: method || 'jazzcash',
            transactionId: txid,
            amount: Number(amount) || 500,
            requestedPlan: plan,
            requestedCredits: PLAN_CREDITS[plan] || PLAN_CREDITS.PRO,
            screenshotUrl: screenshotUrl || '',
            status: 'pending'
        });

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
