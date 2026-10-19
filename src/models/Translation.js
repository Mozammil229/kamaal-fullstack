// PHASE C — server-side translation cache (blueprint §3/§7).
// Same (text hash, target language) translated once, served to every user.
const mongoose = require('mongoose');

const TranslationSchema = new mongoose.Schema({
    textHash: { type: String, required: true },
    targetLang: { type: String, required: true },
    translatedText: { type: String, required: true },
    model: { type: String, default: '' },
    createdAt: { type: Number, default: Date.now }
});

TranslationSchema.index({ textHash: 1, targetLang: 1 }, { unique: true });

module.exports = mongoose.models.Translation || mongoose.model('Translation', TranslationSchema);
