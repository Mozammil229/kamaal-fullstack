// S5 C1 PROBE — TEMPORARY (delete once C1 is decided).
//
// One-shot live test of `gemini-3.5-transcribe` on a real Urdu audio clip:
// upload -> poll ACTIVE -> Interactions transcribe (verbatim + word
// timestamps) -> parse word_info -> delete the Files-API file.
// This is a PROBE, not the S5 job system: no credit movement, no DB
// writes, no MongoDB document. If C1 passes, the real S5 service
// replaces this file; if C1 fails, this file is deleted.
//
// API facts verified at build time (2026-11-08) against the official docs:
// - Transcribe guide (ai.google.dev/gemini-api/docs/transcribe): REST
//   POST /v1beta/interactions, body model "models/gemini-3.5-transcribe",
//   input [{type:"file", file_uri}], generation_config.transcription_config
//   .mode {type:"verbatim", timestamp_granularities:["word"]}; response
//   output_text + steps[].content[].annotations[] word_info with
//   start_offset/end_offset strings like "0.100s". No language_codes
//   (auto-detect). No Api-Revision header appears anywhere on that page.
// - Files API guide (ai.google.dev/gemini-api/docs/files): resumable
//   upload (X-Goog-Upload-Protocol: resumable, start -> upload, finalize),
//   files.get to check state, DELETE /v1beta/{name}. Its REST interactions
//   example DOES send `Api-Revision: 2026-05-20`, so this service sends it.
// - Files `state` field: confirmed against the INSTALLED SDK types
//   (node_modules/@google/generative-ai/dist/server/types/server/files.d.ts):
//   FileState = STATE_UNSPECIFIED | PROCESSING | ACTIVE | FAILED.
// - `store: false` could NOT be verified: the word "store" does not appear
//   on the transcribe guide at all (secondary source only), so the flag is
//   OMITTED here — see the report. Do not add it without a live reference.
// - GoogleAIFileManager was NOT used: its uploadFile() takes a file PATH
//   only, and this probe must never write audio to disk. Files API calls
//   below are raw REST fetch with an in-memory Buffer.
// - The pool key NEVER leaves the server (x-goog-api-key header only).
//   Audio bytes, file URIs and transcript text are NEVER logged.
'use strict';

const PROBE_MODEL = 'gemini-3.5-transcribe';
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const FILES_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const FILES_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Verified: Files API doc REST interactions example sends this header.
const API_REVISION = '2026-05-20';
const MAX_AUDIO_BYTES = 4.5 * 1024 * 1024; // 4,718,592 — Vercel body cap
const DEFAULT_DEADLINE_MS = 50_000; // whole handler must fit in 60 s maxDuration
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_MAX_MS = 30_000;
const DELETE_TIMEOUT_MS = 5000;
const WAV_MIME = 'audio/wav';

class ProbeError extends Error {
    constructor(code, status, message, step) {
        super(message);
        this.code = code;
        this.status = status;
        this.step = step || null;
    }
}

// Internal: thrown when a step gets HTTP 429 — the caller retries the
// WHOLE attempt with the next pool key.
class RotateKey extends Error {
    constructor(step) {
        super(`Gemini 429 on ${step}; rotating to next pool key`);
        this.step = step;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- pure helpers (unit-tested, no network) -------------------------------

// WAV magic bytes only: 'RIFF' at 0, 'WAVE' at 8. Never trust client MIME.
function isWavBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 // 'RIFF'
        && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45; // 'WAVE'
}

// Duration in ms from the WAV header (fmt chunk + data chunk size).
// Returns null when the header is malformed — the caller fails loud
// instead of inventing a duration.
function parseWavDurationMs(buf) {
    if (!isWavBuffer(buf) || buf.length < 44) return null;
    let offset = 12;
    let fmt = null;
    let dataSize = null;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const bodyStart = offset + 8;
        if (bodyStart + size > buf.length) return null; // truncated chunk
        if (id === 'fmt ' && size >= 16) {
            const channels = buf.readUInt16LE(bodyStart + 2);
            const sampleRate = buf.readUInt32LE(bodyStart + 4);
            const bitsPerSample = buf.readUInt16LE(bodyStart + 14);
            fmt = { channels, sampleRate, bitsPerSample };
        } else if (id === 'data') {
            dataSize = size;
        }
        offset = bodyStart + size + (size % 2); // chunks are word-aligned
    }
    if (!fmt || dataSize === null) return null;
    const { channels, sampleRate, bitsPerSample } = fmt;
    if (!sampleRate || !channels || ![8, 16, 24, 32].includes(bitsPerSample)) return null;
    const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
    if (!bytesPerSecond || dataSize <= 0) return null;
    return Math.round((dataSize * 1000) / bytesPerSecond);
}

