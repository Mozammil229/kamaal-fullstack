// ============================================================================
// PHASE H — free AI model stack: multi-provider fallback chain.
// ----------------------------------------------------------------------------
// BUSINESS MODEL (user's own words): users get AI chat for free of provider
// cost, the owner earns by selling credits. Per-message credit deduction
// (client -> POST /api/deduct) is UNTOUCHED — that is the monetization.
// This file keeps the OWNER's cost at ~zero by chaining FREE provider tiers.
//
// Fallback order: Groq (free tier) -> Gemini free-tier key pool -> OpenRouter
// free (:free) models. On 429/quota a provider is cooled down ~60s (same
// pattern as geminiService.js); a dead/revoked/invalid key is skipped ~1h.
// ----------------------------------------------------------------------------
// HONEST LIMITS — read before promising anything user-facing:
//   * Free tiers are RATE-LIMITED, not unlimited. There is no unlimited tier.
//   * Groq free: ~30 req/min, ~1,000 req/day and ~100K tokens/day PER GROQ
//     ORG on llama-3.3-70b-versatile. Limits bind per org, not per app user.
//   * Gemini free (AI Studio): 20 req/min per key; the pool rotates keys.
//   * OpenRouter :free routes: ~20 req/min, small daily request caps.
//   What makes this FEEL unlimited: the chain (3 providers deep) + per-user
//   credit gating + the 20/min per-user HTTP rate limit in aiRoutes.js.
//   Never write "unlimited" in a user-facing string.
// ----------------------------------------------------------------------------
// KEYS: none are hardcoded here. Placeholders only, set in the environment
// (Vercel dashboard for production, never committed):
//   GROQ_API_KEY        - free key from console.groq.com (no card needed)
//   GROQ_MODEL          - optional override, default llama-3.3-70b-versatile
//   OPENROUTER_API_KEY  - free key from openrouter.ai
//   OPENROUTER_MODEL    - optional override, default openai/gpt-oss-20b:free
// The Gemini leg reuses the existing GEMINI_API_KEY + GEMINI_BACKUP_KEYS
// pool in geminiService.js (including BYOK: the user's own key first).
// ============================================================================

const env = require('../config/env');
const gemini = require('./geminiService');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-oss-20b:free';

const QUOTA_COOLDOWN_MS = 60 * 1000;   // same as geminiService.js
const DEAD_KEY_SKIP_MS = 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 30 * 1000;

// provider name -> { cooldownUntil: number }
const providerCooldowns = new Map();

function isCooling(name) {
    return (providerCooldowns.get(name)?.cooldownUntil || 0) > Date.now();
}

function coolDown(name, ms, why) {
    providerCooldowns.set(name, { cooldownUntil: Date.now() + ms });
    console.warn(`[AI chain] ${name} cooling down (${why}).`);
}

function classifyError(err) {
    const status = err && err.status;
    const text = `${(err && err.message) || ''} ${(err && err.body) || ''}`.toLowerCase();
    if (status === 429 || /quota|rate.?limit|resource_exhausted|overloaded|too many requests/.test(text)) {
        return 'quota';
    }
    if (status === 401 || status === 403 || /invalid api key|invalid.*key|unauthorized|forbidden|revoked|leaked|permission_denied|authentication/.test(text)) {
        return 'dead';
    }
    return 'transient';
}

