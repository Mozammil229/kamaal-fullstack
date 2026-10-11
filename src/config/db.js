const mongoose = require('mongoose');
const env = require('./env');

let cachedConnection = null;

async function connectToDatabase() {
    if (cachedConnection && mongoose.connection.readyState === 1) {
        return cachedConnection;
    }

    if (!env.MONGODB_URI) {
        console.warn('⚠️ [MONGODB] MONGODB_URI not provided. Running in memory / offline mode.');
        return null;
    }

    try {
        const conn = await mongoose.connect(env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10
        });
        cachedConnection = conn;
        console.log('✅ [MONGODB] Connected to MongoDB Atlas cluster.');
        return cachedConnection;
    } catch (err) {
        console.error('❌ [MONGODB] Connection error:', err.message);
        return null;
    }
}

module.exports = {
    connectToDatabase,
    isDbConnected: () => mongoose.connection.readyState === 1
};
