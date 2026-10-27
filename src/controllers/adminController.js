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
        // v91 (BugHunter backend F20): the raw admin search string was fed to
        // RegExp unescaped — a malformed pattern 500d, a crafted one could
        // ReDoS the query. Escape first (messageController already does this).
        const esc = search ? String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        const query = search ? {
            $or: [
                { username: new RegExp(esc, 'i') },
                { email: new RegExp(esc, 'i') },
                { phone: new RegExp(esc, 'i') }
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

// Update User (Credits, Pro, Expiry, Ban, Device Unlock, Beta Membership)
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
        adminNote,
        betaMember
    } = req.body;

    if (!username) return res.status(400).json({ success: false, error: 'Username required.' });

    // v91 (BugHunter DB P1-7 / backend F21): validate BEFORE touching the
    // document — a non-finite credits value used to flow into Math.max and
    // save NaN; a non-enum proPlan/status used to 500 the whole update.
    const { mapPlanToEnum, isValidProPlan } = require('../services/planService');
    let creditsNum = null;
    if (credits !== undefined) {
        creditsNum = Number(credits);
        if (!Number.isFinite(creditsNum)) {
            return res.status(400).json({ success: false, error: 'Credits must be a finite number.' });
        }
    }
    let mappedPlan = null;
    if (proPlan !== undefined) {
        // Accept the marketing vocabulary too (PRO/VIP/LIFETIME) — mapped,
        // never assigned raw (BugHunter DB P0-1/P0-2).
        mappedPlan = mapPlanToEnum(proPlan);
        if (!isValidProPlan(mappedPlan)) {
            return res.status(400).json({ success: false, error: 'Invalid proPlan value.' });
        }
    }
    if (status !== undefined && !['active', 'banned'].includes(String(status))) {
        return res.status(400).json({ success: false, error: 'Status must be active or banned.' });
    }
    let expiryDate = undefined;
    if (planExpiryDate !== undefined) {
        if (planExpiryDate) {
            const d = new Date(planExpiryDate);
            if (isNaN(d.getTime())) {
                return res.status(400).json({ success: false, error: 'Invalid planExpiryDate.' });
            }
            expiryDate = d;
        } else {
            expiryDate = null;
        }
    }
    if (customPrompt !== undefined && typeof customPrompt === 'string' && customPrompt.length > 4000) {
        return res.status(400).json({ success: false, error: 'Custom prompt is too long (max 4000 chars).' });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });

        const oldCredits = user.credits || 0;
        let creditsDelta = 0;
        // v91: credits move atomically — add/deduct via a clamped pipeline
        // update (never below 0), 'set' via $set. No whole-doc save, so a
        // legacy out-of-enum document cannot 500 the update (DB P1-13).
        const set = {};
        let pipeline = null;
        if (creditsNum !== null) {
            if (creditAction === 'add') {
                pipeline = [{ $set: { credits: { $add: ['$credits', creditsNum] } } }];
                creditsDelta = creditsNum;
            } else if (creditAction === 'deduct') {
                pipeline = [{ $set: { credits: { $max: [0, { $subtract: ['$credits', creditsNum] }] } } }];
                creditsDelta = -creditsNum;
            } else {
                set.credits = Math.max(0, creditsNum);
                creditsDelta = creditsNum - oldCredits;
            }
        }

        if (isPro !== undefined) set.isPro = Boolean(isPro);
        if (mappedPlan !== null) set.proPlan = mappedPlan;
        if (planExpiry !== undefined) set.planExpiry = planExpiry;
        if (expiryDate !== undefined) set.planExpiryDate = expiryDate;
        if (status !== undefined) set.status = status;
        if (banReason !== undefined) set.banReason = banReason;
        if (customPrompt !== undefined) set.customPrompt = customPrompt;
        if (betaMember !== undefined) set.betaMember = Boolean(betaMember);
        if (resetDevice === true) set.deviceId = '';
        // PHASE E: only positive grants grow lifetime-earned (deducts/sets-down do not).
        if (creditsDelta > 0) {
            const { computeSocialTag } = require('../services/socialTagService');
            set.creditsEarned = (Number(user.creditsEarned) || 0) + creditsDelta;
            set.tag = computeSocialTag(set.creditsEarned);
        }

        const updated = pipeline
            ? await User.findOneAndUpdate({ _id: user._id }, pipeline, { new: true })
            : (Object.keys(set).length > 0
                ? await User.findOneAndUpdate({ _id: user._id }, { $set: set }, { new: true })
                : user);
        // Pipeline path still needs the $set fields applied.
        let finalUser = updated;
        if (pipeline && Object.keys(set).length > 0) {
            finalUser = await User.findOneAndUpdate({ _id: user._id }, { $set: set }, { new: true });
        }
        if (!finalUser) return res.status(404).json({ success: false, error: 'User not found.' });

        if (creditsDelta !== 0) {
            // Audit row is best-effort (BugHunter backend F7).
            try {
                await Transaction.create({
                    username: finalUser.username,
                    type: creditsDelta > 0 ? 'admin_grant' : 'admin_deduct',
                    creditsChange: creditsDelta,
                    newBalance: finalUser.credits,
                    plan: finalUser.proPlan,
                    planExpiry: finalUser.planExpiry,
                    description: adminNote || `Admin credit update (${creditsDelta > 0 ? '+' : ''}${creditsDelta})`,
                    adminUser: req.adminUser || '👑 Master Admin'
                });
            } catch (e) {
                console.error('[admin updateUser] audit row failed after grant:', e.message);
            }
        }

        return res.json({ success: true, message: `Updated user '${username}' successfully.`, user: finalUser });
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
            // v91 (BugHunter backend F5): broadcasts are global by design —
            // flagged so getSupportMessages can show them without the bare
            // `isAdmin: true` clause that leaked every admin DM to everyone.
            broadcast: true,
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
            // v91 (BugHunter backend F5): the recipient USERNAME belongs in
            // recipientUsername — the old code misused deviceId for it, which
            // made the message matchable by anyone passing ?deviceId=.
            recipientUsername: cleanRecipient,
            deviceId: '',
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
            // BH-6 FIX: creditsToAdd is REQUIRED and explicit — the old
            // fallback `|| proof.requestedCredits` granted client-influenced
            // amounts when the admin omitted the field.
            const grantedCredits = Number(creditsToAdd);
            if (!Number.isFinite(grantedCredits) || grantedCredits <= 0) {
                return res.status(400).json({ success: false, error: 'creditsToAdd (positive number) is required to approve.' });
            }
            // v91 (BugHunter DB P0-2): the plan vocabulary ('PRO'/'VIP'/
            // 'LIFETIME') was assigned raw to the strict proPlan enum — the
            // save threw ValidationError on EVERY default approval (500, proof
            // stuck pending). Map first, assign second.
            const { mapPlanToEnum } = require('../services/planService');
            const grantedPlan = mapPlanToEnum(setPlan || proof.requestedPlan || 'PRO');

            // v91 (BugHunter backend F8 / DB P1-4): CLAIM the proof atomically
            // FIRST (status:'pending' guard) — two concurrent approves used
            // to both pass the check and both grant. If the claim loses the
            // race, another admin already processed it.
            const claimed = await PaymentProof.findOneAndUpdate(
                { _id: proof._id, status: 'pending' },
                { $set: { status: 'approved' } },
                { new: true }
            );
            if (!claimed) {
                return res.status(400).json({ success: false, error: 'Payment proof was already processed.' });
            }

            const user = await User.findOne({ username: proof.username });
            if (user) {
                // v91: ONE atomic grant ($inc credits/earned + $set plan).
                const { computeSocialTag } = require('../services/socialTagService');
                const newEarned = (Number(user.creditsEarned) || 0) + grantedCredits;
                const updatedUser = await User.findOneAndUpdate(
                    { _id: user._id },
                    {
                        $inc: { credits: grantedCredits, creditsEarned: grantedCredits },
                        $set: {
                            isPro: true,
                            proPlan: grantedPlan,
                            tier: 'VIP',
                            planExpiry: 'Lifetime',
                            tag: computeSocialTag(newEarned)
                        }
                    },
                    { new: true }
                );

                // Audit + notification rows are best-effort: the grant already
                // landed; a failure here must not 500 the approval (F7).
                try {
                    await Transaction.create({
                        username: user.username,
                        type: 'payment_approval',
                        creditsChange: grantedCredits,
                        newBalance: updatedUser ? updatedUser.credits : user.credits + grantedCredits,
                        plan: grantedPlan,
                        planExpiry: 'Lifetime',
                        description: `Payment Proof Approved (${proof.method.toUpperCase()} - PKR ${proof.amount}, TxID: ${proof.transactionId})`,
                        adminUser: req.adminUser || '👑 Master Admin'
                    });
                } catch (e) {
                    console.error('[reviewPayment] audit row failed after grant:', e.message);
                }
                try {
                    await ChatMessage.create({
                        channel: 'global',
                        sender: '👑 Owner',
                        recipient: proof.username,
                        text: `🎉 Congratulations! Your payment of PKR ${proof.amount} has been APPROVED. ${grantedCredits} Credits & ${grantedPlan} Plan are active!`,
                        isOwner: true,
                        timestamp: Date.now()
                    });
                } catch (e) {
                    console.error('[reviewPayment] notify message failed:', e.message);
                }
            }

            return res.json({ success: true, message: 'Payment approved.' });
        } else {
            // Reject path: claim atomically too (same double-processing guard).
            const claimed = await PaymentProof.findOneAndUpdate(
                { _id: proof._id, status: 'pending' },
                { $set: { status: 'rejected', adminNote: req.body.adminNote || 'Payment rejected by administrator.' } },
                { new: true }
            );
            if (!claimed) {
                return res.status(400).json({ success: false, error: 'Payment proof was already processed.' });
            }
            return res.json({ success: true, message: 'Payment rejected.' });
        }
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
    let failed = 0;

    // v91 (BugHunter backend F25): the old loop aborted mid-batch on the
    // first duplicate-key E11000 with a 500 and no record of what was
    // created. Each key now retries with a fresh code; failures are counted.
    for (let i = 0; i < num; i++) {
        let created = null;
        for (let attempt = 0; attempt < 3 && !created; attempt++) {
            const randCode = crypto.randomBytes(3).toString('hex').toUpperCase();
            const keyStr = `${pre}-${randCode}-${Math.floor(1000 + Math.random() * 9000)}`;
            try {
                created = await RedeemKey.create({
                    key: keyStr,
                    credits: Number(credits) || 500,
                    plan: plan || 'PRO',
                    isPro: isPro !== undefined ? Boolean(isPro) : true
                });
            } catch (e) {
                if (e && e.code === 11000) continue; // collision — fresh code
                throw e;
            }
        }
        if (created) keys.push(created.key);
        else failed += 1;
    }
    return res.json({ success: true, count: keys.length, failed, keys });
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
        currentModel,
        liveInstructions,
        onlineTool
    } = req.body;

    // v91 (BugHunter backend F21): reject non-finite numbers up front —
    // Number(NaN) used to flow into the doc and 500 on save.
    if (defaultSignupCredits !== undefined) {
        const dsc = Number(defaultSignupCredits);
        if (!Number.isFinite(dsc) || dsc < 0) {
            return res.status(400).json({ success: false, error: 'defaultSignupCredits must be a finite number >= 0.' });
        }
    }
    if (referralReward !== undefined) {
        const rr = Number(referralReward);
        if (!Number.isFinite(rr) || rr < 0) {
            return res.status(400).json({ success: false, error: 'referralReward must be a finite number >= 0.' });
        }
    }

    try {
        // v91 (BugHunter DB P1-9): get-or-create via atomic upsert — the old
        // findOne + `new AppConfig` + save() raced on cold starts (two
        // serverless invocations -> E11000 on the unique key -> 500).
        let conf = await AppConfig.findOneAndUpdate(
            { key: 'global_config' },
            { $setOnInsert: { key: 'global_config' } },
            { upsert: true, new: true }
        );

        const set = {};
        if (maintenance) {
            set.maintenance = {
                ...((conf.maintenance && typeof conf.maintenance.toObject === 'function') ? conf.maintenance.toObject() : (conf.maintenance || {})),
                ...maintenance,
                countdownEnd: maintenance.countdownEnd ? new Date(maintenance.countdownEnd) : conf.maintenance?.countdownEnd
            };
        }
        if (minAppVersion !== undefined) set.minAppVersion = String(minAppVersion).trim();
        if (latestAppVersion !== undefined) set.latestAppVersion = String(latestAppVersion).trim();
        if (updateUrl !== undefined) set.updateUrl = String(updateUrl).trim();
        if (updateNotes !== undefined) set.updateNotes = String(updateNotes).trim();
        if (forceUpdate !== undefined) set.forceUpdate = Boolean(forceUpdate);
        if (featureFlags !== undefined) set.featureFlags = { ...conf.featureFlags, ...featureFlags };
        if (whiteLabel !== undefined) set.whiteLabel = { ...conf.whiteLabel, ...whiteLabel };
        if (defaultSignupCredits !== undefined) set.defaultSignupCredits = Number(defaultSignupCredits);
        if (referralReward !== undefined) set.referralReward = Number(referralReward);
        if (systemPrompt !== undefined) set.systemPrompt = systemPrompt;
        if (currentModel !== undefined) set.currentModel = currentModel;
        // VOXPILOT PHASE 2 (v58): admin-editable Live custom instructions.
        if (liveInstructions !== undefined) set.liveInstructions = String(liveInstructions).slice(0, 4000);
        if (onlineTool !== undefined && onlineTool !== null && typeof onlineTool === 'object') {
            const prev = (conf.onlineTool && typeof conf.onlineTool.toObject === 'function')
                ? conf.onlineTool.toObject() : (conf.onlineTool || {});
            const next = { ...prev };
            if (onlineTool.enabled !== undefined) next.enabled = Boolean(onlineTool.enabled);
            if (onlineTool.minCredits !== undefined) {
                const mc = Number(onlineTool.minCredits);
                if (Number.isFinite(mc) && mc >= 0) next.minCredits = mc;
            }
            if (onlineTool.theme !== undefined) {
                next.theme = onlineTool.theme === 'light' ? 'light' : 'neon-dark';
            }
            if (onlineTool.customPath !== undefined) {
                let p = String(onlineTool.customPath).trim().toLowerCase()
                    .replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
                if (p && p !== 'api' && p !== 'admin') next.customPath = p;
            }
            set.onlineTool = next;
        }

        // Targeted $set — no whole-doc save (DB P1-13 revalidation hazard).
        conf = Object.keys(set).length > 0
            ? await AppConfig.findOneAndUpdate({ key: 'global_config' }, { $set: set }, { new: true })
            : conf;
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
