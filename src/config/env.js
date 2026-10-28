const dotenv = require('dotenv');
dotenv.config();

// ROUND 2 (2026-10-21): JWT secrets are REQUIRED — the old hardcoded
// public fallbacks (visible in the previously-public repo) are removed.
// Fail closed with a clear error instead of silently signing tokens with
// a known secret. Production values live ONLY in the Vercel environment.
for (const required of ['JWT_SECRET', 'ADMIN_JWT_SECRET']) {
    if (!process.env[required] || !String(process.env[required]).trim()) {
        throw new Error(`FATAL: ${required} is not set. Configure it in the server environment (Vercel dashboard) — there is no code fallback.`);
    }
}

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    MONGODB_URI: process.env.MONGODB_URI || '',
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_USER: (process.env.ADMIN_USER || 'admin').trim(),
    // SECURITY FIX (#1): NO hardcoded default password. If ADMIN_PASS is not
    // set in the environment, direct-key admin auth is DISABLED (fail-closed).
    // The old default 'ADmin' was a public backdoor.
    ADMIN_PASS: (process.env.ADMIN_PASS || '').trim(),
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_BACKUP_KEYS: process.env.GEMINI_BACKUP_KEYS || '',
    ADMIN_TOKEN_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
    // PHASE F — transport encryption: RSA-2048 PRIVATE key (PEM) used to
    // decrypt RSA-OAEP-SHA256-encrypted passwords on login/register, and to
    // derive the public key served at GET /api/auth/pubkey. NEVER commit a
    // real key: set RSA_PRIVATE_KEY_PEM in the Vercel dashboard (production
    // env). Vercel pastes multiline PEMs with literal \n — normalized here.
    // If unset, /api/auth/pubkey answers 503 and clients fall back to
    // plaintext-over-TLS (documented, acceptable interim state).
    RSA_PRIVATE_KEY_PEM: (process.env.RSA_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n').trim(),
    // PHASE H — free AI model stack (multi-provider fallback chain). NO real
    // keys in code or git: set these in the Vercel dashboard (production env)
    // or a local .env (never committed). The user supplies the free keys.
    // Groq (PRIMARY, free tier, OpenAI-compatible). Default model
    // llama-3.3-70b-versatile: ~30 req/min, ~1,000 req/day per Groq org.
    GROQ_API_KEY: (process.env.GROQ_API_KEY || '').trim(),
    GROQ_MODEL: (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),
    // OpenRouter (FALLBACK 2, free :free routes). Default
    // openai/gpt-oss-20b:free (~20 req/min, small daily caps).
    OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY || '').trim(),
    OPENROUTER_MODEL: (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free').trim(),
    // DONUT FEED (YouTube Data API v3, nightly server cron). NO real key in
    // code or git: the user creates the key in Google Cloud Console and sets
    // YOUTUBE_API_KEY in the Vercel dashboard (Production) only. Until then
    // POST/GET /api/donut/refresh answers 503 YOUTUBE_API_KEY_NOT_CONFIGURED
    // and the feed serves the (empty) cache. CRON_SECRET is auto-provisioned
    // by Vercel when the `crons` entry in vercel.json deploys; the cron
    // sends it as `Authorization: Bearer <CRON_SECRET>`.
    YOUTUBE_API_KEY: (process.env.YOUTUBE_API_KEY || '').trim(),
    CRON_SECRET: (process.env.CRON_SECRET || '').trim()
};
