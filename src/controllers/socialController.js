// PHASE E — Social app controller (blueprint E1/E2/E3/E4/E5).
//
// Security rules (same class as the October BYOK fix + Phase C):
// - Every endpoint derives identity from the VERIFIED JWT only
//   (req.user.username). No client-supplied username/body identity, ever.
// - Uploads: magic-byte whitelisted + re-encoded by socialUpload middleware;
//   multer 5MB transport cap; per-kind caps (photo 5MB / voice 2MB) rechecked.
// - Write endpoints are rate-limited 30/hour per user (in-memory, per
//   instance — same best-effort pattern as Phase C messageController).
// - Stories: server filters expired rows on every read.
// - Media filenames are server-randomized; client filename/MIME never trusted.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { connectToDatabase } = require('../config/db');
const User = require('../models/User');
const ChatThread = require('../models/ChatThread');
const SocialChatMessage = require('../models/SocialChatMessage');
const SocialPost = require('../models/SocialPost');
const Story = require('../models/Story');
const SocialContact = require('../models/SocialContact');
const { computeSocialTag } = require('../services/socialTagService');
const { processUpload } = require('../middleware/socialUpload');

const GROUP_MEMBER_CAP = 200;
const THREAD_LIMIT = 100;
const MESSAGE_LIMIT = 200;
const FEED_LIMIT = 50;
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

// ---- write rate limit: 30/hour per user (in-memory, per instance) --------
const WRITE_LIMIT = 30;
const WRITE_WINDOW_MS = 60 * 60 * 1000;
const writeBuckets = new Map(); // username -> [epochMs]

function writeRateLimited(username) {
    const now = Date.now();
    const kept = (writeBuckets.get(username) || []).filter(t => now - t < WRITE_WINDOW_MS);
    if (kept.length >= WRITE_LIMIT) {
        writeBuckets.set(username, kept);
        return true;
    }
    kept.push(now);
    writeBuckets.set(username, kept);
    if (writeBuckets.size > 5000) {
        for (const [k, v] of writeBuckets) {
            if (!v.length || now - v[v.length - 1] > WRITE_WINDOW_MS) writeBuckets.delete(k);
        }
    }
    return false;
}

function authedUsername(req) {
    const u = req.user && req.user.username;
    return typeof u === 'string' ? u.trim() : '';
}

// v91 (BugHunter backend F20): an invalid ObjectId in :id / :messageId used
// to throw a Mongoose CastError inside the handler — an unhandled rejection
// in an async route (no global error handler) that killed the serverless
// invocation with no JSON body. Validate up front; bad ids are a 400.
function validObjectId(value) {
    return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);
}
function badId(res) {
    return res.status(400).json({ success: false, error: 'Invalid id.' });
}

// v91 (BugHunter backend F20): async-handler wrapper — any uncaught throw
// inside a social handler becomes a 500 JSON response instead of an
// unhandled rejection that crashes the serverless invocation.
function wrap(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
        console.error('[Social]', fn.name, e && e.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: 'Server error.' });
    });
}

// username -> { tag } for a set of usernames (single query, no N+1).
async function tagMapFor(usernames) {
    const unique = [...new Set((usernames || []).filter(Boolean))];
    if (!unique.length) return {};
    const users = await User.find({ username: { $in: unique } })
        .select('username creditsEarned tag')
        .lean();
    const map = {};
    for (const u of users) {
        map[u.username] = { tag: computeSocialTag(u.creditsEarned) };
    }
    return map;
}

function dmKeyFor(a, b) {
    const pair = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
    return `dm:${pair[0]}:${pair[1]}`;
}

function threadTitle(thread, me) {
    if (thread.type === 'group') return thread.groupName || 'Group';
    const other = (thread.memberUsernames || []).find(u => u.toLowerCase() !== String(me).toLowerCase());
    return other || 'Chat';
}

// PHASE 1 — per-member watermark read that works for both Mongoose Map
// (live documents) and plain objects (lean results).
function watermarkOf(mapLike, username) {
    if (!mapLike || !username) return 0;
    if (typeof mapLike.get === 'function') return mapLike.get(username) || 0;
    return mapLike[username] || 0;
}

