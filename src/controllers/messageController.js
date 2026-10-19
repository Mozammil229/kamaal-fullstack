// PHASE C — Admin messaging controller (blueprint §6/§7).
//
// Security rules (same class as the October BYOK fix):
// - Every user endpoint derives identity from the VERIFIED JWT only
//   (req.user.username). No client-supplied username/body identity, ever.
// - Admin endpoints sit behind requireAdminAuth (admin JWT or ADMIN_PASS).
// - User replies are rate-limited (30/hour) and capped at 2000 chars.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectToDatabase } = require('../config/db');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Translation = require('../models/Translation');
const AdminAudit = require('../models/AdminAudit');
const geminiService = require('../services/geminiService');

const MAX_BODY_LEN = 2000;
const INBOX_THREAD_LIMIT = 200;
const BROADCAST_LIMIT = 50;

// ---- reply rate limit: 30/hour per user (in-memory, per instance) ---------
// NOTE: on Vercel serverless this is per-function-instance (best effort).
// A determined spammer rotating instances could exceed it; the 2000-char cap
// and admin-side visibility bound the real abuse. A DB-backed bucket is the
// upgrade path if abuse is ever observed.
const REPLY_LIMIT = 30;
const REPLY_WINDOW_MS = 60 * 60 * 1000;
const replyBuckets = new Map(); // username -> [epochMs]

function replyRateLimited(username) {
    const now = Date.now();
    const kept = (replyBuckets.get(username) || []).filter(t => now - t < REPLY_WINDOW_MS);
    if (kept.length >= REPLY_LIMIT) {
        replyBuckets.set(username, kept);
        return true;
    }
    kept.push(now);
    replyBuckets.set(username, kept);
    if (replyBuckets.size > 5000) {
        for (const [k, v] of replyBuckets) {
            if (!v.length || now - v[v.length - 1] > REPLY_WINDOW_MS) replyBuckets.delete(k);
        }
    }
    return false;
}

function cleanBody(raw) {
    const body = String(raw == null ? '' : raw).trim();
    if (!body) return { error: 'Message text required.' };
    if (body.length > MAX_BODY_LEN) return { error: `Message too long (max ${MAX_BODY_LEN} characters).` };
    return { body };
}

async function getOrCreateConversation(userId) {
    return Conversation.findOneAndUpdate(
        { userId },
        { $setOnInsert: { userId, lastMessageAt: Date.now(), adminUnread: 0, userUnread: 0 } },
        { upsert: true, new: true }
    );
}

function toClientMessage(m, username) {
    return {
        id: m._id.toString(),
        sender: m.sender,
        body: m.body,
        createdAt: m.createdAt,
        mine: m.sender === 'USER',
        broadcast: m.sender === 'BROADCAST'
    };
}