// "0.100s" -> 100. Accepts "1.234s", "0s", "12.5s". Anything else -> null.
function parseOffsetToMs(value) {
    if (typeof value !== 'string') return null;
    const m = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
    if (!m) return null;
    const ms = Math.round(parseFloat(m[1]) * 1000);
    return Number.isFinite(ms) ? ms : null;
}

// Walk steps[].content[].annotations[], keep word_info only, validate
// endMs > startMs per word. Invalid entries are DROPPED and counted,
// never repaired or invented.
function extractWords(interaction) {
    const words = [];
    let droppedInvalidWords = 0;
    const steps = (interaction && Array.isArray(interaction.steps)) ? interaction.steps : [];
    for (const step of steps) {
        const contents = (step && Array.isArray(step.content)) ? step.content : [];
        for (const content of contents) {
            const annotations = (content && Array.isArray(content.annotations)) ? content.annotations : [];
            for (const ann of annotations) {
                if (!ann || ann.type !== 'word_info') continue;
                const text = ann.text;
                const startMs = parseOffsetToMs(ann.start_offset);
                const endMs = parseOffsetToMs(ann.end_offset);
                if (typeof text !== 'string' || !text || startMs === null || endMs === null
                    || startMs < 0 || endMs <= startMs) {
                    droppedInvalidWords++;
                    continue;
                }
                words.push({ text, startMs, endMs });
            }
        }
    }
    return { words, droppedInvalidWords };
}

function buildProbeResponse({ outputText, words, droppedInvalidWords, durationMs, fileState }) {
    return {
        success: true,
        model: PROBE_MODEL,
        outputText: outputText || '',
        words,
        wordCount: words.length,
        droppedInvalidWords,
        durationMs,
        fileState
    };
}

// ---- Gemini REST calls (one pool key per attempt) -------------------------

function isAbortError(err) {
    return err && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

async function readErrorText(res) {
    try {
        const text = await res.text();
        return text ? text.slice(0, 300) : `HTTP ${res.status}`;
    } catch (_) {
        return `HTTP ${res.status}`;
    }
}

// Throws RotateKey on 429, ProbeError otherwise. Never throws on a
// non-2xx that is not 429 without a loud errorCode.
async function requireOk(res, step, fetchImpl) {
    void fetchImpl;
    if (res.ok) return;
    if (res.status === 429) throw new RotateKey(step);
    const detail = await readErrorText(res);
    throw new ProbeError('GEMINI_ERROR', 502,
        `Gemini ${step} failed (HTTP ${res.status}): ${detail}`, step);
}

// Step 1 — resumable upload of the in-memory buffer. Returns { name, uri }.
async function uploadFile(apiKey, audioBuffer, fetchImpl, signal) {
    const startRes = await fetchImpl(FILES_UPLOAD_URL, {
        method: 'POST',
        headers: {
            'x-goog-api-key': apiKey,
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(audioBuffer.length),
            'X-Goog-Upload-Header-Content-Type': WAV_MIME,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ file: { display_name: 's5-c1-probe' } }),
        signal
    });
    await requireOk(startRes, 'files-upload-start', fetchImpl);
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
        throw new ProbeError('GEMINI_ERROR', 502,
            'Gemini Files upload did not return an upload URL.', 'files-upload-start');
    }
    const putRes = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
            'Content-Type': WAV_MIME
        },
        body: audioBuffer,
        signal
    });
    await requireOk(putRes, 'files-upload-finalize', fetchImpl);
    const body = await putRes.json();
    const file = body.file || body;
    if (!file || !file.name || !file.uri) {
        throw new ProbeError('GEMINI_ERROR', 502,
            'Gemini Files upload response had no file name/URI.', 'files-upload-finalize');
    }
    return { name: file.name, uri: file.uri, state: file.state || null };
}