// PHASE 1 — canonical message serializer. Keeps every pre-Phase-1 field and
// ADDS clientMsgId / replyToId / fileName / fileSize / editedAt / deletedAt /
// reactions / deliveredTo / readBy. Tombstones (deletedAt set) expose empty
// text/media so all clients converge. deliveredTo/readBy are DERIVED from
// the thread's per-member watermarks; the sender always counts as both.
function serializeSocialMessage(m, thread, me, tags) {
    const deleted = m.deletedAt != null;
    const deliveredTo = [];
    const readBy = [];
    if (thread) {
        const senderKey = String(m.senderUsername || '').toLowerCase();
        for (const name of thread.memberUsernames || []) {
            const key = String(name).toLowerCase();
            if (key === senderKey) { deliveredTo.push(name); readBy.push(name); continue; }
            const dAt = watermarkOf(thread.membersLastDeliveredAt, name);
            const rAt = watermarkOf(thread.membersLastReadAt, name);
            if (dAt >= m.createdAt || rAt >= m.createdAt) deliveredTo.push(name);
            if (rAt >= m.createdAt) readBy.push(name);
        }
    }
    return {
        id: m._id.toString(),
        senderUsername: m.senderUsername,
        senderTag: tags ? ((tags[m.senderUsername] || {}).tag || computeSocialTag(0)) : computeSocialTag(0),
        kind: m.kind,
        text: deleted ? '' : (m.text || ''),
        mediaUrl: deleted ? '' : (m.mediaUrl || ''),
        durationSec: m.durationSec || 0,
        mine: m.senderUsername === me,
        clientMsgId: m.clientMsgId || null,
        replyToId: m.replyToId ? m.replyToId.toString() : null,
        fileName: m.fileName || '',
        fileSize: m.fileSize || 0,
        editedAt: m.editedAt || null,
        deletedAt: m.deletedAt || null,
        reactions: deleted ? [] : (m.reactions || []).map(r => ({ username: r.username, emoji: r.emoji })),
        deliveredTo,
        readBy,
        createdAt: m.createdAt
    };
}

// ---- threads ---------------------------------------------------------------

// GET /api/social/threads — my threads, newest first, with last-message preview.
async function listThreads(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const threads = await ChatThread.find({ memberUsernames: me })
        .sort({ lastMessageAt: -1 })
        .limit(THREAD_LIMIT)
        .lean();
    const threadIds = threads.map(t => t._id);
    const lastMsgs = await SocialChatMessage.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$threadId', msg: { $first: '$$ROOT' } } }
    ]);
    const lastByThread = {};
    for (const row of lastMsgs) lastByThread[row._id.toString()] = row.msg;
    const tags = await tagMapFor(threads.flatMap(t => t.memberUsernames || []));
    // PHASE 1 — unread counts from my read watermark (tombstones excluded;
    // count query only runs when the thread actually has newer activity).
    const unreadByThread = {};
    await Promise.all(threads.map(async (t) => {
        const myReadAt = watermarkOf(t.membersLastReadAt, me);
        unreadByThread[t._id.toString()] = { readAt: myReadAt, count: 0 };
        if ((t.lastMessageAt || 0) > myReadAt) {
            unreadByThread[t._id.toString()].count = await SocialChatMessage.countDocuments({
                threadId: t._id,
                createdAt: { $gt: myReadAt },
                deletedAt: null,
                senderUsername: { $ne: me }
            });
        }
    }));
    res.json({
        success: true,
        threads: threads.map(t => {
            const last = lastByThread[t._id.toString()];
            const unread = unreadByThread[t._id.toString()] || { readAt: 0, count: 0 };
            const lastDeleted = !!(last && last.deletedAt != null);
            return {
                id: t._id.toString(),
                type: t.type,
                title: threadTitle(t, me),
                groupName: t.groupName || '',
                memberCount: (t.memberUsernames || []).length,
                memberUsernames: t.memberUsernames || [],
                isGroupAdmin: (t.groupAdminUsernames || []).includes(me),
                lastMessageAt: t.lastMessageAt,
                lastReadAt: unread.readAt,
                unreadCount: unread.count,
                lastMessage: last ? {
                    kind: last.kind,
                    text: lastDeleted ? '' : (last.text || ''),
                    senderUsername: last.senderUsername,
                    senderTag: (tags[last.senderUsername] || {}).tag || computeSocialTag(0),
                    deleted: lastDeleted,
                    createdAt: last.createdAt
                } : null
            };
        })
    });
}