// GET /api/messages?since=  — inbox sync: 1-to-1 thread + broadcasts since
// join, merged in time order, plus unread counts. Identity from JWT only.
async function getInbox(req, res) {
    await connectToDatabase();
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);

    try {
        const user = await User.findOne({ username }).select('_id createdAt').lean();
        if (!user) return res.status(401).json({ success: false, error: 'Account not found.' });

        const conv = await getOrCreateConversation(user._id);
        const joinedAt = user.createdAt ? new Date(user.createdAt).getTime() : 0;

        const [thread, broadcasts] = await Promise.all([
            Message.find({ conversationId: conv._id, createdAt: { $gt: since } })
                .sort({ createdAt: 1 }).limit(INBOX_THREAD_LIMIT).lean(),
            Message.find({
                conversationId: null,
                sender: 'BROADCAST',
                createdAt: { $gt: Math.max(since, joinedAt) }
            }).sort({ createdAt: 1 }).limit(BROADCAST_LIMIT).lean()
        ]);

        const merged = thread.concat(broadcasts)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(m => toClientMessage(m, username));

        // Opening / syncing the inbox marks the user's side as read.
        const unreadCount = conv.userUnread || 0;
        const now = Date.now();
        await Promise.all([
            Conversation.updateOne(
                { _id: conv._id },
                { $set: { userUnread: 0 } }
            ),
            Message.updateMany(
                { conversationId: conv._id, sender: { $ne: 'USER' }, readAt: null },
                { $set: { readAt: now } }
            )
        ]);

        return res.json({
            success: true,
            messages: merged,
            unreadCount,
            lastMessageAt: conv.lastMessageAt || 0
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not load messages.' });
    }
}

// POST /api/messages  — user reply in their support thread. JWT identity only.
async function sendMessage(req, res) {
    await connectToDatabase();
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    const { body, error } = cleanBody(req.body && req.body.body);
    if (error) return res.status(400).json({ success: false, error });

    if (replyRateLimited(username)) {
        return res.status(429).json({
            success: false,
            error: 'You are sending messages too quickly. Please wait a little and try again.'
        });
    }

    try {
        const user = await User.findOne({ username }).select('_id').lean();
        if (!user) return res.status(401).json({ success: false, error: 'Account not found.' });

        const conv = await getOrCreateConversation(user._id);
        const now = Date.now();
        const msg = await Message.create({
            conversationId: conv._id,
            sender: 'USER',
            body,
            createdAt: now
        });
        await Conversation.updateOne(
            { _id: conv._id },
            { $set: { lastMessageAt: now }, $inc: { adminUnread: 1 } }
        );

        return res.json({ success: true, message: toClientMessage(msg.toObject(), username) });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not send message.' });
    }
}

async function findTargetUser(userIdParam) {
    const q = String(userIdParam || '').trim();
    if (!q) return null;
    let user = await User.findOne({ username: q }).select('_id username name phone displayKamalId preferredLanguage status createdAt').lean();
    if (!user && mongoose.Types.ObjectId.isValid(q)) {
        user = await User.findById(q).select('_id username name phone displayKamalId preferredLanguage status createdAt').lean();
    }
    return user;
}

// GET /api/admin/messages/users/search?q=  — admin user list for the Chats
// module: search by username / phone / Kamal ID, ordered by recent thread.
async function adminSearchUsers(req, res) {
    await connectToDatabase();
    const q = String(req.query.q || '').trim();
    try {
        const filter = q ? {
            $or: [
                { username: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
                { phone: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
                { displayKamalId: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
            ]
        } : {};
        const users = await User.find(filter)
            .sort({ createdAt: -1 }).limit(50)
            .select('_id username name phone displayKamalId preferredLanguage status')
            .lean();
        const convs = await Conversation.find({ userId: { $in: users.map(u => u._id) } })
            .select('userId lastMessageAt adminUnread').lean();
        const convByUser = new Map(convs.map(c => [String(c.userId), c]));
        const rows = users.map(u => {
            const c = convByUser.get(String(u._id));
            return {
                userId: String(u._id),
                username: u.username,
                name: u.name || '',
                phone: u.phone || '',
                kamalId: u.displayKamalId || '',
                language: u.preferredLanguage || 'en',
                status: u.status || 'active',
                lastMessageAt: c ? c.lastMessageAt : 0,
                adminUnread: c ? c.adminUnread : 0
            };
        }).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        return res.json({ success: true, users: rows });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not search users.' });
    }
}

// GET /api/admin/messages/:userId  — admin reads a user's 1-to-1 thread.
async function adminGetThread(req, res) {
    await connectToDatabase();
    try {
        const user = await findTargetUser(req.params.userId);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        const conv = await Conversation.findOne({ userId: user._id }).lean();
        const messages = conv ? await Message.find({ conversationId: conv._id })
            .sort({ createdAt: 1 }).limit(500).lean() : [];
        // Admin reading the thread clears the admin-side unread counter.
        if (conv && conv.adminUnread) {
            await Conversation.updateOne({ _id: conv._id }, { $set: { adminUnread: 0 } });
        }
        return res.json({
            success: true,
            user: {
                userId: String(user._id),
                username: user.username,
                name: user.name || '',
                phone: user.phone || '',
                kamalId: user.displayKamalId || '',
                language: user.preferredLanguage || 'en',
                status: user.status || 'active'
            },
            messages: messages.map(m => ({
                id: m._id.toString(),
                sender: m.sender,
                body: m.body,
                createdAt: m.createdAt,
                mine: m.sender === 'ADMIN'
            }))
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not load thread.' });
    }
}

// POST /api/admin/messages/:userId  — admin 1-to-1 message (admin JWT).
async function adminSendMessage(req, res) {
    await connectToDatabase();
    const { body, error } = cleanBody(req.body && req.body.body);
    if (error) return res.status(400).json({ success: false, error });
    try {
        const user = await findTargetUser(req.params.userId);
        if (!user) return res.status(404).json({ success: false, error: 'User not found.' });
        const conv = await getOrCreateConversation(user._id);
        const now = Date.now();
        const msg = await Message.create({
            conversationId: conv._id,
            sender: 'ADMIN',
            body,
            createdAt: now
        });
        await Conversation.updateOne(
            { _id: conv._id },
            { $set: { lastMessageAt: now }, $inc: { userUnread: 1 } }
        );
        return res.json({ success: true, id: msg._id.toString() });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not send message.' });
    }
}

function audienceFilter(audience, language, status) {
    const a = String(audience || 'all').toLowerCase();
    if (a === 'all') return { filter: {}, label: 'all' };
    if (a === 'language') {
        const l = String(language || '').toLowerCase();
        if (!['en', 'ur', 'pa'].includes(l)) throw new Error('Invalid language (en/ur/pa).');
        return { filter: { preferredLanguage: l }, label: 'language:' + l };
    }
    if (a === 'status') {
        const s = String(status || '').toLowerCase();
        if (!['active', 'banned'].includes(s)) throw new Error('Invalid status (active/banned).');
        return { filter: { status: s }, label: 'status:' + s };
    }
    throw new Error('Invalid audience (all/language/status).');
}

// POST /api/admin/broadcast/preview  — recipient count before confirming.
async function adminBroadcastPreview(req, res) {
    await connectToDatabase();
    try {
        const { filter, label } = audienceFilter(
            req.body && req.body.audience,
            req.body && req.body.language,
            req.body && req.body.status
        );
        const count = await User.countDocuments(filter);
        return res.json({ success: true, audience: label, count });
    } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
    }
}

// POST /api/admin/broadcast  — {body, audience, language?, status?}.
// Stored ONCE as a broadcast document (fan-out on read); writes an audit row.
async function adminBroadcast(req, res) {
    await connectToDatabase();
    const adminId = (req.adminUser || 'admin').toString();
    const { body, error } = cleanBody(req.body && req.body.body);
    if (error) return res.status(400).json({ success: false, error });
    let filter, label;
    try {
        ({ filter, label } = audienceFilter(
            req.body && req.body.audience,
            req.body && req.body.language,
            req.body && req.body.status
        ));
    } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
    }
    try {
        const count = await User.countDocuments(filter);
        const now = Date.now();
        const msg = await Message.create({
            conversationId: null,
            sender: 'BROADCAST',
            body,
            createdAt: now
        });
        await AdminAudit.create({
            adminId,
            action: 'broadcast',
            audience: label,
            count,
            createdAt: now
        });
        return res.json({ success: true, id: msg._id.toString(), audience: label, count });
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not send broadcast.' });
    }
}

const LANG_NAMES = {
    en: 'English',
    ur: 'Urdu',
    pa: 'Punjabi (Shahmukhi)',
    roman: 'Roman Urdu (Latin script)'
};

// POST /api/translate  — {text, targetLang}: server-side Gemini with a
// Translation cache. No key or any failure -> returns the SOURCE text
// (graceful degradation, never a 500 for the user).
async function translateText(req, res) {
    await connectToDatabase();
    const username = req.user && req.user.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });

    const rawText = String((req.body && req.body.text) || '');
    const targetLang = String((req.body && req.body.targetLang) || '').slice(0, 16).toLowerCase();
    if (!rawText.trim()) return res.status(400).json({ success: false, error: 'Text required.' });
    if (!targetLang) return res.status(400).json({ success: false, error: 'targetLang required.' });
    const text = rawText.slice(0, 4000);
    const textHash = crypto.createHash('sha256').update(text).digest('hex');

    try {
        const cached = await Translation.findOne({ textHash, targetLang }).lean();
        if (cached) {
            return res.json({ success: true, translatedText: cached.translatedText, cached: true, fallback: false });
        }
    } catch (e) { /* cache miss is non-fatal */ }

    // Graceful: no server key configured -> hand back the source text.
    if (!geminiService.hasConfiguredKeys()) {
        return res.json({ success: true, translatedText: text, cached: false, fallback: true });
    }

    const langName = LANG_NAMES[targetLang] || targetLang;
    const instruction = `Translate the following message to ${langName}. ` +
        'Respond with ONLY the translated text — no quotes, no explanations, no preamble.';
    try {
        const out = await geminiService.generateWithKeyPool(text, instruction);
        const translated = String(out || '').trim();
        if (!translated) throw new Error('empty translation');
        try {
            await Translation.create({
                textHash, targetLang, translatedText: translated,
                model: 'gemini', createdAt: Date.now()
            });
        } catch (e) { /* duplicate-key race is fine */ }
        return res.json({ success: true, translatedText: translated, cached: false, fallback: false });
    } catch (e) {
        // Graceful: any Gemini failure -> source text, never a 500.
        return res.json({ success: true, translatedText: text, cached: false, fallback: true });
    }
}

module.exports = {
    getInbox,
    sendMessage,
    adminSearchUsers,
    adminGetThread,
    adminSendMessage,
    adminBroadcastPreview,
    adminBroadcast,
    translateText
};
