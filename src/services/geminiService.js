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

async function generateWithKeys(keys, message, systemInstruction, modelName = 'gemini-2.5-flash') {
    if (!keys || keys.length === 0) {
        const err = new Error('Gemini API key is not configured on the server. Set GEMINI_API_KEY in the server environment variables.');
        err.code = 'GEMINI_KEY_MISSING';
        throw err;
    }

    // VERIFIED models only (Round 2 cleanup, 2026-10-21): the old list led
    // with 'gemini-3.8-flash' / 'gemini-3.6-flash', which are NOT real
    // Google model ids — every call wasted attempts on 404s before falling
    // back. gemini-2.5-flash first, then its lite sibling.
    const modelsToTry = Array.from(new Set([modelName, 'gemini-2.5-flash', 'gemini-2.5-flash-lite']));
    let lastError = null;

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
                const result = await model.generateContent(message);
                const reply = result.response.text();
                if (reply && reply.trim()) {
                    keyIndex = (keyIndex + k) % keys.length;
                    return reply.trim();
                }
            } catch (err) {
                lastError = err;
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

// BYOK key test: tiny hello with ONLY the given key (no fallback). Throws if bad.
// No remaining callers since the BYOK endpoints were removed in Safai;
// kept as a harmless utility export.
async function testUserKey(userKey) {
    const clean = String(userKey || '').trim();
    return generateWithKeys([clean], 'Say hello in exactly 3 words.', 'You are a helpful assistant.', 'gemini-2.5-flash');
}

module.exports = {
    generateWithKeyPool,
    generateWithUserKeyFirst,
    testUserKey,
    hasConfiguredKeys: () => GEMINI_KEYS.length > 0
};
