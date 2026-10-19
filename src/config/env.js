const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    MONGODB_URI: process.env.MONGODB_URI || '',
    JWT_SECRET: process.env.JWT_SECRET || 'kammal_secure_jwt_secret_change_in_production_2026',
    ADMIN_USER: (process.env.ADMIN_USER || 'admin').trim(),
    // SECURITY FIX (#1): NO hardcoded default password. If ADMIN_PASS is not
    // set in the environment, direct-key admin auth is DISABLED (fail-closed).
    // The old default 'ADmin' was a public backdoor.
    ADMIN_PASS: (process.env.ADMIN_PASS || '').trim(),
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'kammal_admin_jwt_secret_2026',
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
    OPENROUTER_MODEL: (process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free').trim()
};
