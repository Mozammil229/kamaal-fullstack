// 4F (W1): fail-fast env validation runs FIRST — before src/app.js is
// required — so a bad staging/production environment is refused with the
// full problem list (src/config/validateEnv.js) instead of env.js's
// single-var FATAL throw. dotenv loads here so values from a local .env
// file count; env.js re-runs dotenv.config() harmlessly when required
// via src/app.js. development/test boot exactly as before (lax mode).
require('dotenv').config();
const { failFastEnvCheck } = require('./config/validateEnv');
failFastEnvCheck();

const app = require('./app');
const env = require('./config/env');
const { connectToDatabase } = require('./config/db');

connectToDatabase();

const server = app.listen(env.PORT, () => {
    console.log(`🚀 Kamaal Backend v2.0 listening on http://localhost:${env.PORT}`);
});

module.exports = server;