// POST /api/social/threads
//   DM:    { dm: { username } }
//   Group: { group: { name, memberUsernames: [] } }
async function createThread(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    const body = req.body || {};

    // ---- DM ----
    if (body.dm) {
        const target = String((body.dm && body.dm.username) || '').trim().toLowerCase();
        if (!target) return res.status(400).json({ success: false, error: 'Username required.' });
        if (target === me.toLowerCase()) {
            return res.status(400).json({ success: false, error: 'You cannot chat with yourself.' });
        }
        // 'admin' is a reserved pseudo-target (user<->admin DM); any other
        // username must be a real registered user.
        if (target !== 'admin') {
            const exists = await User.findOne({ username: target }).select('_id').lean();
            if (!exists) return res.status(404).json({ success: false, error: `No user found with username '${target}'.` });
        }
        const dmKey = dmKeyFor(me, target);
        const thread = await ChatThread.findOneAndUpdate(
            { dmKey },
            {
                $setOnInsert: {
                    type: 'dm',
                    dmKey,
                    memberUsernames: [me, target],
                    groupName: '',
                    groupAdminUsernames: [],
                    lastMessageAt: Date.now()
                }
            },
            { upsert: true, new: true }
        );
        return res.json({ success: true, thread: { id: thread._id.toString(), type: 'dm', title: threadTitle(thread, me) } });
    }

    // ---- Group ----
    if (body.group) {
        const name = String(body.group.name || '').trim().slice(0, 80);
        if (!name) return res.status(400).json({ success: false, error: 'Group name required.' });
        const rawMembers = Array.isArray(body.group.memberUsernames) ? body.group.memberUsernames : [];
        const cleaned = [...new Set(rawMembers.map(u => String(u || '').trim().toLowerCase()).filter(Boolean))];
        const withoutMe = cleaned.filter(u => u !== me.toLowerCase());
        const members = [me, ...withoutMe];
        if (members.length > GROUP_MEMBER_CAP) {
            return res.status(400).json({ success: false, error: `Groups are capped at ${GROUP_MEMBER_CAP} members.` });
        }
        // Every member must be a real user ('admin' allowed as pseudo-user).
        const nonAdmin = members.filter(u => u !== 'admin');
        if (nonAdmin.length) {
            const found = await User.find({ username: { $in: nonAdmin } }).select('username').lean();
            const foundSet = new Set(found.map(u => u.username));
            const missing = nonAdmin.filter(u => !foundSet.has(u));
            if (missing.length) {
                return res.status(404).json({ success: false, error: `No user found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}.` });
            }
        }
        const thread = await ChatThread.create({
            type: 'group',
            dmKey: null,
            memberUsernames: members,
            groupName: name,
            groupAdminUsernames: [me],
            lastMessageAt: Date.now()
        });
        return res.json({
            success: true,
            thread: { id: thread._id.toString(), type: 'group', title: name, memberCount: members.length }
        });
    }

    return res.status(400).json({ success: false, error: 'Send { dm: { username } } or { group: { name, memberUsernames } }.' });
}

// GET /api/social/threads/:id/messages?since=
async function getMessages(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!validObjectId(req.params.id)) return badId(res);
    const thread = await ChatThread.findById(req.params.id).lean();
    if (!thread || !(thread.memberUsernames || []).includes(me)) {
        return res.status(404).json({ success: false, error: 'Chat not found.' });
    }
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const msgs = await SocialChatMessage.find({
        threadId: thread._id,
        createdAt: { $gt: since }
    }).sort({ createdAt: 1 }).limit(MESSAGE_LIMIT).lean();
    const tags = await tagMapFor(msgs.map(m => m.senderUsername));
    // PHASE 1 — delivery watermark: this fetch delivered the returned
    // messages to me. Stamp only up to the newest RETURNED message.
    const newestReturned = msgs.length ? msgs[msgs.length - 1].createdAt : 0;
    if (newestReturned > 0 && newestReturned > watermarkOf(thread.membersLastDeliveredAt, me)) {
        await ChatThread.updateOne(
            { _id: thread._id },
            { $set: { [`membersLastDeliveredAt.${me}`]: newestReturned } }
        );
        if (!thread.membersLastDeliveredAt) thread.membersLastDeliveredAt = {};
        thread.membersLastDeliveredAt[me] = newestReturned;
    }
    res.json({
        success: true,
        thread: { id: thread._id.toString(), type: thread.type, title: threadTitle(thread, me), memberUsernames: thread.memberUsernames || [] },
        messages: msgs.map(m => serializeSocialMessage(m, thread, me, tags))
    });
}

