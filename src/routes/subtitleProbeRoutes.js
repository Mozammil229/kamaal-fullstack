// S5 C1 PROBE — TEMPORARY ROUTE (delete once C1 is decided).
//
// POST /api/subtitles/probe — one-shot live gemini-3.5-transcribe test on
// a real Urdu audio clip. Admin-only. No credit movement, no DB writes.
// If C1 passes, the real S5 service replaces this route; if C1 fails,
// this route + subtitleProbeService.js are deleted. See
// src/services/subtitleProbeService.js for the verified API facts.
'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { requireAdminAuth } = require('../middleware/auth');
const pool = require('../services/providerKeyPool');
const apikeyCrypto = require('../services/apikeyCrypto');
const {
    runProbe,
    ProbeError,
    isWavBuffer,
    parseWavDurationMs,
    MAX_AUDIO_BYTES
} = require('../services/subtitleProbeService');

const router = express.Router();

// multer transport cap: nothing larger than the Vercel 4.5 MB body cap
// ever reaches our code. Memory storage only — audio bytes are NEVER
// written to disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 }
});

function fail(res, status, errorCode, message, step) {
    const body = { success: false, error: message, errorCode };
    if (step) body.step = step;
    return res.status(status).json(body);
}

async function handleProbe(req, res) {
    // Log ONLY probe id + status + errorCode. Never audio bytes, file
    // URIs, or transcript text.
    const probeId = crypto.randomUUID();
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
        console.log(`[subtitle-probe] id=${probeId} status=400 errorCode=NO_AUDIO_FILE`);
        return fail(res, 400, 'NO_AUDIO_FILE', 'No audio file received (multipart field "audio").');
    }
    if (!isWavBuffer(file.buffer)) {
        console.log(`[subtitle-probe] id=${probeId} status=400 errorCode=NOT_WAV`);
        return fail(res, 400, 'NOT_WAV', 'Only WAV audio (RIFF/WAVE magic bytes) is accepted.');
    }
    const durationMs = parseWavDurationMs(file.buffer);
    if (durationMs === null) {
        console.log(`[subtitle-probe] id=${probeId} status=400 errorCode=INVALID_WAV_HEADER`);
        return fail(res, 400, 'INVALID_WAV_HEADER', 'WAV header is malformed or unreadable.');
    }

    let keys;
    try {
        keys = await pool.getPoolKeys('gemini');
    } catch (e) {
        console.log(`[subtitle-probe] id=${probeId} status=503 errorCode=GEMINI_KEY_MISSING`);
        return fail(res, 503, 'GEMINI_KEY_MISSING', 'Gemini key pool is unavailable.');
    }
    if (!keys || keys.length === 0) {
        console.log(`[subtitle-probe] id=${probeId} status=503 errorCode=GEMINI_KEY_MISSING`);
        return fail(res, 503, 'GEMINI_KEY_MISSING', 'No Gemini pool key is configured on the server.');
    }

    try {
        const { response, keyIndexUsed } = await runProbe({ audioBuffer: file.buffer, keys });
        // Best-effort pool usage accounting (no-op for env keys) — same
        // pattern as geminiService.js. Never fails the probe response.
        try {
            await pool.recordKeyUse('gemini', apikeyCrypto.sha256(keys[keyIndexUsed]));
        } catch (_) { /* usage accounting never fails a probe */ }
        console.log(`[subtitle-probe] id=${probeId} status=200 wordCount=${response.wordCount}`);
        return res.json(response);
    } catch (err) {
        if (err instanceof ProbeError) {
            console.log(`[subtitle-probe] id=${probeId} status=${err.status} errorCode=${err.code}`);
            return fail(res, err.status, err.code, err.message, err.step);
        }
        console.log(`[subtitle-probe] id=${probeId} status=500 errorCode=PROBE_INTERNAL`);
        return fail(res, 500, 'PROBE_INTERNAL', 'Probe failed with an unexpected error.');
    }
}

router.post('/subtitles/probe', requireAdminAuth, (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
        if (err) {
            const probeId = crypto.randomUUID();
            if (err.code === 'LIMIT_FILE_SIZE') {
                console.log(`[subtitle-probe] id=${probeId} status=413 errorCode=AUDIO_TOO_LARGE`);
                return fail(res, 413, 'AUDIO_TOO_LARGE', 'Audio too large (max 4.5 MB).');
            }
            if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
                console.log(`[subtitle-probe] id=${probeId} status=400 errorCode=BAD_UPLOAD`);
                return fail(res, 400, 'BAD_UPLOAD', 'Send exactly one file in multipart field "audio".');
            }
            return next(err);
        }
        return handleProbe(req, res);
    });
});

module.exports = router;
