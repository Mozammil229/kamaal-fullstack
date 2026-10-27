const { GoogleGenerativeAI } = require('@google/generative-ai');
const env = require('../config/env');

const rawGeminiEnvKeys = [
    env.GEMINI_API_KEY,
    env.GEMINI_BACKUP_KEYS
].filter(Boolean).join(',');

const GEMINI_KEYS = Array.from(new Set(
    rawGeminiEnvKeys
        .split(',')
        .map(k => k.trim())
        .filter(k => k && k.length > 10 && k !== 'MY_GEMINI_API_KEY')
));

let keyIndex = 0;
const rateLimitedKeys = new Map();

// v91 (BugHunter backend F2): race a promise against a timer so a stalled
// provider attempt fails fast instead of hanging the Vercel function.
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function generateWithKeys(keys, message, systemInstruction, modelName = 'gemini-2.5-flash') {
    if (!keys || keys.length === 0) {
        const err = new Error('Gemini API key is not configured on the server. Set GEMINI_API_KEY in the server environment variables.');
        err.code = 'GEMINI_KEY_MISSING';
        throw err;
    }

    // MODEL LIST (corrected 2026-10-22): the Round 2 cleanup removed the
    // 3.x models believing they were fake — they are REAL. Google has since
    // RETIRED gemini-2.5-flash / gemini-2.5-flash-lite for NEW API keys
    // (generateContent -> 404 "not available to new users", while
    // models.list still shows them), which broke chat deterministically.
    // Order: the configured model first, then the current working ids,
    // then the moving alias so a future retirement self-heals.
    const modelsToTry = Array.from(new Set([modelName, 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest']));
    let lastError = null;
    const attemptErrors = [];

    for (let k = 0; k < keys.length; k++) {
        const candidateKey = keys[(keyIndex + k) % keys.length];
        const lastRateLimit = rateLimitedKeys.get(candidateKey) || 0;
        if (Date.now() - lastRateLimit < 60000 && keys.length > 1) {
            continue;
        }

        for (const mName of modelsToTry) {
            try {
                const aiClient = new GoogleGenerativeAI(candidateKey);
                const model = aiClient.getGenerativeModel({
                    model: mName,
                    systemInstruction: systemInstruction
                });
                // v91 (BugHunter backend F2): the Gemini leg had NO timeout —
                // a stalled model hung the call until Vercel killed the
                // function (15s Hobby default) and the client saw a hang, not
                // JSON. Each attempt is now bounded to 15s.
                const result = await withTimeout(
                    model.generateContent(message),
                    15 * 1000,
                    `Gemini ${mName} timed out after 15s`
                );
                const reply = result.response.text();
                if (reply && reply.trim()) {
                    keyIndex = (keyIndex + k) % keys.length;
                    return reply.trim();
                }
                attemptErrors.push(`${mName}: empty reply`);
            } catch (err) {
                lastError = err;
                attemptErrors.push(`${mName}: ${(err.message || 'error').slice(0, 140)}`);
                const errMsg = (err.message || '').toLowerCase();
                // Quota/overload: cool down this key and rotate to the next one.
                if (errMsg.includes('quota') || errMsg.includes('429') || errMsg.includes('resource_exhausted') || errMsg.includes('overloaded')) {
                    rateLimitedKeys.set(candidateKey, Date.now());
                    console.warn('Gemini key quota hit. Rotating key...');
                    break;
                }
                // Dead key (revoked/leaked/invalid): skip it permanently for this process.
                if (errMsg.includes('leaked') || errMsg.includes('api key not valid') || errMsg.includes('permission_denied') || errMsg.includes('invalid api key')) {
                    rateLimitedKeys.set(candidateKey, Date.now() + 3600_000);
                    console.warn('Gemini key is revoked or invalid. Rotating key...');
                    break;
                }
            }
        }
    }

    // Surface EVERY attempt's failure (model + reason), not just the last
    // one — a single masked error is what hid the 2026-10-22 model-404
    // breakage behind a generic NO_RESPONSE for a day.
    if (attemptErrors.length > 0) {
        const err = new Error(`Gemini request failed on all models: ${attemptErrors.join(' | ')}`);
        err.code = lastError ? (lastError.code || 'GEMINI_NO_RESPONSE') : 'GEMINI_NO_RESPONSE';
        throw err;
    }
    if (lastError) throw lastError;
    const err = new Error('Gemini request failed: all configured keys were exhausted or returned empty responses.');
    err.code = 'GEMINI_NO_RESPONSE';
    throw err;
}

async function generateWithKeyPool(message, systemInstruction, modelName) {
    return generateWithKeys(GEMINI_KEYS, message, systemInstruction, modelName);
}

// LEGACY SIGNATURE (kept for caller compatibility): since Round 2
// (2026-10-21) BYOK is retired — user-supplied keys are never honored;
// the userKey argument is ignored and the shared pool always serves.
async function generateWithUserKeyFirst(userKey, message, systemInstruction, modelName) {
    void userKey; // intentionally ignored — BYOK retired (Round 2, 2026-10-21)
    return generateWithKeyPool(message, systemInstruction, modelName);
}

module.exports = {
    generateWithKeyPool,
    generateWithUserKeyFirst,
    // VOXPILOT PHASE 2 (v58): Live ephemeral-token minting needs the pool
    // order (primary first). Returns a copy; never logs keys.
    getGeminiKeys: () => GEMINI_KEYS.slice(),
    hasConfiguredKeys: () => GEMINI_KEYS.length > 0
};
