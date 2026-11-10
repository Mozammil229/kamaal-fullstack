// 4A (M-P2-18): server-side input validation layer (client checks are UX only).
// Length caps (plan §4.8 rule 5), finite-number checks, limit/offset clamps.
// Only KNOWN field names are capped — unknown fields (e.g. crash stack traces)
// pass through untouched so existing clients keep working.
const TEXT_CAPS = {
    message: 4000, text: 4000, supportMessage: 4000,
    customPrompt: 8000, systemPrompt: 8000, prompt: 8000,
    question: 200, option: 100, transactionId: 128, screenshotUrl: 2048,
    username: 32, name: 100, bio: 500
};
const NUMERIC_FIELDS = ['amount', 'credits', 'creditsToAdd', 'optionIndex'];

function validateInput(req, res, next) {
    const body = req.body;
    if (body && typeof body === 'object') {
        for (const [key, cap] of Object.entries(TEXT_CAPS)) {
            const v = body[key];
            if (typeof v === 'string' && v.length > cap) {
                return res.status(400).json({ success: false, error: `${key} is too long (max ${cap} characters).` });
            }
        }
        if (typeof body.screenshotUrl === 'string' && body.screenshotUrl && !body.screenshotUrl.startsWith('https://')) {
            return res.status(400).json({ success: false, error: 'screenshotUrl must be an https: URL.' });
        }
        for (const key of NUMERIC_FIELDS) {
            const v = body[key];
            if (v !== undefined && v !== null && !Number.isFinite(Number(v))) {
                return res.status(400).json({ success: false, error: `${key} must be a number.` });
            }
        }
        if (Array.isArray(body.options)) {
            if (body.options.length > 6) return res.status(400).json({ success: false, error: 'Too many poll options (max 6).' });
            for (const o of body.options) {
                if (typeof o === 'string' && o.length > 100) return res.status(400).json({ success: false, error: 'Poll option is too long (max 100 characters).' });
            }
        }
    }
    // Clamp list pagination (chat default 75 / max 200; admin lists already cap at 200).
    if (req.query && req.query.limit !== undefined) {
        const n = parseInt(req.query.limit, 10);
        req.query.limit = String(Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 75);
    }
    if (req.query && req.query.offset !== undefined) {
        const n = parseInt(req.query.offset, 10);
        req.query.offset = String(Number.isFinite(n) ? Math.min(10000, Math.max(0, n)) : 0);
    }
    next();
}

module.exports = { validateInput, TEXT_CAPS };
