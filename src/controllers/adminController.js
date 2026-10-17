const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const User = require('../models/User');
const PaymentProof = require('../models/PaymentProof');
const RedeemKey = require('../models/RedeemKey');
const Transaction = require('../models/Transaction');
const ChatMessage = require('../models/ChatMessage');
const SupportMessage = require('../models/SupportMessage');
const AppConfig = require('../models/AppConfig');
const { revokeToken } = require('../middleware/auth');
const { connectToDatabase, isDbConnected } = require('../config/db');

// Admin Login
function adminLogin(req, res) {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password required.' });
    }

    if (username === env.ADMIN_USER && password === env.ADMIN_PASS) {
        const expiresAt = Date.now() + env.ADMIN_TOKEN_TTL_MS;
        const sessionToken = jwt.sign(
            {
                sub: env.ADMIN_USER,
                role: 'admin',
                iss: 'kammal-auth',
                jti: crypto.randomBytes(16).toString('hex')
            },
            env.ADMIN_JWT_SECRET,
            { expiresIn: '24h' }
        );

        return res.json({
            success: true,
            token: sessionToken,
            expiresAt,
            admin: { username: env.ADMIN_USER, role: 'Owner' }
        });
    }
    return res.status(401).json({ success: false, error: 'Invalid Admin Username or Password.' });
}

// Admin Logout
async function adminLogout(req, res) {
    const rawToken = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (rawToken && typeof rawToken === 'string') {
        await revokeToken(rawToken.trim(), 'admin_logout');
    }
    return res.json({ success: true, message: 'Logged out.' });
}

