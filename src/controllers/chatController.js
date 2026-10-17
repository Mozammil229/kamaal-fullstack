const ChatMessage = require('../models/ChatMessage');
const SupportMessage = require('../models/SupportMessage');
const Poll = require('../models/Poll');
const User = require('../models/User');
const { connectToDatabase } = require('../config/db');

// Get Chat Messages
async function getChatMessages(req, res) {
    await connectToDatabase();
    const channel = req.query.channel || 'global';
    const limit = parseInt(req.query.limit) || 75;

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

    try {
        const msg = await ChatMessage.findById(messageId);
        if (!msg) return res.status(404).json({ success: false, error: 'Message not found.' });

        const current = msg.reactions?.get(emoji) || [];
        if (current.includes(username)) {
            msg.reactions.set(emoji, current.filter(u => u !== username));
        } else {
            current.push(username);
            msg.reactions.set(emoji, current);
        }
        await msg.save();
        return res.json({ success: true, reactions: msg.reactions });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
}

// Get Support Messages (BH-4 FIX: authenticated; scoped to the JWT user.
// The old ?username= fallback let anyone read any user's support thread.)
async function getSupportMessages(req, res) {
    await connectToDatabase();
    const username = req.user?.username || '';
    const deviceId = req.query.deviceId || '';

    try {
        const raw = await SupportMessage.find({
            $or: [
                { sender: username },
                { deviceId: deviceId },
                { isAdmin: true }
            ]
        }).sort({ timestamp: -1 }).limit(50).lean();

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

    try {
        const msg = await SupportMessage.create({
            sender: sender,
            deviceId: deviceId || '',
            message: String(message).trim(),
            isAdmin: false,
            timestamp: Date.now()
        });
        return res.json({ success: true, message: 'Sent to Owner Desk', id: msg._id });
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

        const hasVoted = poll.voters.some(v => v.username === username);
        if (hasVoted) {
            return res.status(400).json({ success: false, error: 'You have already voted in this poll.' });
        }

        poll.voters.push({ username, optionIndex });
        if (poll.options[optionIndex]) {
            poll.options[optionIndex].votes = (poll.options[optionIndex].votes || 0) + 1;
        }
        await poll.save();
        return res.json({ success: true, poll });
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
