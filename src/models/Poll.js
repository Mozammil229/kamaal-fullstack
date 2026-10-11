const mongoose = require('mongoose');

const PollSchema = new mongoose.Schema({
    question: { type: String, required: true },
    options: [{ text: String, votes: { type: Number, default: 0 } }],
    voters: [{ username: String, optionIndex: Number }],
    active: { type: Boolean, default: true, index: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.Poll || mongoose.model('Poll', PollSchema);