// POST /api/social/threads/:id/messages (multipart)
// Fields: kind=text|photo|voice, text (optional for text/photo caption),
// durationSec (voice). File field name: 'file'.
async function sendMessage(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    if (!validObjectId(req.params.id)) return badId(res);
    const thread = await ChatThread.findById(req.params.id);
    if (!thread || !(thread.memberUsernames || []).includes(me)) {
        return res.status(404).json({ success: false, error: 'Chat not found.' });
    }
    // PHASE 1 — idempotent send: a clientMsgId that already landed returns
    // the ORIGINAL message (deduplicated) — retries never duplicate. The
    // check runs BEFORE any upload processing so replays cost nothing.
    const clientMsgIdRaw = String((req.body && req.body.clientMsgId) || '').trim();
    const clientMsgId = clientMsgIdRaw ? clientMsgIdRaw.slice(0, 64) : null;
    if (clientMsgId) {
        const existing = await SocialChatMessage.findOne({ threadId: thread._id, clientMsgId }).lean();
        if (existing) {
            const tags = await tagMapFor([existing.senderUsername]);
            return res.json({ success: true, deduplicated: true, message: serializeSocialMessage(existing, thread, me, tags) });
        }
    }
    const kind = String((req.body && req.body.kind) || 'text');
    // v91 (BugHunter backend F20): 'document' removed from the allowlist —
    // the app has no document-sending UI and processUpload has no document
    // branch, so a 'document' message would carry an empty mediaUrl and a
    // caller-supplied fileName with no stored file. Stored documents (old
    // rows) still read fine; new sends are text/photo/voice only.
    if (!['text', 'photo', 'voice'].includes(kind)) {
        return res.status(400).json({ success: false, error: 'kind must be text, photo, or voice.' });
    }
    let mediaUrl = '';
    let durationSec = 0;
    let fileName = '';
    let fileSize = 0;
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (kind === 'text') {
        if (!text) return res.status(400).json({ success: false, error: 'Message text required.' });
    } else {
        try {
            const saved = await processUpload(req.file, kind);
            mediaUrl = saved.url;
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
        if (kind === 'voice') {
            durationSec = Math.max(0, Math.min(600, parseInt((req.body && req.body.durationSec) || '0', 10) || 0));
        }
    }
    // PHASE 1 — reply target must exist in THIS thread and not be deleted.
    let replyToId = null;
    const replyToRaw = String((req.body && req.body.replyToId) || '').trim();
    if (replyToRaw) {
        const target = await SocialChatMessage.findOne({ _id: replyToRaw, threadId: thread._id })
            .select('_id deletedAt').lean().catch(() => null);
        if (!target) return res.status(400).json({ success: false, error: 'Reply target not found in this chat.' });
        if (target.deletedAt) return res.status(400).json({ success: false, error: 'Cannot reply to a deleted message.' });
        replyToId = target._id;
    }
    let msg;
    try {
        msg = await SocialChatMessage.create({
            threadId: thread._id,
            senderUsername: me,
            kind,
            text,
            mediaUrl,
            durationSec,
            clientMsgId,
            replyToId,
            fileName,
            fileSize,
            createdAt: Date.now()
        });
    } catch (dupErr) {
        // Unique-index race: a concurrent replay created it first.
        if (clientMsgId && dupErr && dupErr.code === 11000) {
            const existing = await SocialChatMessage.findOne({ threadId: thread._id, clientMsgId }).lean();
            if (existing) {
                const tags = await tagMapFor([existing.senderUsername]);
                return res.json({ success: true, deduplicated: true, message: serializeSocialMessage(existing, thread, me, tags) });
            }
        }
        console.error('[Social] sendMessage create failed', dupErr && dupErr.message);
        return res.status(500).json({ success: false, error: 'Could not send message.' });
    }
    // v91 (BugHunter backend F20): $max — a slow older message must never
    // drag lastMessageAt backwards over a newer message's stamp.
    await ChatThread.updateOne({ _id: thread._id }, { $max: { lastMessageAt: msg.createdAt } });
    const tags = await tagMapFor([me]);
    res.json({
        success: true,
        deduplicated: false,
        message: serializeSocialMessage(msg.toObject(), thread, me, tags)
    });
}

// POST /api/social/groups/:id/members { action: 'add'|'remove', usernames: [] }
// Group admins only. WhatsApp-style: creator/admin can remove members.
async function updateGroupMembers(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    if (!validObjectId(req.params.id)) return badId(res);
    const thread = await ChatThread.findById(req.params.id);
    if (!thread || thread.type !== 'group') {
        return res.status(404).json({ success: false, error: 'Group not found.' });
    }
    if (!(thread.groupAdminUsernames || []).includes(me)) {
        return res.status(403).json({ success: false, error: 'Only group admins can manage members.' });
    }
    const action = String((req.body && req.body.action) || '');
    const raw = Array.isArray(req.body && req.body.usernames) ? req.body.usernames : [];
    const usernames = [...new Set(raw.map(u => String(u || '').trim().toLowerCase()).filter(Boolean))];
    if (!['add', 'remove'].includes(action) || !usernames.length) {
        return res.status(400).json({ success: false, error: 'Send { action: "add"|"remove", usernames: [...] }.' });
    }
    if (action === 'add') {
        const newcomers = usernames.filter(u => !(thread.memberUsernames || []).includes(u));
        if (thread.memberUsernames.length + newcomers.length > GROUP_MEMBER_CAP) {
            return res.status(400).json({ success: false, error: `Groups are capped at ${GROUP_MEMBER_CAP} members.` });
        }
        const nonAdmin = newcomers.filter(u => u !== 'admin');
        if (nonAdmin.length) {
            const found = await User.find({ username: { $in: nonAdmin } }).select('username').lean();
            const foundSet = new Set(found.map(u => u.username));
            const missing = nonAdmin.filter(u => !foundSet.has(u));
            if (missing.length) {
                return res.status(404).json({ success: false, error: `No user found: ${missing.slice(0, 3).join(', ')}.` });
            }
        }
        thread.memberUsernames = [...thread.memberUsernames, ...newcomers];
    } else {
        // remove: cannot remove yourself via this path, cannot remove the
        // last remaining admin (group would be admin-less).
        const removable = usernames.filter(u => u !== me);
        for (const u of removable) {
            const idx = (thread.memberUsernames || []).indexOf(u);
            if (idx >= 0) thread.memberUsernames.splice(idx, 1);
            const aidx = (thread.groupAdminUsernames || []).indexOf(u);
            if (aidx >= 0) {
                if (thread.groupAdminUsernames.length <= 1) {
                    return res.status(400).json({ success: false, error: 'Cannot remove the last group admin.' });
                }
                thread.groupAdminUsernames.splice(aidx, 1);
            }
        }
        if (!thread.memberUsernames.length) {
            return res.status(400).json({ success: false, error: 'A group cannot be left empty.' });
        }
    }
    await thread.save();
    res.json({
        success: true,
        memberCount: thread.memberUsernames.length,
        memberUsernames: thread.memberUsernames,
        groupAdminUsernames: thread.groupAdminUsernames
    });
}

// ---- PHASE 1: read state, edit/delete, reactions, search -------------------

async function loadMemberThread(req, res) {
    const me = authedUsername(req);
    if (!me) { res.status(401).json({ success: false, error: 'Authentication required.' }); return null; }
    if (!validObjectId(req.params.id)) { badId(res); return null; }
    const thread = await ChatThread.findById(req.params.id);
    if (!thread || !(thread.memberUsernames || []).includes(me)) {
        res.status(404).json({ success: false, error: 'Chat not found.' });
        return null;
    }
    return { thread, me };
}

// POST /api/social/threads/:id/read { upTo? } — my read watermark (implies delivered).
async function markThreadRead(req, res) {
    await connectToDatabase();
    const ctx = await loadMemberThread(req, res);
    if (!ctx) return;
    const { thread, me } = ctx;
    const upToRaw = parseInt((req.body && req.body.upTo) || '0', 10) || 0;
    const upTo = Math.min(upToRaw > 0 ? upToRaw : Date.now(), Date.now());
    if (upTo > watermarkOf(thread.membersLastReadAt, me)) thread.membersLastReadAt.set(me, upTo);
    if (upTo > watermarkOf(thread.membersLastDeliveredAt, me)) thread.membersLastDeliveredAt.set(me, upTo);
    await thread.save();
    res.json({ success: true, readUpTo: watermarkOf(thread.membersLastReadAt, me) });
}

// PUT /api/social/threads/:id/messages/:messageId { text } — sender-only,
// text kind only, never on a tombstone. No old text retained (editedAt only).
async function editMessage(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    const ctx = await loadMemberThread(req, res);
    if (!ctx) return;
    const { thread } = ctx;
    const msg = await SocialChatMessage.findOne({ _id: req.params.messageId, threadId: thread._id }).catch(() => null);
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });
    if (msg.senderUsername !== me) return res.status(403).json({ success: false, error: 'You can only edit your own messages.' });
    if (msg.deletedAt) return res.status(400).json({ success: false, error: 'Message is deleted.' });
    if (msg.kind !== 'text') return res.status(400).json({ success: false, error: 'Only text messages can be edited.' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ success: false, error: 'Message text required.' });
    msg.text = text;
    msg.editedAt = Date.now();
    await msg.save();
    const tags = await tagMapFor([msg.senderUsername]);
    res.json({ success: true, message: serializeSocialMessage(msg.toObject(), thread, me, tags) });
}