// Telemetry Radar
async function getTelemetry(req, res) {
    await connectToDatabase();
    try {
        const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
        let totalUsers = 0, activeUsers = 0, vipUsers = 0, pendingPayments = 0, totalPatches = 0, total4KEnhances = 0;

        if (isDbConnected()) {
            totalUsers = await User.countDocuments();
            activeUsers = await User.countDocuments({ lastActiveAt: { $gte: fifteenMinsAgo } });
            vipUsers = await User.countDocuments({ isPro: true });
            pendingPayments = await PaymentProof.countDocuments({ status: 'pending' });

            const statsAgg = await User.aggregate([
                { $group: { _id: null, patches: { $sum: '$stats.videosPatched' }, enhances: { $sum: '$stats.videosEnhanced4K' } } }
            ]);
            if (statsAgg.length > 0) {
                totalPatches = statsAgg[0].patches || 0;
                total4KEnhances = statsAgg[0].enhances || 0;
            }
        }

        return res.json({
            success: true,
            telemetry: {
                radarActiveUsers: activeUsers,
                totalUsers,
                vipUsers,
                pendingPayments,
                totalPatches,
                total4KEnhances,
                dbStatus: isDbConnected() ? 'ONLINE (Atlas)' : 'STANDBY',
                serverTime: Date.now()
            }
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Get All Users
async function getUsers(req, res) {
    await connectToDatabase();
    const { search, limit } = req.query;
    try {
        const query = search ? {
            $or: [
                { username: new RegExp(search, 'i') },
                { email: new RegExp(search, 'i') },
                { phone: new RegExp(search, 'i') }
            ]
        } : {};

        const users = await User.find(query)
            .sort({ createdAt: -1 })
            .limit(Math.min(200, Number(limit) || 100))
            .select('-token -__v')
            .lean();

        return res.json({ success: true, count: users.length, users });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Update User (Credits, Pro, Expiry, Ban, Device Unlock)
async function updateUser(req, res) {
    await connectToDatabase();
    const {
        username,
        credits,
        creditAction, // 'set', 'add', 'deduct'
        isPro,
        proPlan,
        planExpiry,
        planExpiryDate,
        status,
        banReason,
        customPrompt,
        resetDevice,
        adminNote
    } = req.body;

    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        const oldCredits = user.credits || 0;
        let creditsDelta = 0;

        if (credits !== undefined) {
            const num = Number(credits);
            if (creditAction === 'add') {
                user.credits = Math.max(0, oldCredits + num);
                creditsDelta = num;
            } else if (creditAction === 'deduct') {
                user.credits = Math.max(0, oldCredits - num);
                creditsDelta = -num;
            } else {
                user.credits = Math.max(0, num);
                creditsDelta = num - oldCredits;
            }
        }

        if (isPro !== undefined) user.isPro = Boolean(isPro);
        if (proPlan !== undefined) user.proPlan = proPlan;
        if (planExpiry !== undefined) user.planExpiry = planExpiry;
        if (planExpiryDate !== undefined) user.planExpiryDate = planExpiryDate ? new Date(planExpiryDate) : null;
        if (status !== undefined) user.status = status;
        if (banReason !== undefined) user.banReason = banReason;
        if (customPrompt !== undefined) user.customPrompt = customPrompt;
        if (resetDevice === true) user.deviceId = '';

        await user.save();

        if (creditsDelta !== 0) {
            await Transaction.create({
                username: user.username,
                type: creditsDelta > 0 ? 'admin_grant' : 'admin_deduct',
                creditsChange: creditsDelta,
                newBalance: user.credits,
                plan: user.proPlan,
                planExpiry: user.planExpiry,
                description: adminNote || `Admin credit update (${creditsDelta > 0 ? '+' : ''}${creditsDelta})`,
                adminUser: req.adminUser || '👑 Master Admin'
            });
        }

        return res.json({ success: true, message: `Updated user '${username}' successfully.`, user });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Get Transactions Audit Log
async function getTransactions(req, res) {
    await connectToDatabase();
    const { username, limit } = req.query;
    try {
        const query = username ? { username } : {};
        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .limit(Math.min(200, Number(limit) || 50))
            .lean();
        return res.json({ success: true, transactions });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Global Announcement Broadcast
async function broadcast(req, res) {
    await connectToDatabase();
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Message text required.' });

    const cleanText = String(text).trim();
    try {
        const bcast = await ChatMessage.create({
            channel: 'global',
            sender: '👑 Owner',
            recipient: 'global',
            text: cleanText,
            isOwner: true,
            pinned: true,
            timestamp: Date.now()
        });

        await SupportMessage.create({
            sender: '👑 Admin Official',
            message: cleanText,
            isAdmin: true,
            timestamp: Date.now()
        });

        let conf = await AppConfig.findOne({ key: 'global_config' });
        if (conf) {
            if (!conf.whiteLabel) conf.whiteLabel = {};
            conf.whiteLabel.announcementBanner = cleanText;
            await conf.save();
        }

        return res.json({ success: true, message: 'Broadcast sent globally to all users.', broadcast: bcast });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Send Direct Alert Message
async function sendDirectMessage(req, res) {
    await connectToDatabase();
    const { recipient, text } = req.body;
    if (!recipient || !text) return res.status(400).json({ success: false, error: 'Recipient and text required.' });

    const cleanRecipient = recipient.trim();
    const cleanText = String(text).trim();

    try {
        await ChatMessage.create({
            channel: '@' + cleanRecipient,
            sender: '👑 Owner',
            recipient: cleanRecipient,
            text: cleanText,
            isOwner: true,
            timestamp: Date.now()
        });

        await SupportMessage.create({
            sender: '👑 Owner Desk',
            deviceId: cleanRecipient,
            message: cleanText,
            isAdmin: true,
            timestamp: Date.now()
        });

        return res.json({ success: true, message: `Direct notification sent to @${cleanRecipient}.` });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Review Payment Proof (Approve / Reject)
async function reviewPayment(req, res) {
    await connectToDatabase();
    const { proofId, approve, creditsToAdd, setPlan } = req.body;
    if (!proofId) return res.status(400).json({ success: false, error: 'Proof ID required.' });

    try {
        const proof = await PaymentProof.findById(proofId);
        if (!proof) return res.status(404).json({ success: false, error: 'Payment proof not found.' });

        if (proof.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: `Payment proof has already been ${proof.status}. Duplicate processing rejected.`,
                currentStatus: proof.status
            });
        }

        if (approve) {
            proof.status = 'approved';
            const grantedCredits = Number(creditsToAdd) || proof.requestedCredits || 1000;
            const grantedPlan = setPlan || proof.requestedPlan || 'PRO';

            const user = await User.findOne({ username: proof.username });
            if (user) {
                user.credits += grantedCredits;
                user.isPro = true;
                user.proPlan = grantedPlan;
                user.tier = 'VIP';
                user.planExpiry = 'Lifetime';
                await user.save();

                await Transaction.create({
                    username: user.username,
                    type: 'payment_approval',
                    creditsChange: grantedCredits,
                    newBalance: user.credits,
                    plan: grantedPlan,
                    planExpiry: user.planExpiry || 'Lifetime',
                    description: `Payment Proof Approved (${proof.method.toUpperCase()} - PKR ${proof.amount}, TxID: ${proof.transactionId})`,
                    adminUser: req.adminUser || '👑 Master Admin'
                });
            }

            await ChatMessage.create({
                channel: 'global',
                sender: '👑 Owner',
                recipient: proof.username,
                text: `🎉 Congratulations! Your payment of PKR ${proof.amount} has been APPROVED. ${grantedCredits} Credits & ${grantedPlan} Plan are active!`,
                isOwner: true,
                timestamp: Date.now()
            });
        } else {
            proof.status = 'rejected';
            proof.adminNote = req.body.adminNote || 'Payment rejected by administrator.';
        }

        await proof.save();
        return res.json({ success: true, message: `Payment ${proof.status}.` });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// List Payments
async function listPayments(req, res) {
    await connectToDatabase();
    try {
        const proofs = await PaymentProof.find().sort({ createdAt: -1 }).limit(100);
        return res.json({ success: true, proofs });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// List Vouchers
async function listKeys(req, res) {
    await connectToDatabase();
    try {
        const keys = await RedeemKey.find().sort({ createdAt: -1 }).limit(150).lean();
        return res.json({ success: true, keys });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Create Bulk Voucher Keys
async function createKeys(req, res) {
    await connectToDatabase();
    const { count, prefix, credits, plan, isPro } = req.body;
    const num = Math.min(100, Math.max(1, Number(count) || 1));
    const pre = prefix ? String(prefix).toUpperCase() : 'VIP';
    const keys = [];

    try {
        for (let i = 0; i < num; i++) {
            const randCode = crypto.randomBytes(3).toString('hex').toUpperCase();
            const keyStr = `${pre}-${randCode}-${Math.floor(1000 + Math.random() * 9000)}`;
            const newKey = await RedeemKey.create({
                key: keyStr,
                credits: Number(credits) || 500,
                plan: plan || 'PRO',
                isPro: isPro !== undefined ? Boolean(isPro) : true
            });
            keys.push(newKey.key);
        }
        return res.json({ success: true, count: keys.length, keys });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Remote App Governance Config Update
async function updateConfig(req, res) {
    await connectToDatabase();
    const {
        maintenance,
        minAppVersion,
        latestAppVersion,
        updateUrl,
        updateNotes,
        forceUpdate,
        featureFlags,
        whiteLabel,
        defaultSignupCredits,
        referralReward,
        systemPrompt,
        currentModel
    } = req.body;

    try {
        let conf = await AppConfig.findOne({ key: 'global_config' });
        if (!conf) conf = new AppConfig({ key: 'global_config' });

        if (maintenance) {
            conf.maintenance = {
                ...conf.maintenance,
                ...maintenance,
                countdownEnd: maintenance.countdownEnd ? new Date(maintenance.countdownEnd) : conf.maintenance.countdownEnd
            };
        }
        if (minAppVersion !== undefined) conf.minAppVersion = String(minAppVersion).trim();
        if (latestAppVersion !== undefined) conf.latestAppVersion = String(latestAppVersion).trim();
        if (updateUrl !== undefined) conf.updateUrl = String(updateUrl).trim();
        if (updateNotes !== undefined) conf.updateNotes = String(updateNotes).trim();
        if (forceUpdate !== undefined) conf.forceUpdate = Boolean(forceUpdate);
        if (featureFlags !== undefined) conf.featureFlags = { ...conf.featureFlags, ...featureFlags };
        if (whiteLabel !== undefined) conf.whiteLabel = { ...conf.whiteLabel, ...whiteLabel };
        if (defaultSignupCredits !== undefined) conf.defaultSignupCredits = Number(defaultSignupCredits);
        if (referralReward !== undefined) conf.referralReward = Number(referralReward);
        if (systemPrompt !== undefined) conf.systemPrompt = systemPrompt;
        if (currentModel !== undefined) conf.currentModel = currentModel;

        await conf.save();
        return res.json({ success: true, message: 'System Governance & Upgrade Configuration saved successfully.', config: conf });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    adminLogin,
    adminLogout,
    getTelemetry,
    getUsers,
    updateUser,
    getTransactions,
    broadcast,
    sendDirectMessage,
    reviewPayment,
    listPayments,
    listKeys,
    createKeys,
    updateConfig
};
