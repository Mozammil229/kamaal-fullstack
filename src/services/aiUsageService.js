const AiUsage = require('../models/AiUsage');

// DAILY FREE-AI TIME BUDGET (user order 2026-10-20).
// FREE tier: 20 minutes (1200s) of ONLINE AI per PKT calendar day, shared
// by AI text chat and online voice calls. PAID/PRO: unlimited.
// OFFLINE (on-device) AI never touches this service — zero server cost.
const DAILY_LIMIT_SECONDS = 20 * 60;

/** Today's date string (YYYY-MM-DD) in Asia/Karachi. */
function pktToday() {
    // en-CA yields YYYY-MM-DD; timeZone pins it to Karachi midnight.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Karachi',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
}

/** PAID/PRO = unlimited. Mirrors the app tier mapping (proPlan 'trial' = FREE). */
function isUnlimited(user) {
    if (!user) return false;
    if (user.isPro === true) return true;
    const plan = (user.proPlan || 'trial').toLowerCase();
    return plan === 'monthly' || plan === 'yearly' || plan === 'lifetime';
}

async function getUsage(username, user) {
    const unlimited = isUnlimited(user);
    if (unlimited) {
        return { unlimited: true, limitSeconds: DAILY_LIMIT_SECONDS, secondsUsed: 0, remainingSeconds: DAILY_LIMIT_SECONDS };
    }
    const doc = await AiUsage.findOne({ username, date: pktToday() }).lean();
    const used = doc?.secondsUsed || 0;
    return {
        unlimited: false,
        limitSeconds: DAILY_LIMIT_SECONDS,
        secondsUsed: used,
        remainingSeconds: Math.max(0, DAILY_LIMIT_SECONDS - used),
    };
}

/** True when a FREE user still has daily budget left (server-side enforcement). */
async function hasBudgetLeft(username, user) {
    if (isUnlimited(user)) return true;
    const u = await getUsage(username, user);
    return u.remainingSeconds > 0;
}

/**
 * Atomically adds elapsed seconds to today's pool for [username].
 * Returns the fresh usage snapshot (same shape as getUsage).
 */
async function addUsage(username, kamalId, seconds, user) {
    const s = Math.max(0, Math.min(Math.floor(Number(seconds) || 0), 3600)); // sanity cap per report
    if (s > 0) {
        await AiUsage.findOneAndUpdate(
            { username, date: pktToday() },
            {
                $inc: { secondsUsed: s },
                $set: { updatedAt: new Date(), ...(kamalId ? { kamalId } : {}) },
                $setOnInsert: { username, date: pktToday() },
            },
            { upsert: true, new: true },
        );
    }
    return getUsage(username, user);
}

module.exports = { DAILY_LIMIT_SECONDS, pktToday, isUnlimited, getUsage, hasBudgetLeft, addUsage };