// DELETE /api/social/threads/:id/messages/:messageId — tombstone for
// everyone (row stays, content blanked). Own messages anytime; group
// admins may also delete others' messages in their group.
async function deleteMessage(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    const ctx = await loadMemberThread(req, res);
    if (!ctx) return;
    const { thread } = ctx;
    const msg = await SocialChatMessage.findOne({ _id: req.params.messageId, threadId: thread._id }).catch(() => null);
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });
    const isSender = msg.senderUsername === me;
    const isGroupAdmin = thread.type === 'group' && (thread.groupAdminUsernames || []).includes(me);
    if (!isSender && !isGroupAdmin) {
        return res.status(403).json({ success: false, error: 'You can only delete your own messages.' });
    }
    if (!msg.deletedAt) {
        msg.deletedAt = Date.now();
        msg.text = '';
        msg.mediaUrl = '';
        msg.reactions = [];
        await msg.save();
    }
    const tags = await tagMapFor([msg.senderUsername]);
    res.json({ success: true, message: serializeSocialMessage(msg.toObject(), thread, me, tags) });
}

// PUT /api/social/threads/:id/messages/:messageId/reaction { emoji|null }
// One reaction per user per message; same emoji again (or null) removes it.
async function reactMessage(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    const ctx = await loadMemberThread(req, res);
    if (!ctx) return;
    const { thread } = ctx;
    const msg = await SocialChatMessage.findOne({ _id: req.params.messageId, threadId: thread._id }).catch(() => null);
    if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });
    if (msg.deletedAt) return res.status(400).json({ success: false, error: 'Message is deleted.' });
    const raw = req.body ? req.body.emoji : null;
    const emoji = raw == null ? null : String(raw).trim().slice(0, 16);
    const mineIdx = (msg.reactions || []).findIndex(r => r.username === me);
    if (!emoji || (mineIdx >= 0 && msg.reactions[mineIdx].emoji === emoji)) {
        msg.reactions = (msg.reactions || []).filter(r => r.username !== me);
    } else if (mineIdx >= 0) {
        msg.reactions[mineIdx].emoji = emoji;
        msg.markModified('reactions');
    } else {
        msg.reactions = [...(msg.reactions || []), { username: me, emoji }];
    }
    await msg.save();
    const tags = await tagMapFor([msg.senderUsername]);
    res.json({ success: true, message: serializeSocialMessage(msg.toObject(), thread, me, tags) });
}

