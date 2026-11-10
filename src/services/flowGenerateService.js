// Flow Engine X P2 — AI Natural Language Generator (server-side half).
//
// PURE logic: no DB, no HTTP, no provider calls — unit-testable with
// `node --test` and no running server. The device-side FlowValidator
// (com.example.flow.dsl) remains the AUTHORITATIVE validator; the shape
// check in this file is a deliberate MIRROR of its load-bearing rules
// (V1/V2/V3/V4/V5/V6/V7/V8/V9/V10 subset) used ONLY to gate what this
// server returns, so a malformed model output becomes a clean error
// instead of a half-flow. If this mirror and the device validator ever
// disagree, the device wins at Review time.
//
// The system prompt is built SERVER-side from the same allow-lists the
// validator mirrors, so prompt and validator cannot drift apart. The
// client never supplies any part of the prompt (cf. aiController.chat,
// which reads ONLY message + persona — src/controllers/aiController.js:46,89
// — the /api/chat system-prompt limit fixed HERE, per plan §9 / line 210).
//
// This route NEVER stores the request/flow and NEVER logs request bodies.
// Generation is CREDIT-FREE (plan §9): nothing in this module — and
// nothing in flowController.js — touches credits, aiUsage, or any
// deduction. The only quota guard is the 20/min per-user rate limit on
// the route (same bucket shape as /api/chat).

'use strict';

// --- Allow-lists (mirror P1 FlowTriggerRegistry / FlowActionRegistry) ------
// AVAILABLE = 13 triggers / 19 actions (P7: bluetooth x2, wifi x2 and
// voice.command moved here from PLANNED — the app registry flipped them
// AVAILABLE when the P7 trigger engine shipped). PLANNED triggers are
// listed so the server can name them in a "not built yet" error, never
// as runnable.
const AVAILABLE_TRIGGERS = {
    manual: [],
    time: ['hour', 'minute'],
    'battery.level': ['below'],
    'battery.charging': ['charging'],
    'notification.received': ['package'],
    'app.opened': ['package'],
    'app.closed': ['package'],
    'flow.completed': ['flowId'],
    'bluetooth.connected': ['deviceName'],
    'bluetooth.disconnected': ['deviceName'],
    'wifi.connected': [],
    'wifi.disconnected': [],
    'voice.command': ['phrase'],
};

const PLANNED_TRIGGERS = [
    'geofence.enter',
    'geofence.exit',
];

// Action name -> { args: required args, tier: LOW | MEDIUM | HIGH }.
// Tier source: plan §13.3 (alarm.set / timer.set are LOW — FH-04).
const AVAILABLE_ACTIONS = {
    'app.open': { args: ['query'], tier: 'LOW' },
    'device.status': { args: [], tier: 'LOW' },
    'media.control': { args: ['action'], tier: 'MEDIUM' },
    'alarm.set': { args: ['hour', 'minute'], tier: 'LOW' },
    'alarm.cancel': { args: ['alarmId'], tier: 'MEDIUM' },
    'alarm.list': { args: [], tier: 'LOW' },
    'timer.set': { args: ['seconds'], tier: 'LOW' },
    'message.send': { args: ['recipient', 'text'], tier: 'HIGH' },
    'whatsapp.send': { args: ['recipient', 'text'], tier: 'HIGH' },
    'phone.call': { args: ['recipient'], tier: 'HIGH' },
    'whatsapp.call': { args: ['recipient'], tier: 'HIGH' },
    'notification.show': { args: ['title', 'text'], tier: 'LOW' },
    'notification.read': { args: [], tier: 'LOW' },
    'settings.change': { args: ['setting', 'value'], tier: 'MEDIUM' },
    'settings.open': { args: ['page'], tier: 'LOW' },
    'screen.read': { args: [], tier: 'LOW' },
    'youtube.play': { args: ['query'], tier: 'LOW' },
    'news.latest': { args: [], tier: 'LOW' },
    'news.search': { args: ['query'], tier: 'LOW' },
};

const CONDITION_OPS = ['==', '!=', '<', '<=', '>', '>='];
const DEVICE_FACTS = ['battery', 'charging', 'time', 'wifi', 'screen_on'];
const MAX_STEPS = 25;
const MAX_TOTAL_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS_PER_STEP = 300;
const MAX_LOOP_ITERATIONS = 10;

