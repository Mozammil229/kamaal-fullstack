'use strict';

// PATCHER SITE — web auth routes (2026-11-09).
//
// Public: POST /register, POST /login (rate-limited, same budgets as the
// app auth routes: 5 registrations/min, 10 logins/min per IP).
// Web JWT: GET /me (the site gate verifies a stored token here).
// Site admin (admin panel "Site" section): GET /admin/users,
// PATCH /admin/users/:id (disable/enable), DELETE /admin/users/:id —
// admin JWT only (requireAdminAuth), never a web JWT.
// Mounted at /api/web in app.js, BEFORE socialRoutes (same trap as the
// probe/donut/news/ops routes: socialRoutes' blanket authenticateUser
// would 401 the web/admin Bearer before these handlers ever run).

const express = require('express');
const router = express.Router();
const { rateLimit } = require('../middleware/rateLimit');
const { requireAdminAuth } = require('../middleware/auth');
const { authenticateWebUser } = require('../middleware/webAuth');
const { createWebAuthHandlers } = require('../controllers/webAuthController');

const webRegisterRateLimit = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Too many registrations. Try again in a minute.' });
const webLoginRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10, message: 'Too many login attempts. Try again in a minute.' });

const h = createWebAuthHandlers();

router.post('/register', webRegisterRateLimit, h.register);
router.post('/login', webLoginRateLimit, h.login);
router.get('/me', authenticateWebUser, h.getMe);
router.get('/admin/users', requireAdminAuth, h.listWebUsers);
router.patch('/admin/users/:id', requireAdminAuth, h.updateWebUser);
router.delete('/admin/users/:id', requireAdminAuth, h.deleteWebUser);

module.exports = router;
