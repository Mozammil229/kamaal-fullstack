'use strict';

// PATCHER SITE — web users (2026-11-09).
//
// Separate collection from the app User model ON PURPOSE: web (patcher
// site) accounts and app accounts NEVER mix, never share auth, never share
// tokens. A web JWT carries type:'web' and is verified ONLY against this
// collection (see src/middleware/webAuth.js); an app JWT has no 'web' type
// claim and is rejected there, and a web JWT is rejected by the app
// authenticateUser middleware (no username claim / wrong lookup).
// Collection name is explicit ('webusers') so the separation survives any
// future model rename.

const mongoose = require('mongoose');

const WebUserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    // SECURITY: never returned by default — must be explicitly selected.
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lastLoginAt: { type: Date, default: null }
}, { timestamps: true, collection: 'webusers' });

WebUserSchema.index({ createdAt: -1 });

module.exports = mongoose.models.WebUser || mongoose.model('WebUser', WebUserSchema);