// V8 credential patterns — same five shapes as FlowValidator.kt:14-27
// (fail-closed: a benign "password reset link" is also rejected).
const CREDENTIAL_ASSIGN = /(password|otp|pin|token|secret)\s*[:=]\s*\S+/i;
const OTP_BARE = /\botp\b[^0-9]{0,8}[0-9]{4,8}\b/i;
const PIN_BARE = /\bpin\b[^0-9]{0,8}[0-9]{4,8}\b/i;
const PASSWORD_LOOSE = /\bpassword\b\s*(?:is\s+|[:=]\s*)?\S+/i;
const API_KEY_VALUE = /\b(api[_-]?key|access[_-]?key|secret[_-]?key)\b\s*[:=]?\s*\S+/i;
const CREDENTIAL_KEY = /(password|passwd|pwd|otp|pin|token|secret|api[_-]?key|auth)/i;

function containsCredentialShapedText(text) {
    if (typeof text !== 'string') return false;
    return CREDENTIAL_ASSIGN.test(text) || OTP_BARE.test(text) || PIN_BARE.test(text)
        || PASSWORD_LOOSE.test(text) || API_KEY_VALUE.test(text);
}

// --- Server-side system prompt (built from the allow-lists above) ----------
function buildFlowSystemPrompt() {
    const triggerLines = Object.entries(AVAILABLE_TRIGGERS)
        .map(([type, args]) => `  - ${type}${args.length ? ` (args: ${args.join(', ')})` : ''}`)
        .join('\n');
    const actionLines = Object.entries(AVAILABLE_ACTIONS)
        .map(([name, def]) => `  - ${name}${def.args.length ? ` (args: ${def.args.join(', ')})` : ''} [${def.tier}]`)
        .join('\n');
    return [
        'You are the Kamaal Flow generator. You turn a user request in Roman Urdu or English into ONE automation flow.',
        'Reply with ONLY a JSON object. No markdown, no code fences, no extra text, no explanation outside the JSON.',
        '',
        'Output envelope — exactly one of these shapes:',
        '  {"type":"flow","flow":{...the DSL flow...}}',
        '  {"type":"clarify","question":"...one single question..."}',
        '  {"type":"error","error":"...short reason..."}',
        '',
        'DSL flow shape (dslVersion 1, full-word keys):',
        '  {"dslVersion":1,"id":"flow-<uuid-like>","name":"<1-60 chars>","version":1,',
        '   "createdAt":0,"updatedAt":0,"enabled":true,',
        '   "permissions":["<manifest names the steps need>"],',
        '   "triggers":[{"type":"time","hour":7,"minute":0}],"variables":[],',
        '   "steps":[{"id":"s1","kind":"action","action":"news.latest","args":{},',
        '             "confirm":"first_run","verify":"Headlines list wapas mili."}]}',
        'Step kinds: action | condition | wait | loop | set_variable. Steps: 1-25.',
        'A condition step uses {"if":{"var":"battery","op":">=","value":20},"then":["s2"],"else":["s3"]}.',
        'A wait step uses {"seconds":60} (1-300 per step, total waits at most 60).',
        'A loop step uses {"repeat":3,"body":["s2"]} (1-10, never nested).',
        'HIGH actions (message.send, whatsapp.send, phone.call, whatsapp.call) MUST use "confirm":"always".',
        'Other actions use "confirm":"first_run". Never use "confirm":"never" on a HIGH action.',
        'Triggers — ONLY these (anything else is not built yet):',
        triggerLines,
        'Actions — ONLY these (anything else is not built yet):',
        actionLines,
        '',
        'Rules:',
        '1. If the request is vague or a choice is missing (which player? which person? what time?),',
        '   return {"type":"clarify"} with ONE question only. Never guess a person, time, or app.',
        '2. If the request needs a trigger or action NOT in the lists above (for example smart home,',
        '   location / geofence), return {"type":"clarify"} saying that part is not',
        '   available yet and asking what to do instead. Never invent a trigger or action name.',
        '3. Never put passwords, OTPs, PINs, tokens, or API keys anywhere in the flow — not in',
        '   args, not in the name. If the user asks for one, return {"type":"error"}.',
        '4. Keep it small: prefer 1 trigger and 1-4 steps. Never add steps the user did not ask for.',
    ].join('\n');
}

// --- Model-reply parsing ----------------------------------------------------
class FlowModelError extends Error {}

// Extract the JSON object from a model reply: tolerates ```json fences and
// surrounding prose, but never tolerates trailing garbage inside the object.
function extractJson(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new FlowModelError('Empty model reply.');
    }
    let cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new FlowModelError('No JSON object in model reply.');
    }
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch (_) {
        throw new FlowModelError('Model reply is not valid JSON.');
    }
}