// GET /api/social/threads/:id/search?q= — keyword search inside one thread.
async function searchInThread(req, res) {
    await connectToDatabase();
    const ctx = await loadMemberThread(req, res);
    if (!ctx) return;
    const { thread, me } = ctx;
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, messages: [] });
    const rows = await SocialChatMessage.find({
        threadId: thread._id,
        kind: 'text',
        deletedAt: null,
        text: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }).sort({ createdAt: -1 }).limit(100).lean();
    const tags = await tagMapFor(rows.map(m => m.senderUsername));
    res.json({ success: true, messages: rows.map(m => serializeSocialMessage(m, thread, me, tags)) });
}

// GET /api/social/search?q= — keyword search across ALL my threads.
async function searchGlobal(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, results: [] });
    const myThreads = await ChatThread.find({ memberUsernames: me }).select('_id').lean();
    const ids = myThreads.map(t => t._id);
    if (!ids.length) return res.json({ success: true, results: [] });
    const rows = await SocialChatMessage.find({
        threadId: { $in: ids },
        kind: 'text',
        deletedAt: null,
        text: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }).sort({ createdAt: -1 }).limit(100).lean();
    const tags = await tagMapFor(rows.map(m => m.senderUsername));
    res.json({
        success: true,
        results: rows.map(m => ({
            threadId: m.threadId.toString(),
            message: serializeSocialMessage(m, null, me, tags)
        }))
    });
}

