const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const creditRoutes = require('./routes/creditRoutes');
const configRoutes = require('./routes/configRoutes');
const chatRoutes = require('./routes/chatRoutes');
const aiRoutes = require('./routes/aiRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authController = require('./controllers/authController');
const { authenticateUser } = require('./middleware/auth');
const { loginRateLimit } = require('./routes/authRoutes');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Request logging in development
if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
        next();
    });
}

// 1. Core API Route Mounts
app.use('/api/auth', authRoutes);
app.use('/api', creditRoutes);
app.use('/api', configRoutes);
app.use('/api', chatRoutes);
app.use('/api', aiRoutes);
app.use('/api', userRoutes);
app.use('/api/admin', adminRoutes);

// 2. Direct Aliases required by Android Retrofit specifications:
// - /api/register -> authController.register
// - /api/login -> authController.login
// - /api/verify -> authController.verify
// - /api/me -> authController.verify
app.post('/api/register', authController.register);
// BH-2 FIX: the /api/login alias gets the same rate limiter as /api/auth/login.
app.post('/api/login', loginRateLimit, authController.login);
// BH-1 FIX: /api/verify + /api/me aliases now require auth; verify() uses the
// JWT username only (no ?username= fallback).
app.get('/api/verify', authenticateUser, authController.verify);
app.get('/api/me', authenticateUser, authController.verify);

// Root Fallback / Status
app.get('/', (req, res) => {
    res.json({
        success: true,
        service: 'Kamaal API Server v2.0',
        architecture: 'Modular Production Engine',
        status: 'Online',
        timestamp: Date.now()
    });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: `Route '${req.originalUrl}' not found.` });
});

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : err.message
    });
});

module.exports = app;