// --- Shape validation (mirror of FlowValidator V-rules, server-side) --------
// Returns an array of error strings; empty = shape-valid. This is NOT a
// second validator implementation — it mirrors only the rules the server
// must enforce before returning a flow, and the device re-validates every
// flow with FlowValidator before Review.
function validateFlowShape(flow) {
    const errors = [];
    if (flow === null || typeof flow !== 'object' || Array.isArray(flow)) {
        return ['Flow must be a JSON object.'];
    }
    // V10 — dslVersion must be 1; newer needs an app update.
    if (flow.dslVersion === undefined || flow.dslVersion === null || !Number.isInteger(flow.dslVersion)) {
        errors.push('V10: dslVersion missing or non-integer.');
    } else if (flow.dslVersion > 1) {
        errors.push('V10: Is flow ke liye app update chahiye.');
    } else if (flow.dslVersion < 1) {
        errors.push('V10: dslVersion missing or non-integer.');
    }
    if (typeof flow.name !== 'string' || flow.name.length < 1 || flow.name.length > 60) {
        errors.push('SCHEMA: Name 1-60 chars hona chahiye.');
    }
    if (typeof flow.id !== 'string' || !flow.id.trim()) {
        errors.push('SCHEMA: Flow id blank hai.');
    }
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
        errors.push('V7: steps[] khaali hai.');
        return errors;
    }
    if (flow.steps.length > MAX_STEPS) {
        errors.push(`V5: Steps ${flow.steps.length} > ${MAX_STEPS}.`);
    }
    const ids = flow.steps.map((s) => s && s.id).filter((id) => typeof id === 'string');
    new Set(ids.filter((id, i) => ids.indexOf(id) !== i)).forEach((id) => {
        errors.push(`V7: Duplicate step id: ${id}.`);
    });
    const varNames = Array.isArray(flow.variables)
        ? flow.variables.map((v) => v && v.name).filter((n) => typeof n === 'string') : [];
    // V1 — triggers required; unknown or PLANNED trigger types rejected.
    if (!Array.isArray(flow.triggers) || flow.triggers.length === 0) {
        errors.push('V1: Koi trigger nahi — manual flow ke liye type manual declare karo.');
    } else {
        flow.triggers.forEach((t) => {
            if (!t || typeof t.type !== 'string') {
                errors.push('V1: Trigger type missing.');
                return;
            }
            if (PLANNED_TRIGGERS.includes(t.type)) {
                errors.push(`V1: Trigger ${t.type} not built yet — abhi available nahi hai.`);
            } else if (!Object.prototype.hasOwnProperty.call(AVAILABLE_TRIGGERS, t.type)) {
                errors.push(`V1: Unknown trigger type: ${t.type}.`);
            } else {
                AVAILABLE_TRIGGERS[t.type].forEach((arg) => {
                    const params = (t.params && typeof t.params === 'object') ? t.params : t;
                    if (params[arg] === undefined) {
                        errors.push(`V1: Trigger ${t.type} ko arg chahiye: ${arg}.`);
                    }
                });
            }
        });
    }
    const stepById = {};
    flow.steps.forEach((s) => { if (s && typeof s.id === 'string') stepById[s.id] = s; });
    const permissions = Array.isArray(flow.permissions) ? flow.permissions : [];
    let totalWait = 0;
    flow.steps.forEach((step, stepIndex) => {
        if (!step || typeof step !== 'object') {
            errors.push('SCHEMA: Step must be an object.');
            return;
        }
        const kind = step.kind;
        if (!['action', 'condition', 'wait', 'loop', 'set_variable'].includes(kind)) {
            errors.push(`SCHEMA: Unknown step kind: ${kind} (step ${step.id}).`);
            return;
        }
        if (kind === 'action') {
            // V2 — unknown action; near-miss rejected, never fuzzy-matched.
            const def = AVAILABLE_ACTIONS[step.action];
            if (!def) {
                errors.push(`V2: Unknown action: ${step.action}.`);
            } else {
                const args = (step.args && typeof step.args === 'object') ? step.args : {};
                def.args.forEach((arg) => {
                    if (args[arg] === undefined) {
                        errors.push(`V2: Action ${step.action} ko arg chahiye: ${arg} (step ${step.id}).`);
                    }
                });
                // V6 — HIGH needs confirm always; "never" on HIGH is a reject.
                if (def.tier === 'HIGH') {
                    if (step.confirm === 'never') {
                        errors.push(`V6: HIGH action ${step.action} par confirm never nahi ho sakta (step ${step.id}).`);
                    } else if (step.confirm !== 'always') {
                        errors.push(`V6: HIGH action ${step.action} ko confirm always chahiye (step ${step.id}).`);
                    }
                }
            }
            // V8 — credential-shaped text in args (keys and values).
            const args = (step.args && typeof step.args === 'object') ? step.args : {};
            Object.entries(args).forEach(([key, value]) => {
                if (CREDENTIAL_KEY.test(key) && String(value || '').trim()) {
                    errors.push(`V8: Credential-named arg '${key}' in step ${step.id} — CLASS_3 reject.`);
                }
                if (containsCredentialShapedText(String(value == null ? '' : value))) {
                    errors.push(`V8: Credential-shaped text in step ${step.id} — CLASS_3 reject.`);
                }
            });
        }
        if (kind === 'condition') {
            const c = step.if;
            if (!c || typeof c !== 'object') {
                errors.push(`SCHEMA: Condition step ${step.id} mein if nahi hai.`);
            } else {
                if (!CONDITION_OPS.includes(c.op)) {
                    errors.push(`SCHEMA: Condition op ghalat: ${c.op} (step ${step.id}).`);
                }
                if (typeof c.var === 'string' && !varNames.includes(c.var) && !DEVICE_FACTS.includes(c.var)) {
                    errors.push(`V3: Undeclared variable: ${c.var} (step ${step.id}).`);
                }
            }
            const thenSteps = Array.isArray(step.then) ? step.then : [];
            const elseSteps = Array.isArray(step.else) ? step.else : [];
            if (thenSteps.length === 0 && elseSteps.length === 0) {
                errors.push(`V7: Condition step ${step.id} ki koi branch nahi.`);
            }
            [...thenSteps, ...elseSteps].forEach((target) => {
                if (!stepById[target]) errors.push(`V7: Dangling target: ${target} (step ${step.id}).`);
            });
        }
        if (kind === 'wait') {
            const seconds = step.seconds;
            if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS_PER_STEP) {
                errors.push(`V5: Wait ${seconds}s — 1–300 s allowed (step ${step.id}).`);
            } else {
                totalWait += seconds;
            }
        }
        if (kind === 'loop') {
            if (!Number.isInteger(step.repeat) || step.repeat < 1 || step.repeat > MAX_LOOP_ITERATIONS) {
                errors.push(`V4: Loop bound ${step.repeat} — 1–10 allowed (step ${step.id}).`);
            }
            (Array.isArray(step.body) ? step.body : []).forEach((target) => {
                const body = stepById[target];
                if (!body) {
                    errors.push(`V7: Dangling loop body step: ${target} (step ${step.id}).`);
                } else if (body.kind === 'loop') {
                    errors.push(`V4: Nested loop nahi allowed (step ${step.id} -> ${target}).`);
                }
            });
        }
        if (kind === 'set_variable') {
            if (typeof step.variable === 'string' && !varNames.includes(step.variable)) {
                errors.push(`V3: Undeclared variable assign: ${step.variable} (step ${step.id}).`);
            }
            const ref = typeof step.value === 'string'
                ? /^steps\.([^.]+)\.([^.]+)$/.exec(step.value) : null;
            if (ref) {
                const [, srcId, out] = ref;
                const src = stepById[srcId];
                if (!src) {
                    errors.push(`V3: Unknown step in output ref: ${srcId} (step ${step.id}).`);
                } else {
                    const srcDef = AVAILABLE_ACTIONS[src.action];
                    const outputs = srcDef ? stepOutputs(src.action) : [];
                    if (!outputs.includes(out)) {
                        errors.push(`V3: Undeclared output: steps.${srcId}.${out} (step ${step.id}).`);
                    } else {
                        const srcIndex = flow.steps.findIndex((s) => s && s.id === srcId);
                        if (srcIndex >= stepIndex) {
                            errors.push(`V3: Forward step-output ref: steps.${srcId}.${out} sirf baad wale steps mein use ho sakta hai (step ${step.id}).`);
                        }
                    }
                }
            }
        }
    });
    // V8 — credential-shaped text in the flow name too.
    if (containsCredentialShapedText(flow.name || '')) {
        errors.push('V8: Credential-shaped text in flow name.');
    }
    // V9 — notification trigger must never feed notification text into a send.
    if (Array.isArray(flow.triggers) && flow.triggers.some((t) => t && t.type === 'notification.received')) {
        flow.steps.filter((s) => s && s.kind === 'action')
            .filter((s) => s.action === 'message.send' || s.action === 'whatsapp.send')
            .forEach((s) => {
                errors.push(`V9: Notification trigger + send action = exfiltration shape (step ${s.id}).`);
            });
    }
    // FH-05 (V5) — total wait across all wait steps, max 60 s.
    if (totalWait > MAX_TOTAL_WAIT_SECONDS) {
        errors.push(`V5: Total wait ${totalWait}s > ${MAX_TOTAL_WAIT_SECONDS}s — default flows cap total wait at 60 s.`);
    }
    // V7 — dead step: unreachable from step 0 via fall-through + branches.
    const seen = new Set();
    const stack = flow.steps.length ? [flow.steps[0].id] : [];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const step = stepById[id];
        if (!step) continue;
        const idx = flow.steps.findIndex((s) => s && s.id === id);
        const next = (idx >= 0 && idx + 1 < flow.steps.length) ? [flow.steps[idx + 1].id] : [];
        const succ = step.kind === 'condition'
            ? [...(step.then || []), ...(step.else || [])]
            : step.kind === 'loop' ? [...(step.body || []), ...next] : next;
        succ.forEach((t) => { if (!seen.has(t)) stack.push(t); });
    }
    flow.steps.forEach((s) => {
        if (s && typeof s.id === 'string' && !seen.has(s.id)) {
            errors.push(`V7: Dead step (unreachable): ${s.id}.`);
        }
    });
    return errors;
}

