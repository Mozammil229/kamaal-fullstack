const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const creditRoutes = require('./routes/creditRoutes');
const configRoutes = require('./routes/configRoutes');
const chatRoutes = require('./routes/chatRoutes');
const aiRoutes = require('./routes/aiRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
// Kamaal API track (2026-11-05): public API, kml_ key auth, credit-gated.
const kamaalApiRoutes = require('./routes/kamaalApiRoutes');
const onlineToolRoutes = require('./routes/onlineToolRoutes');
// PHASE C — Admin messaging (blueprint §6/§7).
const messageRoutes = require('./routes/messageRoutes');
// Crash reports (app one-tap send, JWT-authenticated POST /api/crash-reports).
const crashReportRoutes = require('./routes/crashReportRoutes');
// v66 — Wink AI video enhance (stateless JSON proxy; server never gets video bytes).
const winkRoutes = require('./routes/winkRoutes');
// S5 C1 PROBE — TEMPORARY route (delete once C1 is decided).
const subtitleProbeRoutes = require('./routes/subtitleProbeRoutes');
// PATCHER SITE — web users (2026-11-09): POST /api/web/register, POST
// /api/web/login, GET /api/web/me (web JWT), /api/web/admin/* (admin JWT).
// Separate collection/auth from the app — see src/models/WebUser.js.
const webRoutes = require('./routes/webRoutes');
// Donut feed (YouTube Data API nightly cache): GET /api/donut/feed,
// GET|POST /api/donut/refresh (Vercel Cron secret or admin auth).
const donutRoutes = require('./routes/donutRoutes');
// NEWS MODE N1 + N2 — Google News RSS headlines: GET /api/news,
// GET /api/news/search?q=. Public (no JWT); mounted BEFORE socialRoutes
// for the same reason as donutRoutes (socialRoutes' blanket
// router.use(authenticateUser) would 401 these open endpoints).
const newsRoutes = require('./routes/newsRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const referralRoutes = require('./routes/referralRoutes');
// PHASE F — server-side patcher: POST /api/patch/request, POST /api/patch/apply.
const patchRoutes = require('./routes/patchRoutes');
// PHASE E — Social app: threads/messages/feed/stories/contacts (blueprint E1/E2/E3/E5).
const socialRoutes = require('./routes/socialRoutes');
// MULTI-AGENT P1 — ops audit trail: POST/GET /api/ops/audit (internal key
// or admin JWT). Mounted before socialRoutes (see mount comment below).
const opsRoutes = require('./routes/opsRoutes');
const authController = require('./controllers/authController');
const { authenticateUser } = require('./middleware/auth');
const { loginRateLimit } = require('./routes/authRoutes');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
// v91 (BugHunter backend F28): the JSON body limit was 15MB — far above
// anything the API accepts (largest legit JSON payload is a 64KB crash
// stack trace). 4MB caps abuse (oversized message/recipe bodies) early.
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

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
app.use('/api/v1', kamaalApiRoutes);
app.use('/api', onlineToolRoutes);
// PHASE B — Kamal ID device identity (matches the /api/* convention).
app.use('/api/device', deviceRoutes);
// PHASE D — referrals: POST /api/referral/apply, GET /api/referral/my.
app.use('/api/referral', referralRoutes);
// PHASE F — server-side patch recipes (methods live on the server, not in the APK).
app.use('/api/patch', patchRoutes);
// PHASE E — social: /api/social/* + /api/user/fcm-token (auth-only, JWT identity).
// NOTE: donutRoutes is mounted BEFORE socialRoutes on purpose — socialRoutes
// has a blanket router.use(authenticateUser) that rejects ANY non-user-JWT
// Authorization header, which would 401 the Vercel Cron secret and the
// admin JWT on /api/donut/refresh before cronOrAdminAuth ever runs.
// (Caught by the local boot test 2026-10-28: both refresh auth paths 401'd.)
app.use('/api', donutRoutes);
// NEWS MODE: /api/news + /api/news/search (public; see newsRoutes.js).
app.use('/api', newsRoutes);
// MULTI-AGENT P1 — ops audit trail: POST/GET /api/ops/audit (internal key
// or admin JWT; see opsRoutes.js). Mounted BEFORE socialRoutes on purpose —
// same reason as donutRoutes above: socialRoutes' blanket
// router.use(authenticateUser) would 401 the ops internal-key Bearer before
// opsAuth ever runs.
app.use('/api', opsRoutes);
// S5 C1 PROBE — TEMPORARY (delete once C1 is decided). Mounted BEFORE
// socialRoutes on purpose: socialRoutes' blanket router.use(authenticateUser)
// would 401 the admin x-admin-key Bearer before requireAdminAuth ever runs
// (same trap as donut/news/ops — see their mount comments).
app.use('/api', subtitleProbeRoutes);
// PATCHER SITE — web auth. Mounted at /api/web (not /api — the /api
// aliases below must keep serving the APP auth) and BEFORE socialRoutes
// on purpose (same trap as probe/donut/news/ops): socialRoutes' blanket
// router.use(authenticateUser) would 401 the web JWT on /api/web/me and
// the admin-JWT Bearer on /api/web/admin/* before the web middleware
// ever runs.
app.use('/api/web', webRoutes);
app.use('/api', socialRoutes);
// PHASE E — serve uploaded social media (server-randomized filenames only).
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));
// PHASE C — Admin messaging (mounted at /api; routes carry their own paths).
app.use('/api', messageRoutes);
// Crash reports (mounted at /api; the route carries its own path).
app.use('/api', crashReportRoutes);
// v66 — Wink AI video enhance (mounted at /api; routes carry /wink/* paths).
app.use('/api', winkRoutes);

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

// Online Tool gated page — path is admin-configurable (default /online-tool).
// The ?token= query param IS the auth (5-min, single-use). Reads config per
// request so an admin path change takes effect without a redeploy.
app.get('*', async (req, res, next) => {
    try {
        const { getActiveConfig } = require('./controllers/configController');
        const { getOnlineToolConfig, serveToolPage } = require('./controllers/onlineToolController');
        const conf = await getActiveConfig();
        const toolCfg = getOnlineToolConfig(conf);
        const path = String(req.path || '').replace(/^\/+|\/+$/g, '').toLowerCase();
        if (path === toolCfg.customPath) return serveToolPage(req, res);
    } catch (e) {
        console.warn('Online tool path check error:', e.message);
    }
    next();
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