// ---- feed / stories / contacts --------------------------------------------

// GET /api/social/feed — latest posts with author tags.
async function getFeed(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const posts = await SocialPost.find({}).sort({ createdAt: -1 }).limit(FEED_LIMIT).lean();
    const tags = await tagMapFor(posts.map(p => p.username));
    res.json({
        success: true,
        posts: posts.map(p => ({
            id: p._id.toString(),
            username: p.username,
            authorTag: (tags[p.username] || {}).tag || computeSocialTag(0),
            text: p.text || '',
            photoUrl: p.photoUrl || '',
            createdAt: p.createdAt
        }))
    });
}

// POST /api/social/feed (multipart) — text + optional single photo.
async function createPost(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are posting too quickly. Please wait a bit and try again.' });
    }
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    let photoUrl = '';
    if (req.file) {
        try {
            const saved = await processUpload(req.file, 'photo');
            photoUrl = saved.url;
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
    }
    if (!text && !photoUrl) {
        return res.status(400).json({ success: false, error: 'Write something or attach a photo.' });
    }
    const post = await SocialPost.create({ username: me, text, photoUrl, createdAt: Date.now() });
    res.json({
        success: true,
        post: {
            id: post._id.toString(),
            username: me,
            authorTag: computeSocialTag((await User.findOne({ username: me }).select('creditsEarned').lean() || {}).creditsEarned),
            text,
            photoUrl,
            createdAt: post.createdAt
        }
    });
}

// POST /api/social/stories (multipart) — photo story, 24h expiry.
async function createStory(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are posting too quickly. Please wait a bit and try again.' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'A photo is required for a story.' });
    let saved;
    try {
        saved = await processUpload(req.file, 'photo');
    } catch (e) {
        return res.status(400).json({ success: false, error: e.message });
    }
    const now = Date.now();
    const story = await Story.create({
        username: me,
        photoUrl: saved.url,
        expiresAt: now + STORY_TTL_MS,
        createdAt: now
    });
    res.json({
        success: true,
        story: { id: story._id.toString(), username: me, photoUrl: saved.url, expiresAt: story.expiresAt, createdAt: now }
    });
}

// GET /api/social/stories/feed — live stories only (server filters expired).
async function getStoriesFeed(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const now = Date.now();
    const stories = await Story.find({ expiresAt: { $gt: now } })
        .sort({ createdAt: -1 })
        .limit(FEED_LIMIT)
        .lean();
    // Group by user, newest first per user.
    const byUser = {};
    for (const s of stories) {
        if (!byUser[s.username]) byUser[s.username] = [];
        byUser[s.username].push({
            id: s._id.toString(),
            photoUrl: s.photoUrl,
            expiresAt: s.expiresAt,
            createdAt: s.createdAt
        });
    }
    res.json({
        success: true,
        stories: Object.keys(byUser).map(username => ({ username, items: byUser[username] }))
    });
}

