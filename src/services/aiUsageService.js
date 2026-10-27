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
 * v91 (BugHunter DB P1-15): the upsert raced on first-report (E11000) and
 * the $inc had no cap, so concurrent reports could push secondsUsed past
 * the daily limit. Now: pre-read the used total, add at most the remaining
 * headroom, and retry once on E11000 (a concurrent insert won the race).
 */
async function addUsage(username, kamalId, seconds, user) {
    const s = Math.max(0, Math.min(Math.floor(Number(seconds) || 0), 3600)); // sanity cap per report
    if (s > 0) {
        const today = pktToday();
        const current = await AiUsage.findOne({ username, date: today }).lean();
        const used = current?.secondsUsed || 0;
        const headroom = Math.max(0, DAILY_LIMIT_SECONDS - used);
        const add = Math.min(s, headroom);
        if (add > 0) {
            const update = {
                $inc: { secondsUsed: add },
                $set: { updatedAt: new Date(), ...(kamalId ? { kamalId } : {}) },
                $setOnInsert: { username, date: today },
            };
            try {
                await AiUsage.findOneAndUpdate({ username, date: today }, update, { upsert: true, new: true });
            } catch (e) {
                if (e && e.code === 11000) {
                    // Concurrent first-report won the insert race — retry
                    // without upsert; the row now exists.
                    await AiUsage.findOneAndUpdate(
                        { username, date: today },
                        { $inc: { secondsUsed: add }, $set: { updatedAt: new Date(), ...(kamalId ? { kamalId } : {}) } }
                    );
                } else {
                    throw e;
                }
            }
        }
    }
    return getUsage(username, user);
}

module.exports = { DAILY_LIMIT_SECONDS, pktToday, isUnlimited, getUsage, hasBudgetLeft, addUsage };
