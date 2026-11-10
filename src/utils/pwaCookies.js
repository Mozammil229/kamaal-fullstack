'use strict';

// 4D (PWA cookie auth) — shared cookie helpers. Single source of truth for
// cookie names, paths and the Secure rule, so the controller, the CSRF
// guard, the auth middleware and the admin login can never drift apart.
//
// SECURE RULE: Secure is set ONLY when the request actually arrived over
// HTTPS (req.secure or x-forwarded-proto). Setting Secure on plain http
// would make the browser drop the cookie and break local dev entirely.
// Cookie names are FIXED in code, not env (spec §6.4 item 1).

const ACCESS_COOKIE = 'kamaal_access';
const REFRESH_COOKIE = 'kamaal_refresh';
const CSRF_COOKIE = 'kamaal_csrf';
const ADMIN_COOKIE = 'kamaal_admin';

// Tiny hand-rolled parser — no new dependency (no cookie-parser).
function parseCookies(req) {
    const out = {};
    const header = req && req.headers ? req.headers.cookie : '';
    if (!header || typeof header !== 'string') return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const name = part.slice(0, idx).trim();
        const raw = part.slice(idx + 1).trim();
        if (!name) continue;
        try {
            out[name] = decodeURIComponent(raw);
        } catch (_) {
            out[name] = raw;
        }
    }
    return out;
}

function isSecureRequest(req) {
    if (req && req.secure) return true;
    const proto = req && req.headers ? String(req.headers['x-forwarded-proto'] || '') : '';
    return proto.split(',')[0].trim().toLowerCase() === 'https';
}

function baseOptions(req, path, maxAgeMs, httpOnly) {
    const secure = isSecureRequest(req);
    return {
        httpOnly,
        secure,
        // 4E F-01: cross-origin cookie auth needs SameSite=None on HTTPS
        // (Lax cookies are NOT sent on cross-site fetch/XHR, so the PWA
        // on its own host could never authenticate). SameSite=None
        // REQUIRES Secure — both stay tied to this one condition, so
        // plain-HTTP local dev keeps Lax + no Secure, unchanged.
        sameSite: secure ? 'none' : 'lax',
        path,
        maxAge: maxAgeMs
    };
}

function setCookie(res, req, name, value, path, maxAgeMs, httpOnly) {
    res.cookie(name, value, baseOptions(req, path, maxAgeMs, httpOnly));
}

// Clear with an expired Set-Cookie that MATCHES the original Path (and
// Secure flag) — otherwise the browser keeps the live cookie.
function clearCookie(res, req, name, path, httpOnly) {
    res.cookie(name, '', {
        ...baseOptions(req, path, 0, httpOnly),
        expires: new Date(0)
    });
}

module.exports = {
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    CSRF_COOKIE,
    ADMIN_COOKIE,
    parseCookies,
    isSecureRequest,
    setCookie,
    clearCookie
};