// GET /api/social/contacts — my contacts with custom names/labels.
async function listContacts(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const contacts = await SocialContact.find({ ownerUsername: me }).sort({ createdAt: -1 }).lean();
    const tags = await tagMapFor(contacts.map(c => c.contactUsername));
    res.json({
        success: true,
        contacts: contacts.map(c => ({
            id: c._id.toString(),
            contactUsername: c.contactUsername,
            customName: c.customName || '',
            label: c.label || '',
            tag: (tags[c.contactUsername] || {}).tag || computeSocialTag(0)
        }))
    });
}

// POST /api/social/contacts { contactUsername, customName?, label? }
async function addContact(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (writeRateLimited(me)) {
        return res.status(429).json({ success: false, error: 'You are sending too quickly. Please wait a bit and try again.' });
    }
    const contactUsername = String((req.body && req.body.contactUsername) || '').trim().toLowerCase();
    if (!contactUsername) return res.status(400).json({ success: false, error: 'contactUsername required.' });
    if (contactUsername === me.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'You cannot add yourself as a contact.' });
    }
    if (contactUsername !== 'admin') {
        const exists = await User.findOne({ username: contactUsername }).select('_id').lean();
        if (!exists) return res.status(404).json({ success: false, error: `No user found with username '${contactUsername}'.` });
    }
    const customName = String((req.body && req.body.customName) || '').trim().slice(0, 60);
    const label = String((req.body && req.body.label) || '').trim().slice(0, 30);
    const contact = await SocialContact.findOneAndUpdate(
        { ownerUsername: me, contactUsername },
        { $setOnInsert: { ownerUsername: me, contactUsername, createdAt: Date.now() }, $set: { customName, label } },
        { upsert: true, new: true }
    );
    res.json({
        success: true,
        contact: {
            id: contact._id.toString(),
            contactUsername,
            customName: contact.customName || '',
            label: contact.label || ''
        }
    });
}

// PUT /api/social/contacts/:id { customName?, label? } — owner only.
async function updateContact(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!validObjectId(req.params.id)) return badId(res);
    const contact = await SocialContact.findOne({ _id: req.params.id, ownerUsername: me });
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found.' });
    if (req.body && req.body.customName !== undefined) {
        contact.customName = String(req.body.customName || '').trim().slice(0, 60);
    }
    if (req.body && req.body.label !== undefined) {
        contact.label = String(req.body.label || '').trim().slice(0, 30);
    }
    await contact.save();
    res.json({
        success: true,
        contact: {
            id: contact._id.toString(),
            contactUsername: contact.contactUsername,
            customName: contact.customName || '',
            label: contact.label || ''
        }
    });
}

// ---- fcm token (E5: store only; FCM send is a later phase) ------------------

// POST /api/user/fcm-token { fcmToken } — identity from verified JWT only.
async function saveFcmToken(req, res) {
    await connectToDatabase();
    const me = authedUsername(req);
    if (!me) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const token = String((req.body && req.body.fcmToken) || '').trim().slice(0, 512);
    await User.updateOne({ username: me }, { $set: { fcmToken: token } });
    res.json({ success: true, stored: !!token });
}

module.exports = {
    listThreads: wrap(listThreads),
    createThread: wrap(createThread),
    getMessages: wrap(getMessages),
    sendMessage: wrap(sendMessage),
    markThreadRead: wrap(markThreadRead),
    editMessage: wrap(editMessage),
    deleteMessage: wrap(deleteMessage),
    reactMessage: wrap(reactMessage),
    searchInThread: wrap(searchInThread),
    searchGlobal: wrap(searchGlobal),
    updateGroupMembers: wrap(updateGroupMembers),
    getFeed: wrap(getFeed),
    createPost: wrap(createPost),
    createStory: wrap(createStory),
    getStoriesFeed: wrap(getStoriesFeed),
    listContacts: wrap(listContacts),
    addContact: wrap(addContact),
    updateContact: wrap(updateContact),
    saveFcmToken: wrap(saveFcmToken)
};
