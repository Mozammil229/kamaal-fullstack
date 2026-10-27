const ChatMessage = require('../models/ChatMessage');
const SupportMessage = require('../models/SupportMessage');
const Poll = require('../models/Poll');
const User = require('../models/User');
const { connectToDatabase } = require('../config/db');

// Get Chat Messages
async function getChatMessages(req, res) {
    await connectToDatabase();
    const channel = req.query.channel || 'global';
    // v91 (BugHunter backend F17): the limit was uncapped — ?limit=1000000
    // returned a huge payload. Clamp to 200.
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 75));

    try {
        let filter = {};
        if (channel.startsWith('@')) {
            const target = channel.slice(1);
            // SECURITY FIX (#10): DM reader is the verified user — the old
            // code took it from the query string, leaking anyone's DMs.
            const current = req.user?.username || '';
            filter = {
                $or: [
                    { sender: current, recipient: target },
                    { sender: target, recipient: current }
                ]
            };
        } else {
            filter = { channel: channel };
        }

        const rawMessages = await ChatMessage.find(filter)
            .sort({ timestamp: -1 })
            .limit(limit)
            .lean();

        const messages = rawMessages.reverse().map(m => ({
            id: m._id.toString(),
            channel: m.channel,
            sender: m.isOwner ? '👑 Owner' : m.sender,
            recipient: m.recipient,
            text: m.text,
            isOwner: m.isOwner,
            pinned: m.pinned || false,
            reactions: m.reactions || {},
            timestamp: m.timestamp
        }));

        return res.json({ success: true, channel, messages });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Send Chat Message (JWT-authenticated; sender is ALWAYS the verified user)
async function sendChatMessage(req, res) {
    await connectToDatabase();
    // SECURITY FIX (#5): sender comes from the verified JWT only. The old code
    // took `sender` from the body, so anyone could post as "owner"/"admin".
    // Body `sender` is ignored entirely.
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });
    const { recipient, text, channel } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Text required.' });
    // v91 (BugHunter backend F18): messages were stored unbounded (up to the
    // 15MB body limit). Cap at 4000 chars.
    if (String(text).length > 4000) return res.status(400).json({ success: false, error: 'Message is too long (max 4000 characters).' });

    const cleanSender = String(username).trim();
    const cleanText = String(text).trim();

    try {
        const user = await User.findOne({ username: cleanSender });
        if (user && user.status === 'banned') {
            return res.status(403).json({ success: false, error: 'You are banned from sending messages.' });
        }
        // Only real admins get the Owner badge — derived from the DB role,
        // never from a client-supplied name.
        const isOwner = user?.role === 'admin';

        const newMsg = await ChatMessage.create({
            channel: channel || 'global',
            sender: isOwner ? '👑 Owner' : cleanSender,
            recipient: recipient || 'global',
            text: cleanText,
            isOwner: isOwner,
            timestamp: Date.now()
        });

        return res.json({ success: true, message: 'Sent', id: newMsg._id });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// React to Chat Message (BH-3 FIX: authenticated; username from JWT only —
// the old body.username let anyone react-as / ballot-stuff any user.)
async function reactChatMessage(req, res) {
    await connectToDatabase();
    const { messageId, emoji } = req.body;
    const username = req.user?.username;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!messageId || !emoji) return res.status(400).json({ success: false, error: 'Message ID and emoji required.' });
    // v91 (BugHunter backend F18): emoji was stored unbounded. One emoji only.
    const cleanEmoji = String(emoji).trim();
    if (cleanEmoji.length === 0 || cleanEmoji.length > 16 || cleanEmoji.includes('.') || cleanEmoji.includes('$')) {
        return res.status(400).json({ success: false, error: 'Invalid emoji.' });
    }

    try {
        const msg = await ChatMessage.findById(messageId);
        if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });

        // v91 (BugHunter DB P2-19): the old read-modify-save race lost
        // concurrent reacts. Toggle atomically: add if absent, pull if present.
        const path = `reactions.${cleanEmoji}`;
        const added = await ChatMessage.findOneAndUpdate(
            { _id: messageId, [path]: { $ne: username } },
            { $addToSet: { [path]: username } },
            { new: true }
        );
        let updated = added;
        if (!added) {
            updated = await ChatMessage.findOneAndUpdate(
                { _id: messageId },
                { $pull: { [path]: username } },
                { new: true }
            );
        }
        if (!updated) return res.status(404).json({ success: false, error: 'Message not found.' });
        return res.json({ success: true, reactions: updated.reactions });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Get Support Messages (BH-4 FIX: authenticated; scoped to the JWT user.
// The old ?username= fallback let anyone read any user's support thread.)
async function getSupportMessages(req, res) {
    await connectToDatabase();
    const username = req.user?.username || '';

    try {
        // v91 (BugHunter backend F5/F23): the old filter had a bare
        // `{ isAdmin: true }` clause — EVERY admin message (payment-proof
        // confirmations with TxIDs, every admin DM) was readable by ANY
        // logged-in user, and `?deviceId=<victim>` read that device's thread.
        // Now: only the caller's own messages, DMs addressed to them
        // (recipientUsername, plus legacy rows where deviceId holds the
        // username), their own device's thread, and global broadcasts.
        const me = await User.findOne({ username }).select('deviceId').lean();
        const myDevice = me?.deviceId || '';
        const or = [
            { sender: username },
            { recipientUsername: username },
            { broadcast: true }
        ];
        if (myDevice) or.push({ deviceId: myDevice });
        // Legacy admin-DM rows stored the recipient username in deviceId —
        // match them only when they are admin messages, so a client cannot
        // inject into another user's thread via a crafted deviceId.
        or.push({ deviceId: username, isAdmin: true });
        const raw = await SupportMessage.find({ $or: or }).sort({ timestamp: -1 }).limit(50).lean();

        const messages = raw.reverse().map(m => ({
            id: m._id.toString(),
            sender: m.isAdmin ? '👑 Owner Desk' : m.sender,
            message: m.message,
            isAdmin: m.isAdmin,
            timestamp: m.timestamp
        }));

        return res.json({ success: true, messages });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Send Support Message (BH-4 FIX: authenticated; sender from JWT only.)
async function sendSupportMessage(req, res) {
    await connectToDatabase();
    const { deviceId, message } = req.body;
    const sender = req.user?.username || 'User';
    if (!message) return res.status(400).json({ success: false, error: 'Message required.' });
    if (String(message).length > 4000) return res.status(400).json({ success: false, error: 'Message is too long (max 4000 characters).' });

    try {
        const msg = await SupportMessage.create({
            sender: sender,
            deviceId: deviceId || '',
            message: String(message).trim(),
            isAdmin: false,
            timestamp: Date.now()
        });
        // v91 (BugHunter frontback F4): the old response
        // `{success, message:'Sent to Owner Desk', id}` could never parse as
        // the app's SupportMessageDto (non-null `sender` missing) — every
        // send threw inside Moshi and was masked by a fabricated local
        // success. Return the full DTO-shaped object with the real id.
        return res.json({
            success: true,
            id: msg._id,
            sender: msg.sender,
            message: msg.message,
            isAdmin: false,
            timestamp: msg.timestamp
        });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Get Active Poll
async function getActivePoll(req, res) {
    await connectToDatabase();
    try {
        const poll = await Poll.findOne({ active: true }).sort({ createdAt: -1 });
        return res.json({ success: true, poll });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Vote in Poll
async function votePoll(req, res) {
    await connectToDatabase();
    // SECURITY FIX (#11): voter is the verified user, not a body field —
    // otherwise anyone could stuff the ballot as someone else.
    const username = req.user?.username;
    const { pollId, optionIndex } = req.body;
    if (!username) return res.status(401).json({ success: false, error: 'Authentication required.' });
    if (!pollId || optionIndex == null) {
        return res.status(400).json({ success: false, error: 'Missing vote data.' });
    }

    try {
        const poll = await Poll.findById(pollId);
        if (!poll) return res.status(404).json({ success: false, error: 'Poll not found.' });

        // v91 (BugHunter backend F19 / DB P2-18): optionIndex was unvalidated
        // (out-of-range recorded a voter with no vote counted; non-numeric
        // 500d) and the has-voted check + push was read-modify-write.
        const idx = Number(optionIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= (poll.options?.length || 0)) {
            return res.status(400).json({ success: false, error: 'Invalid poll option.' });
        }

        // Atomic voter claim + vote increment: a concurrent second vote for
        // the same user cannot pass the 'voters.username: $ne' guard.
        const updated = await Poll.findOneAndUpdate(
            { _id: pollId, 'voters.username': { $ne: username } },
            {
                $push: { voters: { username, optionIndex: idx } },
                $inc: { [`options.${idx}.votes`]: 1 }
            },
            { new: true }
        );
        if (!updated) {
            return res.status(400).json({ success: false, error: 'You have already voted in this poll.' });
        }
        return res.json({ success: true, poll: updated });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

module.exports = {
    getChatMessages,
    sendChatMessage,
    reactChatMessage,
    getSupportMessages,
    sendSupportMessage,
    getActivePoll,
    votePoll
};