// Step 2 — files.get until ACTIVE. Returns the final state ('ACTIVE').
async function pollFileActive(apiKey, fileName, fetchImpl, signal, opts, state) {
    const startedAt = Date.now();
    let lastState = null;
    while (true) {
        if (Date.now() - startedAt > opts.pollMaxMs) {
            throw new ProbeError('FILE_NOT_READY', 503,
                `Gemini file did not reach ACTIVE within ${opts.pollMaxMs}ms (last state: ${lastState || 'unknown'}).`,
                'files-poll');
        }
        if (state.isPastDeadline()) {
            throw new ProbeError('PROBE_TIMEOUT', 503,
                'Probe deadline reached while waiting for the file to become ACTIVE.',
                'files-poll');
        }
        const res = await fetchImpl(`${FILES_API_BASE}/${fileName}`, {
            method: 'GET',
            headers: { 'x-goog-api-key': apiKey },
            signal
        });
        await requireOk(res, 'files-get', fetchImpl);
        const body = await res.json();
        lastState = body.state || (body.file && body.file.state) || null;
        if (lastState === 'ACTIVE') return 'ACTIVE';
        if (lastState === 'FAILED') {
            throw new ProbeError('FILE_PROCESSING_FAILED', 503,
                'Gemini file processing FAILED.', 'files-poll');
        }
        await sleep(opts.pollIntervalMs);
    }
}

// Step 3 — Interactions transcribe call. Returns the parsed JSON.
async function transcribeFile(apiKey, fileUri, fetchImpl, signal) {
    const res = await fetchImpl(INTERACTIONS_URL, {
        method: 'POST',
        headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json',
            'Api-Revision': API_REVISION
        },
        body: JSON.stringify({
            model: `models/${PROBE_MODEL}`,
            input: [{ type: 'file', file_uri: fileUri }],
            generation_config: {
                transcription_config: {
                    mode: { type: 'verbatim', timestamp_granularities: ['word'] }
                }
            }
        }),
        signal
    });
    await requireOk(res, 'interactions-transcribe', fetchImpl);
    return res.json();
}

// Best-effort delete on EVERY path. Never throws; never logs URIs.
async function deleteFileBestEffort(apiKey, fileName, fetchImpl) {
    if (!fileName) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELETE_TIMEOUT_MS);
    try {
        await fetchImpl(`${FILES_API_BASE}/${fileName}`, {
            method: 'DELETE',
            headers: { 'x-goog-api-key': apiKey },
            signal: controller.signal
        });
    } catch (e) {
        console.warn('[subtitle-probe] Files-API delete failed (best-effort):', e.message);
    } finally {
        clearTimeout(timer);
    }
}

// One attempt with ONE pool key. Owns the file lifecycle: the uploaded
// file is deleted in a finally on success, failure, timeout and 429.
async function attemptWithKey(apiKey, audioBuffer, durationMs, fetchImpl, signal, opts, state) {
    let fileName = null;
    let fileState = null;
    try {
        state.step = 'files-upload';
        const uploaded = await uploadFile(apiKey, audioBuffer, fetchImpl, signal);
        fileName = uploaded.name;
        fileState = uploaded.state;

        state.step = 'files-poll';
        fileState = await pollFileActive(apiKey, fileName, fetchImpl, signal, opts, state);

        state.step = 'interactions-transcribe';
        const interaction = await transcribeFile(apiKey, uploaded.uri, fetchImpl, signal);

        const outputText = (interaction && typeof interaction.output_text === 'string')
            ? interaction.output_text : '';
        const { words, droppedInvalidWords } = extractWords(interaction);
        if (words.length === 0) {
            throw new ProbeError('NO_WORD_TIMESTAMPS', 502,
                'Gemini returned no valid word_info annotations — timings must never be invented.',
                'interactions-transcribe');
        }
        return {
            response: buildProbeResponse({ outputText, words, droppedInvalidWords, durationMs, fileState }),
            fileState
        };
    } finally {
        await deleteFileBestEffort(apiKey, fileName, fetchImpl);
    }
}

