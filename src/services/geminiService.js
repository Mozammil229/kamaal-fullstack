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

async function generateWithKeyPool(message, systemInstruction, modelName = 'gemini-2.5-flash') {
    if (GEMINI_KEYS.length === 0) {
        return 'Kammal AI Engine: ' + message + ' analyzed. (Set GEMINI_API_KEY in server environment for live neural responses).';
    }

    const modelsToTry = [modelName, 'gemini-1.5-flash', 'gemini-2.0-flash'];
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
                if (errMsg.includes('quota') || errMsg.includes('429') || errMsg.includes('resource_exhausted') || errMsg.includes('overloaded')) {
                    rateLimitedKeys.set(candidateKey, Date.now());
                    console.warn('Gemini key quota hit. Rotating key...');
                    break;
                }
            }
        }
    }

    if (lastError) throw lastError;
    return 'Kammal AI Engine: ' + message + ' processed.';
}

module.exports = {
    generateWithKeyPool,
    hasConfiguredKeys: () => GEMINI_KEYS.length > 0
};
