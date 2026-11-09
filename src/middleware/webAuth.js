'use strict';

// PATCHER SITE — web-user JWT middleware (2026-11-09).
//
// Verifies a WEB token only: the JWT must carry type:'web' (signed with
// WEB_JWT_SECRET, else the app JWT_SECRET) AND belong to a WebUser row.
// App JWTs have no 'web' type claim and are rejected here; web JWTs are
// rejected by the app authenticateUser middleware (no username claim).
// Expiry is enforced by jwt.verify. A disabled web account gets 403.
// There is no web logout/revocation list (no logout route in scope):
// the site drops the token client-side and the 7-day expiry bounds it.
const { connectToDatabase, isDbConnected } = require('../config/db');
const WebUser = require('../models/WebUser');
const { verifyWebToken } = require('../controllers/webAuthController');

function createAuthenticateWebUser(WebUserModel, dbGate) {
    const Model = WebUserModel || WebUser;
    const db = dbGate || { connect: connectToDatabase, isConnected: isDbConnected };
    return async function authenticateWebUser(req, res, next) {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ success: false, error: 'Authorization header required.' });
        }
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (!token) {
            return res.status(401).json({ success: false, error: 'Token missing.' });
        }
        let decoded;
        try {
            decoded = verifyWebToken(token);
        } catch (_) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
        }
        if (!decoded || decoded.type !== 'web' || !decoded.sub) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
        }
        await db.connect();
        if (!db.isConnected()) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        const user = await Model.findById(decoded.sub);
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
        }
        if (user.status !== 'active') {
            return res.status(403).json({ success: false, error: 'Account disabled.' });
        }
        req.webUser = user;
        next();
    };
}

module.exports = {
    authenticateWebUser: createAuthenticateWebUser(),
    createAuthenticateWebUser
};