// ---- entry point ----------------------------------------------------------
//
// runProbe({ audioBuffer, keys, fetchImpl?, deadlineMs?, pollIntervalMs?, pollMaxMs? })
// - keys: pool keys in rotation order (pool.getPoolKeys('gemini')).
// - 429 on ANY step rotates to the next key (whole attempt redone; the
//   previous attempt's file was already deleted by its finally).
// - The single ~50 s deadline covers upload+poll+transcribe across ALL
//   key attempts; on expiry the error is PROBE_TIMEOUT with the step
//   that was running. Returns { response, keyIndexUsed }.
async function runProbe({ audioBuffer, keys, fetchImpl, deadlineMs, pollIntervalMs, pollMaxMs }) {
    const fetchFn = fetchImpl || globalThis.fetch;
    if (typeof fetchFn !== 'function') {
        throw new ProbeError('GEMINI_ERROR', 503, 'No fetch implementation available.', 'setup');
    }
    if (!Array.isArray(keys) || keys.length === 0) {
        throw new ProbeError('GEMINI_KEY_MISSING', 503,
            'No Gemini pool key is configured on the server.', 'setup');
    }
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        throw new ProbeError('NO_AUDIO_FILE', 400, 'No audio received.', 'setup');
    }
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
        throw new ProbeError('AUDIO_TOO_LARGE', 413,
            `Audio too large (max ${MAX_AUDIO_BYTES} bytes).`, 'setup');
    }
    const durationMs = parseWavDurationMs(audioBuffer);
    if (durationMs === null) {
        throw new ProbeError('INVALID_WAV_HEADER', 400,
            'WAV header is malformed or unreadable.', 'setup');
    }

    const opts = {
        pollIntervalMs: pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        pollMaxMs: pollMaxMs ?? DEFAULT_POLL_MAX_MS
    };
    const deadline = Date.now() + (deadlineMs ?? DEFAULT_DEADLINE_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    const state = {
        step: 'setup',
        isPastDeadline: () => Date.now() >= deadline
    };
    let lastRotateError = null;
    try {
        for (let i = 0; i < keys.length; i++) {
            if (state.isPastDeadline()) {
                throw new ProbeError('PROBE_TIMEOUT', 503,
                    `Probe deadline reached before key attempt ${i + 1} (step: ${state.step}).`,
                    state.step);
            }
            try {
                const { response } = await attemptWithKey(
                    keys[i], audioBuffer, durationMs, fetchFn, controller.signal, opts, state);
                return { response, keyIndexUsed: i };
            } catch (err) {
                if (err instanceof RotateKey) {
                    lastRotateError = err;
                    continue;
                }
                if (isAbortError(err)) {
                    throw new ProbeError('PROBE_TIMEOUT', 503,
                        `Probe deadline reached (step: ${state.step}).`, state.step);
                }
                throw err;
            }
        }
        throw new ProbeError('GEMINI_RATE_LIMITED', 503,
            `All ${keys.length} pool key(s) hit Gemini rate limits (last step: ${lastRotateError ? lastRotateError.step : 'unknown'}).`,
            lastRotateError ? lastRotateError.step : null);
    } catch (err) {
        if (isAbortError(err)) {
            throw new ProbeError('PROBE_TIMEOUT', 503,
                `Probe deadline reached (step: ${state.step}).`, state.step);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    runProbe,
    ProbeError,
    // Pure helpers — exported for unit tests only.
    isWavBuffer,
    parseWavDurationMs,
    parseOffsetToMs,
    extractWords,
    buildProbeResponse,
    PROBE_MODEL,
    MAX_AUDIO_BYTES,
    DEFAULT_DEADLINE_MS,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_POLL_MAX_MS
};