// Generic OpenAI-compatible chat completion call (Groq and OpenRouter both
// speak this protocol). Throws with err.status / err.body on HTTP failure.
async function postOpenAICompat({ url, apiKey, model, message, systemInstruction, extraHeaders = {} }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                ...extraHeaders
            },
            body: JSON.stringify({
                model,
                messages: [
                    ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
                    { role: 'user', content: message }
                ],
                temperature: 0.7,
                max_tokens: 2048
            })
        });
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(`Provider HTTP ${res.status}: ${String(text).slice(0, 300)}`);
            err.status = res.status;
            err.body = text;
            throw err;
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch {
            const err = new Error('Provider returned a non-JSON response.');
            err.status = res.status;
            throw err;
        }
        const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (reply && String(reply).trim()) return String(reply).trim();
        const err = new Error('Provider returned an empty reply.');
        err.status = res.status;
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function tryGroq(message, systemInstruction) {
    const apiKey = (env.GROQ_API_KEY || '').trim();
    if (!apiKey || apiKey === 'MY_GROQ_API_KEY') return null; // not configured
    if (isCooling('groq')) return null;
    const model = (env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL;
    try {
        const reply = await postOpenAICompat({ url: GROQ_URL, apiKey, model, message, systemInstruction });
        console.log(`[AI chain] served by Groq (${model}).`);
        return reply;
    } catch (err) {
        const kind = classifyError(err);
        if (kind === 'quota') coolDown('groq', QUOTA_COOLDOWN_MS, '429/quota');
        else if (kind === 'dead') coolDown('groq', DEAD_KEY_SKIP_MS, 'invalid/revoked key');
        else console.warn(`[AI chain] Groq transient failure: ${err.message}`);
        err.provider = 'groq';
        throw err;
    }
}

async function tryGemini(message, systemInstruction, userGeminiKey, geminiModelName) {
    if (!gemini.hasConfiguredKeys() && !(userGeminiKey && String(userGeminiKey).trim().length > 10)) {
        return null; // not configured
    }
    if (isCooling('gemini')) return null;
    try {
        // Delegates to the existing pool: user's own key first (BYOK), then
        // the shared pool with per-key 60s cooldown + dead-key skip.
        const reply = await gemini.generateWithUserKeyFirst(userGeminiKey, message, systemInstruction, geminiModelName);
        console.log('[AI chain] served by Gemini pool.');
        return reply;
    } catch (err) {
        if (err.code === 'GEMINI_KEY_MISSING') return null; // nothing usable configured
        const kind = classifyError(err);
        if (kind === 'quota') coolDown('gemini', QUOTA_COOLDOWN_MS, 'quota/overload');
        else if (kind === 'dead') coolDown('gemini', DEAD_KEY_SKIP_MS, 'revoked key in pool');
        else console.warn(`[AI chain] Gemini transient failure: ${err.message}`);
        err.provider = 'gemini';
        throw err;
    }
}

async function tryOpenRouter(message, systemInstruction) {
    const apiKey = (env.OPENROUTER_API_KEY || '').trim();
    if (!apiKey || apiKey === 'MY_OPENROUTER_API_KEY') return null; // not configured
    if (isCooling('openrouter')) return null;
    const model = (env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL).trim() || DEFAULT_OPENROUTER_MODEL;
    try {
        const reply = await postOpenAICompat({
            url: OPENROUTER_URL,
            apiKey,
            model,
            message,
            systemInstruction,
            // OpenRouter convention (optional but recommended headers).
            extraHeaders: { 'X-Title': 'Kamaal App' }
        });
        console.log(`[AI chain] served by OpenRouter (${model}).`);
        return reply;
    } catch (err) {
        const kind = classifyError(err);
        if (kind === 'quota') coolDown('openrouter', QUOTA_COOLDOWN_MS, '429/rate limit');
        else if (kind === 'dead') coolDown('openrouter', DEAD_KEY_SKIP_MS, 'invalid/revoked key');
        else console.warn(`[AI chain] OpenRouter transient failure: ${err.message}`);
        err.provider = 'openrouter';
        throw err;
    }
}

// Drop-in replacement for geminiService.generateWithUserKeyFirst.
// Returns the reply STRING (same contract). geminiModelName is the app's
// configured Gemini model (from AppConfig), used only on the Gemini leg.
async function generateAIReply(message, systemInstruction, userGeminiKey, geminiModelName) {
    if (!message || !String(message).trim()) {
        const err = new Error('Message required.');
        err.code = 'AI_BAD_REQUEST';
        throw err;
    }
    const failures = [];

    for (const attempt of [
        () => tryGroq(message, systemInstruction),
        () => tryGemini(message, systemInstruction, userGeminiKey, geminiModelName),
        () => tryOpenRouter(message, systemInstruction)
    ]) {
        try {
            const reply = await attempt();
            if (reply) return reply; // null = provider not configured or cooling: move on quietly
        } catch (err) {
            failures.push(`${err.provider || 'provider'}: ${(err.message || 'error').slice(0, 160)}`);
        }
    }

    if (failures.length === 0) {
        const err = new Error(
            'No AI provider is configured on the server. Set GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY in the server environment variables.'
        );
        err.code = 'AI_KEY_MISSING';
        throw err;
    }
    const err = new Error(`AI request failed on all providers: ${failures.join(' | ')}`);
    err.code = 'AI_NO_RESPONSE';
    throw err;
}

function hasConfiguredProviders() {
    const groq = (env.GROQ_API_KEY || '').trim().length > 10;
    const openrouter = (env.OPENROUTER_API_KEY || '').trim().length > 10;
    return groq || openrouter || gemini.hasConfiguredKeys();
}

module.exports = {
    generateAIReply,
    hasConfiguredProviders,
    GROQ_URL,
    OPENROUTER_URL,
    // Test-only: clears provider cooldowns between smoke-test scenarios.
    __resetProviderCooldowns: () => providerCooldowns.clear()
};
