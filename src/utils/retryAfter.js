'use strict';

// 4E F-08 (W3) — shared Retry-After helper for the hand-rolled 429 sites
// (controllers with bespoke in-memory/DB limiters that cannot route
// through the shared src/middleware/rateLimit.js). Every 429 a client can
// hit must carry a numeric Retry-After (seconds until the window resets)
// so honest clients can back off — same rule the shared middleware and
// the 4D W4 route limiters already follow.

function setRetryAfter(res, seconds) {
    const n = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 60;
    res.setHeader('Retry-After', String(n));
    return n;
}

// Seconds until midnight Asia/Karachi — the reset point of the AI daily
// free-time budget (see src/controllers/aiController.js). Computed from
// Intl parts in that timezone (hour can read '24' at midnight with
// hour12:false — normalised to 0).
function secondsUntilMidnightAsiaKarachi(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Karachi',
        hour12: false,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
    }).formatToParts(now);
    const get = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
    let h = get('hour');
    if (h === 24) h = 0;
    const used = h * 3600 + get('minute') * 60 + get('second');
    const left = 24 * 3600 - used;
    return left > 0 ? left : 24 * 3600;
}

module.exports = { setRetryAfter, secondsUntilMidnightAsiaKarachi };
