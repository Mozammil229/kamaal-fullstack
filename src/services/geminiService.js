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

async function generateWithKeyPool(message, systemInstruction, modelName = 'gemini-3.8-flash') {
    if (GEMINI_KEYS.length === 0) {
        const err = new Error('Gemini API key is not configured on the server. Set GEMINI_API_KEY in the server environment variables.');
        err.code = 'GEMINI_KEY_MISSING';
        throw err;
    }

    // Latest stable models first (per Google AI docs, Oct 2026).
    // gemini-2.0-flash / 1.5-* are shut down by Google - never use them.
    const modelsToTry = Array.from(new Set([modelName, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash']));
    let lastError = null;

    for (let k = 0; k < GEMINI_KEYS.length; k++) {
        const candidateKey = GEMINI_KEYS[(keyIndex + k) % GEMINI_KEYS.length];
        const lastRateLimit = rateLimitedKeys.get(candidateKey) || 0;
        if (Date.now() - lastRateLimit < 60000 && GEMINI_KEYS.length > 1) {
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
                    keyIndex = (keyIndex + k) % GEMINI_KEYS.length;
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

module.exports = {
    generateWithKeyPool,
    hasConfiguredKeys: () => GEMINI_KEYS.length > 0
};
