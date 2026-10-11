const User = require('../models/User');
const Transaction = require('../models/Transaction');

/**
 * Concurrency-Safe Credit Modification with Persistent Ledger Logging
 */
async function modifyCredits({ username, amount, type, description, adminUser, plan, planExpiry }) {
    if (!username) throw new Error('Username required for credit modification.');
    const delta = Number(amount);
    if (isNaN(delta) || delta === 0) throw new Error('Valid non-zero amount required.');

    // Concurrency-safe atomic findOneAndUpdate with check for sufficient balance on deduction
    const filter = { username };
    if (delta < 0) {
        filter.credits = { $gte: Math.abs(delta) };
    }

    const updatedUser = await User.findOneAndUpdate(
        filter,
        { $inc: { credits: delta } },
        { new: true }
    );

    if (!updatedUser) {
        // User either doesn't exist or doesn't have sufficient balance
        const existing = await User.findOne({ username });
        if (!existing) throw new Error(`User '${username}' not found.`);
        throw new Error(`Insufficient credits. Current balance: ${existing.credits}`);
    }

    // Record immutable audit transaction
    const tx = await Transaction.create({
        username: updatedUser.username,
        type: type || (delta > 0 ? 'admin_grant' : 'usage_deduct'),
        creditsChange: delta,
        newBalance: updatedUser.credits,
        plan: plan || updatedUser.proPlan || '',
        planExpiry: planExpiry || updatedUser.planExpiry || '',
        description: description || `Credits changed by ${delta}`,
        adminUser: adminUser || 'System'
    });

    return { user: updatedUser, transaction: tx };
}

module.exports = {
    modifyCredits
};
