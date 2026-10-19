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
    res.json({
        success: true,
        threads: threads.map(t => {
            const last = lastByThread[t._id.toString()];
            return {
                id: t._id.toString(),
                type: t.type,
                title: threadTitle(t, me),
                groupName: t.groupName || '',
                memberCount: (t.memberUsernames || []).length,
                memberUsernames: t.memberUsernames || [],
                isGroupAdmin: (t.groupAdminUsernames || []).includes(me),
                lastMessageAt: t.lastMessageAt,
                lastMessage: last ? {
                    kind: last.kind,
                    text: last.text || '',
                    senderUsername: last.senderUsername,
                    senderTag: (tags[last.senderUsername] || {}).tag || computeSocialTag(0),
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
    res.json({
        success: true,
        thread: { id: thread._id.toString(), type: thread.type, title: threadTitle(thread, me), memberUsernames: thread.memberUsernames || [] },
        messages: msgs.map(m => ({
            id: m._id.toString(),
            senderUsername: m.senderUsername,
            senderTag: (tags[m.senderUsername] || {}).tag || computeSocialTag(0),
            kind: m.kind,
            text: m.text || '',
            mediaUrl: m.mediaUrl || '',
            durationSec: m.durationSec || 0,
            mine: m.senderUsername === me,
            createdAt: m.createdAt
        }))
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
    const thread = await ChatThread.findById(req.params.id);
    if (!thread || !(thread.memberUsernames || []).includes(me)) {
        return res.status(404).json({ success: false, error: 'Chat not found.' });
    }
    const kind = String((req.body && req.body.kind) || 'text');
    if (!['text', 'photo', 'voice'].includes(kind)) {
        return res.status(400).json({ success: false, error: 'kind must be text, photo, or voice.' });
    }
    let mediaUrl = '';
    let durationSec = 0;
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (kind === 'text') {
        if (!text) return res.status(400).json({ success: false, error: 'Message text required.' });
    } else {
        try {
            const saved = await processUpload(req.file, kind === 'photo' ? 'photo' : 'voice');
            mediaUrl = saved.url;
        } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
        }
        if (kind === 'voice') {
            durationSec = Math.max(0, Math.min(600, parseInt((req.body && req.body.durationSec) || '0', 10) || 0));
        }
    }
    const msg = await SocialChatMessage.create({
        threadId: thread._id,
        senderUsername: me,
        kind,
        text,
        mediaUrl,
        durationSec,
        createdAt: Date.now()
    });
    thread.lastMessageAt = Date.now();
    await thread.save();
    res.json({
        success: true,
        message: {
            id: msg._id.toString(),
            senderUsername: me,
            kind,
            text,
            mediaUrl,
            durationSec,
            mine: true,
            createdAt: msg.createdAt
        }
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
    listThreads,
    createThread,
    getMessages,
    sendMessage,
    updateGroupMembers,
    getFeed,
    createPost,
    createStory,
    getStoriesFeed,
    listContacts,
    addContact,
    updateContact,
    saveFcmToken
};
