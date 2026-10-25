'use strict';
// v66 — Wink AI video enhancer (Meitu web flow), stateless server-side port
// of the user-supplied Node client (scratch-tmp/wink-enhance-script.mjs).
//
// SPLIT FLOW: this server NEVER receives video bytes. It only proxies the
// Wink JSON APIs (sign / policy / video-info / transcode / delivery /
// result). The app uploads DIRECTLY to Qiniu and polls back here.
//
// STATELESS SESSION: Wink expects one consistent `gnum` (UUID) plus its two
// cookies (_sm + meitustat wgid) across the whole job. Serverless has no
// shared memory, so the app passes `gnum` back on every call and the
// cookie jar is rebuilt from it each time. Nothing about a job is stored.
//
// Unofficial web API (same class as Edge TTS): it can break when Wink
// changes it. Failures surface Wink's code/message (truncated); the app
// shows an honest error, never a fake result. No Wink credentials anywhere.

const crypto = require('node:crypto');

const BASE_URL = 'https://wink.ai';
const STRATEGY_URL = 'https://strategy.app.meitudata.com';

const CLIENT_ID = '1189857605';
const VERSION = '5.1.2';
const COUNTRY_CODE = 'ID';
const CLIENT_LANGUAGE = 'en_US';
const CLIENT_TIMEZONE = 'Asia/Jakarta';

const TASK_TYPE = '11';
const CONTENT_TYPE = '2';

// Fixed delivery identity from the script (task type 11, "Enhancer-Ultra HD").
const FUNCTION_ID = '630';
const MATERIAL_ID = '63011';
const TASK_NAME_PREFIX = 'Enhancer-Ultra HD';

const UA =
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';

// One request must finish well inside Vercel's default function timeout.
const HTTP_TIMEOUT_MS = 8000;
// Upstream payloads can contain signed URLs — never echo them whole.
const MAX_UPSTREAM_ECHO = 300;

class WinkError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WinkError';
        this.status = status || 502;
        this.code = code || 'wink_error';
    }
}

function newGnum() {
    return crypto.randomUUID();
}

function isGnum(value) {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    );
}

function requireGnum(gnum) {
    if (!isGnum(gnum)) throw new WinkError(400, 'bad_gnum', 'Valid gnum (UUID) is required.');
    return gnum;
}

function requireText(value, field, maxLen) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s) throw new WinkError(400, 'bad_input', `${field} is required.`);
    if (s.length > (maxLen || 2048)) throw new WinkError(400, 'bad_input', `${field} is too long.`);
    return s;
}

