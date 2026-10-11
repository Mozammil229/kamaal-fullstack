const app = require('./app');
const env = require('./config/env');
const { connectToDatabase } = require('./config/db');

connectToDatabase();

const server = app.listen(env.PORT, () => {
    console.log(`🚀 Kamaal Backend v2.0 listening on http://localhost:${env.PORT}`);
});

module.exports = server;
