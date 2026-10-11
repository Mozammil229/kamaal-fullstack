const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    MONGODB_URI: process.env.MONGODB_URI || '',
    JWT_SECRET: process.env.JWT_SECRET || 'kammal_secure_jwt_secret_change_in_production_2026',
    ADMIN_USER: (process.env.ADMIN_USER || 'admin').trim(),
    ADMIN_PASS: (process.env.ADMIN_PASS || 'ADmin').trim(),
    ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'kammal_admin_jwt_secret_2026',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_BACKUP_KEYS: process.env.GEMINI_BACKUP_KEYS || '',
    ADMIN_TOKEN_TTL_MS: 24 * 60 * 60 * 1000 // 24 hours
};
