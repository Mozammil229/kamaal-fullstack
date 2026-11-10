// Flow Engine X P2 — AI Natural Language Generator (route handler).
// POST /api/flow/generate — new route (not a patch to /api/chat).
//
// Why a new route (plan §9 / line 210): aiController.chat reads ONLY
// message + persona (src/controllers/aiController.js:46,89) and builds its
// system prompt from server AppConfig / server-side persona prompts —
// a client system prompt is NEVER honoured for normal requests (the
// 2026-10-21 storyboard root cause). Structured flow JSON therefore
// needs a server-side prompt, which this route builds via
// flowGenerateService.buildFlowSystemPrompt() and passes to the EXISTING
// provider chain (generateAIReply: Gemini pool -> Groq -> OpenRouter).
// No new provider path is invented here.
//
// Auth: authenticateUser JWT (USER route, NOT admin — wired in aiRoutes.js).
// Credit: CREDIT-FREE (plan §9). This handler never checks, deducts, or
// reports credits or AI time-budget usage — it calls no credit/aiUsage
// service at all. The only quota guard is the 20/min per-user rate limit
// on the route. (Deliberate scope note: the /api/chat 20-minute daily
// free-AI time pool is NOT enforced here either; if the coordinator wants
// it on this route, that is a small follow-up — it must not be silently
// assumed to apply.)
//
// The route NEVER stores the request or the generated flow (no model
// writes of any kind) and NEVER logs request bodies or model replies.
// The cloud proposes; the device validates (Review) and runs. The cloud
// never executes a step, never touches the device, and never sees
// passwords/OTP (a credential-shaped model output is a clean error).
//
// Response envelope (always HTTP 200 for a handled generation outcome;
// HTTP 4xx/5xx only for auth, bad input, rate limit, maintenance, or a
// provider failure):
//   { success: true, type: "flow", flow: { ...DSL JSON... }, model }
//   { success: true, type: "clarify", question: "...", model }
//   { success: true, type: "error", error: "...", model }
// A malformed AI output is { type: "error" } — never a half-flow.
//
// Testability: the handler is built by createGenerateFlowHandler(deps) so
// contract tests can inject stubbed generateAIReply / DB / models without
// a running server or Mongo. The exported `generateFlow` is the same
// factory called with the real dependencies.

'use strict';

const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { generateAIReply } = require('../services/aiProviderChain');
const { connectToDatabase } = require('../config/db');
const { buildFlowSystemPrompt, classifyModelReply } = require('../services/flowGenerateService');

// Mirror of aiController.chat (v91 F30): message capped at 16KB.
const MAX_MESSAGE_CHARS = 16384;

function createGenerateFlowHandler(deps) {
    const generate = deps.generateAIReply;
    const connect = deps.connectToDatabase;
    const configModel = deps.AppConfig;
    const userModel = deps.User;

    return async function generateFlow(req, res) {
        try {
            await connect();
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        let conf = null;
        try {
            conf = await configModel.findOne({ key: 'global_config' });
        } catch (_) {
            return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
        }
        if (conf && conf.maintenance && conf.maintenance.enabled) {
            return res.status(503).json({ success: false, error: conf.maintenance.message });
        }

        const message = req.body ? req.body.message : undefined;
        if (typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, error: 'Message required.' });
        }
        if (message.length > MAX_MESSAGE_CHARS) {
            return res.status(400).json({ success: false, error: 'Message is too long (max 16384 characters).' });
        }

        // Banned users never burn provider quota (same guard as /api/chat).
        const username = req.user ? req.user.username : undefined;
        if (username) {
            let user = null;
            try {
                user = await userModel.findOne({ username });
            } catch (_) {
                return res.status(503).json({ success: false, error: 'Database offline. Please try again.' });
            }
            if (user && user.status === 'banned') {
                return res.status(403).json({ success: false, error: 'Suspended.' });
            }
        }

        const modelToUse = (conf && conf.currentModel) || 'gemini-3.6-flash';
        let reply;
        try {
            // Server-built system prompt (the client never supplies it).
            // Reuses the existing generation path — no new provider.
            reply = await generate(message, buildFlowSystemPrompt(), '', modelToUse);
        } catch (e) {
            const status = (e.code === 'GEMINI_KEY_MISSING' || e.code === 'AI_KEY_MISSING') ? 503 : 500;
            return res.status(status).json({ success: false, error: e.message, code: e.code || 'AI_ERROR' });
        }

        const out = classifyModelReply(reply);
        if (out.type === 'flow') {
            return res.json({ success: true, type: 'flow', flow: out.flow, model: modelToUse });
        }
        if (out.type === 'clarify') {
            return res.json({ success: true, type: 'clarify', question: out.question, model: modelToUse });
        }
        return res.json({ success: true, type: 'error', error: out.error, model: modelToUse });
    };
}

const generateFlow = createGenerateFlowHandler({
    generateAIReply,
    connectToDatabase,
    AppConfig,
    User,
});

module.exports = {
    generateFlow,
    createGenerateFlowHandler,
};
