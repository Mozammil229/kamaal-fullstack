// 4A (M-P2-17): production errors never echo internals.
// Every 500/validation catch returns a generic message + a server-side error
// ID the user can quote to support. The real error goes to server logs only.
const crypto = require('crypto');

function serverError(res, e, status = 500, message = 'Something went wrong. Please try again.', extra = {}) {
    const errorId = crypto.randomUUID();
    try {
        console.error(`[error ${errorId}]`, e && e.stack ? e.stack : e);
    } catch (_) { /* logging must never break the response */ }
    return res.status(status).json({ success: false, error: message, errorId, ...extra });
}

module.exports = { serverError };
