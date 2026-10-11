// Vercel Serverless Entry — Kamaal Backend + Admin (Single Deployment)
const app = require('../src/app');
const { connectToDatabase } = require('../src/config/db');

// Connect to MongoDB Atlas (cached across warm invocations)
let connected = false;
if (!connected) {
    connectToDatabase();
    connected = true;
}

module.exports = app;