function requireHttpsUrl(value, field) {
    const s = requireText(value, field, 4096);
    if (!/^https:\/\//i.test(s)) throw new WinkError(400, 'bad_input', `${field} must be an https URL.`);
    return s;
}

function echoUpstream(data) {
    try {
        const s = typeof data === 'string' ? data : JSON.stringify(data);
        return (s || '').slice(0, MAX_UPSTREAM_ECHO);
    } catch (_e) {
        return '';
    }
}

function makeTrace() {
    return `${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-1`;
}

function traceHeaders() {
    const trace = makeTrace();
    return {
        'sentry-trace': trace,
        baggage: [
            'sentry-environment=release',
            `sentry-release=${'5.1.2%20(b60d25c477f43c6dfac4107810f26d442320f4f1)'}`,
            'sentry-public_key=e1bf914f3448d9bc8a10c7e499d17d54',
            `sentry-trace_id=${trace.split('-')[0]}`,
            'sentry-sampled=true',
            'sentry-sample_rate=0.75',
        ].join(','),
    };
}

function winkHeaders(extra) {
    return {
        accept: '*/*',
        origin: BASE_URL,
        referer: `${BASE_URL}/video-enhancer/upload`,
        'user-agent': UA,
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        ab_info: JSON.stringify({ ab_codes: [], version: '1.4.4' }),
        ...(extra || {}),
    };
}

// The Wink session cookies for one job. __mt_uid__ is REQUIRED: without it
// the delivery's ticket creation fails with 20001 "用户id不能为空" (user id
// cannot be empty) — verified live 2026-10-25 (probe-delivery.js: variant A
// without it failed, variant B with it got the task running, error 29901).
// The user's script only sets _sm + meitustat — that jar is incomplete.
// The uid reuses the gnum: one anonymous identity per job is enough.
function sessionCookies(gnum) {
    return [
        `_sm=${gnum}`,
        `meitustat=${encodeURIComponent(JSON.stringify({ wgid: gnum }))}`,
        `__mt_uid__=${gnum}`,
    ];
}

// Lazy require: unit tests inject a stub client and never need axios installed.
function buildWinkClient(gnum) {
    const axios = require('axios');
    const { CookieJar } = require('tough-cookie');
    const { wrapper } = require('axios-cookiejar-support');
    const jar = new CookieJar();
    for (const cookie of sessionCookies(gnum)) {
        jar.setCookieSync(`${cookie}; Path=/; Domain=wink.ai`, BASE_URL);
    }
    return wrapper(
        axios.create({
            baseURL: BASE_URL,
            jar,
            withCredentials: true,
            validateStatus: () => true,
            timeout: HTTP_TIMEOUT_MS,
            headers: winkHeaders(),
        })
    );
}

function plainHttp() {
    return require('axios');
}

function baseParams(gnum, extra) {
    return new URLSearchParams({
        client_id: CLIENT_ID,
        version: VERSION,
        country_code: COUNTRY_CODE,
        gnum,
        client_language: CLIENT_LANGUAGE,
        client_channel_id: '',
        client_timezone: CLIENT_TIMEZONE,
        ...(extra || {}),
    });
}

function checkWinkResponse(res, what) {
    if (!res || res.status >= 400 || res.data == null || res.data.code !== 0) {
        throw new WinkError(
            502,
            'wink_upstream',
            `${what} failed: ${echoUpstream(res ? res.data : null)}`
        );
    }
    return res.data.data;
}

async function getMaatSign(gnum, client) {
    requireGnum(gnum);
    const api = client || buildWinkClient(gnum);
    const params = baseParams(gnum, { suffix: '.mp4', type: 'temp', count: '1' });
    let res;
    try {
        res = await api.get(`/api/file/get_maat_sign.json?${params.toString()}`, {
            headers: traceHeaders(),
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `get_maat_sign unreachable: ${e.message}`);
    }
    return checkWinkResponse(res, 'get_maat_sign');
}

async function getUploadPolicy(gnum, sign, http) {
    requireGnum(gnum);
    if (!sign || typeof sign !== 'object') throw new WinkError(400, 'bad_input', 'sign object is required.');
    const app = requireText(sign.app, 'sign.app', 64);
    const sig = requireText(sign.sig, 'sign.sig', 256);
    const sigTime = requireText(String(sign.sig_time == null ? '' : sign.sig_time), 'sign.sig_time', 32);
    const sigVersion = requireText(String(sign.sig_version == null ? '' : sign.sig_version), 'sign.sig_version', 32);
    const suffix = requireText(sign.suffix || '.mp4', 'sign.suffix', 16);
    const type = requireText(sign.type || 'temp', 'sign.type', 32);
    const count = String(sign.count == null ? 1 : sign.count);
    const params = new URLSearchParams({
        app,
        count,
        sig,
        sigTime,
        sigVersion,
        suffix,
        type,
    });
    const client = http || plainHttp();
    let res;
    try {
        res = await client.get(`${STRATEGY_URL}/upload/policy?${params.toString()}`, {
            headers: {
                accept: '*/*',
                origin: BASE_URL,
                referer: `${BASE_URL}/`,
                'user-agent': UA,
                'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
                'sec-ch-ua-mobile': '?1',
                'sec-ch-ua-platform': '"Android"',
            },
            validateStatus: () => true,
            timeout: HTTP_TIMEOUT_MS,
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `upload policy unreachable: ${e.message}`);
    }
    if (!res || res.status >= 400 || !Array.isArray(res.data) || !res.data[0] || !res.data[0].qiniu) {
        throw new WinkError(502, 'wink_upstream', `upload policy failed: ${echoUpstream(res ? res.data : null)}`);
    }
    return res.data[0].qiniu;
}

async function getVideoInfo(gnum, fileKey, client) {
    requireGnum(gnum);
    const key = requireText(fileKey, 'file_key', 512);
    const api = client || buildWinkClient(gnum);
    const body = baseParams(gnum, { file_key: key });
    let res;
    try {
        res = await api.post('/api/file/video_cover_and_display_info_ext.json', body.toString(), {
            headers: { ...traceHeaders(), 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `video info unreachable: ${e.message}`);
    }
    return checkWinkResponse(res, 'video info');
}

async function startTranscode(gnum, fileKey, client) {
    requireGnum(gnum);
    const key = requireText(fileKey, 'file_key', 512);
    const api = client || buildWinkClient(gnum);
    const body = baseParams(gnum, { file_key: key });
    let res;
    try {
        res = await api.post('/api/file/video_trans_start.json', body.toString(), {
            headers: { ...traceHeaders(), 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `transcode start unreachable: ${e.message}`);
    }
    const data = checkWinkResponse(res, 'transcode start');
    if (!data || !data.id) {
        throw new WinkError(502, 'wink_upstream', 'transcode start returned no id.');
    }
    return data.id;
}

async function queryTranscode(gnum, id, client) {
    requireGnum(gnum);
    const transId = requireText(id, 'id', 256);
    const api = client || buildWinkClient(gnum);
    const params = baseParams(gnum, { id: transId });
    let res;
    try {
        res = await api.get(`/api/file/video_trans_query.json?${params.toString()}`, {
            headers: traceHeaders(),
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `transcode query unreachable: ${e.message}`);
    }
    return checkWinkResponse(res, 'transcode query');
}

async function createDelivery(gnum, input, client) {
    requireGnum(gnum);
    if (!input || typeof input !== 'object') throw new WinkError(400, 'bad_input', 'delivery input is required.');
    const sourceUrl = requireHttpsUrl(input.source_url, 'source_url');
    const videoTranscoded = requireHttpsUrl(input.video_transcoded, 'video_transcoded');
    const taskName = `${TASK_NAME_PREFIX}-${requireText(input.task_name || 'video', 'task_name', 128)}`;
    const api = client || buildWinkClient(gnum);
    const body = baseParams(gnum, {
        type: TASK_TYPE,
        content_type: CONTENT_TYPE,
        source_url: sourceUrl,
        type_params: JSON.stringify({ is_mirror: 0, orientation_tag: 1, j_420_trans: '1', return_ext: '2' }),
        right_detail: JSON.stringify({
            source: '1',
            touch_type: '4',
            function_id: FUNCTION_ID,
            material_id: MATERIAL_ID,
            url: 'https://wink.ai/video-enhancer/upload',
        }),
        ext_params: JSON.stringify({ task_name: taskName, records: TASK_TYPE, video_transcoded: videoTranscoded }),
        with_prepare: '1',
    });
    let res;
    try {
        res = await api.post('/api/meitu_ai/delivery.json', body.toString(), {
            headers: { ...traceHeaders(), 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `delivery unreachable: ${e.message}`);
    }
    const data = checkWinkResponse(res, 'delivery');
    const msgId = (data && (data.msg_id || '')) || '';
    const prepareMsgId = (data && (data.prepare_msg_id || '')) || '';
    if (!msgId && !prepareMsgId) {
        throw new WinkError(502, 'wink_upstream', 'delivery returned no msg_id.');
    }
    return { msg_id: msgId, prepare_msg_id: prepareMsgId, raw: data };
}

async function queryBatch(gnum, msgId, client) {
    requireGnum(gnum);
    const id = requireText(msgId, 'msg_ids', 512);
    const api = client || buildWinkClient(gnum);
    const params = baseParams(gnum, { msg_ids: id });
    let res;
    try {
        res = await api.get(`/api/meitu_ai/query_batch.json?${params.toString()}`, {
            headers: { ...traceHeaders(), referer: `${BASE_URL}/video-enhancer/upload` },
        });
    } catch (e) {
        throw new WinkError(502, 'wink_unreachable', `query batch unreachable: ${e.message}`);
    }
    return checkWinkResponse(res, 'query batch');
}

module.exports = {
    WinkError,
    newGnum,
    isGnum,
    sessionCookies,
    getMaatSign,
    getUploadPolicy,
    getVideoInfo,
    startTranscode,
    queryTranscode,
    createDelivery,
    queryBatch,
    TASK_NAME_PREFIX,
};
