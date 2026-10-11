const User = require('../models/User');
const RedeemKey = require('../models/RedeemKey');
const PaymentProof = require('../models/PaymentProof');
const SupportMessage = require('../models/SupportMessage');
const Transaction = require('../models/Transaction');
const { modifyCredits } = require('../services/ledgerService');
const { connectToDatabase, isDbConnected } = require('../config/db');

// Get Credits
async function getCredits(req, res) {
    await connectToDatabase();
    const username = req.query.username || req.user?.username;
    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });

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

    const { username, amount, reason } = req.body;
    const targetUser = username || req.user?.username;
    if (!targetUser) return res.status(400).json({ success: false, error: 'Username required.' });

    const decAmt = Number(amount) || 1;

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

// Authorize Pre-Patch Check
async function authorizePatch(req, res) {
    await connectToDatabase();
    const { username } = req.body;
    const target = username || req.user?.username;
    if (!target) return res.status(400).json({ authorized: false, error: 'Username required.' });

    try {
        const user = await User.findOne({ username: target });
        if (!user) return res.status(404).json({ authorized: false, error: 'User not found.' });
        if (user.status === 'banned') return res.status(403).json({ authorized: false, error: 'Account banned.' });

        if (user.isPro || user.credits > 0) {
            return res.json({ authorized: true, creditsRemaining: user.credits, isPro: user.isPro });
        }
        return res.status(402).json({ authorized: false, error: 'No credits remaining.' });
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

    const { username, key } = req.body;
    const target = username || req.user?.username;
    if (!target || !key) return res.status(400).json({ success: false, error: 'Username and Key required.' });

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
async function submitPaymentProof(req, res) {
    await connectToDatabase();
    const { username, method, transactionId, amount, requestedPlan, screenshotUrl } = req.body;
    const target = username || req.user?.username;
    if (!target || !transactionId) {
        return res.status(400).json({ success: false, error: 'Username and Transaction ID are required.' });
    }

    try {
        const proof = await PaymentProof.create({
            username: target.trim(),
            method: method || 'jazzcash',
            transactionId: String(transactionId).trim(),
            amount: Number(amount) || 500,
            requestedPlan: requestedPlan || 'PRO',
            requestedCredits: Number(amount) >= 1000 ? 9999999 : 500,
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