// Declared step outputs per action (mirror of FlowActionRegistry outputs,
// only the actions whose outputs a set_variable step may reference).
function stepOutputs(action) {
    const outputs = {
        'app.open': ['opened'],
        'device.status': ['battery', 'charging', 'wifi', 'volume', 'brightness'],
        'media.control': ['media_key_sent'],
        'alarm.set': ['alarmId'],
        'alarm.cancel': ['cancelled'],
        'alarm.list': ['alarms'],
        'timer.set': ['timerId'],
        'message.send': ['sent'],
        'whatsapp.send': ['sent'],
        'phone.call': ['called'],
        'whatsapp.call': ['called'],
        'notification.show': ['notificationId'],
        'notification.read': ['notifications'],
        'settings.change': ['previousValue'],
        'settings.open': ['opened'],
        'screen.read': ['screenText'],
        'youtube.play': ['opened'],
        'news.latest': ['headlines'],
        'news.search': ['results'],
    };
    return outputs[action] || [];
}

// --- Classify one raw model reply into the response envelope ---------------
// {type:'flow', flow} | {type:'clarify', question} | {type:'error', error}.
// A malformed AI output is ALWAYS {type:'error'} — never a half-flow.
function classifyModelReply(text) {
    let parsed;
    try {
        parsed = extractJson(text);
    } catch (e) {
        return { type: 'error', error: 'AI ka jawab samajh nahi aaya — dobara try karo.' };
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.type === 'clarify'
            && typeof parsed.question === 'string' && parsed.question.trim()) {
            return { type: 'clarify', question: parsed.question.trim().slice(0, 500) };
        }
        if (parsed.type === 'error' && typeof parsed.error === 'string' && parsed.error.trim()) {
            return { type: 'error', error: parsed.error.trim().slice(0, 500) };
        }
        // Bare DSL object (no envelope) is accepted as a flow — the model
        // sometimes drops the envelope even when told not to.
        const flowCandidate = (parsed.type === 'flow') ? parsed.flow : parsed;
        const looksLikeFlow = flowCandidate && typeof flowCandidate === 'object'
            && !Array.isArray(flowCandidate)
            && (flowCandidate.dslVersion !== undefined || Array.isArray(flowCandidate.steps));
        if (looksLikeFlow) {
            const shapeErrors = validateFlowShape(flowCandidate);
            if (shapeErrors.length === 0) return { type: 'flow', flow: flowCandidate };
            return {
                type: 'error',
                error: `AI ne ghalat flow banaya — ${shapeErrors[0]}` +
                    (shapeErrors.length > 1 ? ` (+${shapeErrors.length - 1} aur)` : ''),
            };
        }
    }
    return { type: 'error', error: 'AI ne flow nahi banaya — dobara try karo.' };
}

module.exports = {
    AVAILABLE_TRIGGERS,
    PLANNED_TRIGGERS,
    AVAILABLE_ACTIONS,
    buildFlowSystemPrompt,
    extractJson,
    validateFlowShape,
    classifyModelReply,
    containsCredentialShapedText,
    FlowModelError,
};
