const UserMemory = require('../models/UserMemory');
const memoryCrypto = require('./memoryCrypto');
const { generateWithUserKeyFirst, generateWithKeyPool } = require('./geminiService');
const { memoryEngineMaster } = require('../personas/personaPrompts');

// AI MEMORY ENGINE service (user order 2026-10-20). Implements the master
// prompt's rules server-side:
//  - WORKING memory = the live conversation (handled by the chat flow).
//  - LONG-TERM memory = durable facts the USER stated about themselves,
//    extracted after each reply and stored AES-256-GCM encrypted.
//  - A newer correction REPLACES the older fact (same category+key).
//  - The engine NEVER claims a fact was saved unless the DB write
//    actually succeeded — extraction is fire-and-forget and fail-soft:
//    any error means "not saved", never a fabricated memory.
// Everything here is PRO-only and per-user; callers enforce the PRO gate.

const MAX_FACTS = 200;          // hard cap per user (oldest dropped)
const INJECT_MAX_FACTS = 150;   // injection cap (most recent first)
const INJECT_MAX_CHARS = 4000;  // injection block size cap
const MAX_FACTS_PER_TURN = 12;  // sanity cap on one extraction pass
const CATEGORIES = ['identity', 'family', 'friends', 'contact', 'preference', 'project', 'decision', 'other'];

/** Load (or null) the user's memory doc. Never creates one. */
async function loadMemory(username) {
    if (!username) return null;
    return UserMemory.findOne({ username });
}

/** True when memory should be used for this user (exists-or-new + enabled). */
function memoryEnabled(doc) {
    return !doc || doc.enabled !== false;
}

/**
 * Decrypt all facts of a memory doc for its OWNER / for prompt injection.
 * Facts that fail to decrypt (key rotation, corruption) are skipped —
 * ciphertext is never exposed or injected.
 * Returns newest-first [{ id, category, key, value, kind, updatedAt }].
 */
function decryptFacts(doc) {
    if (!doc || !Array.isArray(doc.facts)) return [];
    const out = [];
    for (const f of doc.facts) {
        try {
            out.push({
                id: String(f._id),
                category: f.category || 'other',
                key: f.key || '',
                value: memoryCrypto.decryptValue(f.valueEnc),
                kind: f.kind || 'confirmed',
                updatedAt: f.updatedAt || doc.updatedAt,
            });
        } catch (_) { /* skip undecryptable fact */ }
    }
    out.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return out;
}

/** Compact injection block appended to the chat system instruction. */
function buildMemoryBlock(doc) {
    const facts = decryptFacts(doc).slice(0, INJECT_MAX_FACTS);
    if (facts.length === 0) return '';
    const lines = ['User ke baare mein mehfooz maloomat:'];
    let size = lines[0].length;
    for (const f of facts) {
        const line = `- ${f.category}/${f.key}: ${f.value}`;
        if (size + line.length + 1 > INJECT_MAX_CHARS) break;
        lines.push(line);
        size += line.length + 1;
    }
    return lines.length > 1 ? lines.join('\n') : '';
}

const EXTRACTION_DIRECTIVE = [
    '',
    '---',
    'EXTRACTION TASK (server-side memory engine):',
    'You will be given the latest USER message and the ASSISTANT reply.',
    'Extract ONLY durable facts the USER stated about THEMSELVES: their name,',
    'parents/family members, friends, their own phone number if they stated',
    'it, preferences, projects, decisions, and explicit corrections to older',
    'facts. Never extract facts about other people the user merely mentions',
    'in passing, never extract the assistant\'s statements, and never invent.',
    'If the user asks to FORGET something ("bhool jao", "delete kar do",',
    '"forget my ..."), emit an entry {"forget": "<key>"} for that fact key.',
    'Return ONLY a JSON array (no markdown, no commentary). Each fact entry:',
    '{"category": "identity|family|friends|contact|preference|project|decision|other", "key": "short_snake_case_label", "value": "the fact as the user stated it", "kind": "confirmed|preference"}',
    'If there is nothing durable to save, return [].',
].join('\n');

/** Strip code fences and pull the first JSON array out of a model reply. */
function parseExtractionJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try {
        const arr = JSON.parse(t.slice(start, end + 1));
        return Array.isArray(arr) ? arr : null;
    } catch (_) {
        return null;
    }
}

/**
 * Fire-and-forget extraction pass. Called AFTER the chat reply has been
 * sent; fully wrapped — it must never throw into the chat path.
 * Returns true only when a DB write actually happened.
 */
async function extractAndSave({ username, userMessage, assistantReply, userGeminiKey }) {
    try {
        if (!username || !userMessage) return false;
        if (!memoryCrypto.isConfigured()) return false;

        const existing = await loadMemory(username);
        if (!memoryEnabled(existing)) return false;

        const content = `USER MESSAGE:\n${String(userMessage).slice(0, 4000)}\n\nASSISTANT REPLY:\n${String(assistantReply || '').slice(0, 2000)}`;
        const system = memoryEngineMaster + '\n' + EXTRACTION_DIRECTIVE;
        let raw;
        try {
            raw = await generateWithUserKeyFirst(userGeminiKey || '', content, system, 'gemini-3.8-flash');
        } catch (_) {
            try { raw = await generateWithKeyPool(content, system, 'gemini-3.8-flash'); } catch (_) { return false; }
        }
        const entries = parseExtractionJson(raw);
        if (!entries || entries.length === 0) return false;

        const doc = existing || new UserMemory({ username, enabled: true, facts: [] });
        let changed = false;
        let applied = 0;

        for (const e of entries) {
            if (applied >= MAX_FACTS_PER_TURN) break;
            if (!e || typeof e !== 'object') continue;

            // Forget request: {"forget": "key"} (or {category, key}).
            const forgetKey = typeof e.forget === 'string'
                ? e.forget
                : (e.forget && typeof e.forget === 'object' ? e.forget.key : null);
            if (forgetKey) {
                const k = String(forgetKey).trim().toLowerCase();
                const before = doc.facts.length;
                doc.facts = doc.facts.filter(f => String(f.key).toLowerCase() !== k);
                if (doc.facts.length !== before) { changed = true; applied += 1; }
                continue;
            }

            const key = String(e.key || '').trim().slice(0, 80);
            const value = String(e.value || '').trim().slice(0, 500);
            if (!key || !value) continue;
            const category = CATEGORIES.includes(String(e.category)) ? String(e.category) : 'other';
            const kind = e.kind === 'preference' ? 'preference' : 'confirmed';

            // Correction wins: same category+key -> replace, never duplicate.
            const idx = doc.facts.findIndex(f =>
                f.category === category && String(f.key).toLowerCase() === key.toLowerCase());
            const enc = memoryCrypto.encryptValue(value);
            if (idx >= 0) {
                doc.facts[idx].valueEnc = enc;
                doc.facts[idx].kind = kind;
                doc.facts[idx].source = 'chat';
                doc.facts[idx].updatedAt = new Date();
            } else {
                doc.facts.push({ category, key, valueEnc: enc, kind, source: 'chat', updatedAt: new Date() });
            }
            changed = true;
            applied += 1;
        }

        if (!changed) return false;

        // Cap: keep the most recently updated MAX_FACTS.
        if (doc.facts.length > MAX_FACTS) {
            doc.facts = [...doc.facts]
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
                .slice(0, MAX_FACTS);
        }
        doc.updatedAt = new Date();
        await doc.save();
        return true;
    } catch (_) {
        return false; // fail-soft: an unsaved fact is simply not remembered
    }
}

module.exports = {
    loadMemory,
    memoryEnabled,
    decryptFacts,
    buildMemoryBlock,
    extractAndSave,
};
