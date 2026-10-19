/**
 * ============================================================================
 * PHASE F — server-side patcher method recipes.
 * ============================================================================
 *
 * The Normal (Pulse) and Pro (Forge) MP4 fingerprint tag sets live HERE, on
 * the server — never in the APK. The Android client fetches a recipe per
 * patch request (POST /api/patch/request), decrypts it in memory, and hands
 * the tag VALUES to the stamper as parameters. Decompiling the APK yields no
 * method secrets: there is nothing to steal.
 *
 * HONEST SECURITY NOTE (defense in depth, not magic): removing static secrets
 * from the APK defeats static decompilation/strings analysis. A ROOTED device
 * with runtime hooking (Frida etc.) could still intercept the decrypted
 * recipe in memory at patch time. That is why the recipe is single-use with
 * a 5-minute TTL, bound to one user + device, and why the client refuses to
 * patch on compromised devices (TamperCheck). No client-side scheme can make
 * a hostile device trustworthy — the server-side credit deduction and
 * single-use recipe rows are the authoritative controls.
 */

'use strict';

// ftyp fingerprint shared by both profiles (reference: isom/512/isom,iso2,mp41).
const FTYP = Object.freeze({
    major: 'isom',
    minor: 512,
    brands: Object.freeze(['isom', 'iso2', 'mp41'])
});

// iTunes metadata keys, mirrored by the client's ilst writer:
//   artist  -> ©ART   comment -> ©cmt   copyright -> ©cpy   encoder -> ©too
const TAG_KEYS = Object.freeze({
    artist: '©ART',
    comment: '©cmt',
    copyright: '©cpy',
    encoder: '©too'
});

// Sentinel: the client computes the 32-char lowercase hex MD5 of the INPUT
// file itself and writes it as the ©cpy (copyright) tag. The server never
// sees the video, so the hash cannot be precomputed here.
const COPYRIGHT_FROM_INPUT_MD5 = 'INPUT_MD5';

// ---- PULSE — Normal method (fast, no re-encode) ------------------------------
// Format tags: artist + comment ONLY. No encoder, no copyright, no custom
// "----" tags. Video handler -> "VideoHandler", audio -> "SoundHandler".
const PULSE = Object.freeze({
    method: 'normal',
    profile: 'pulse',
    ftyp: FTYP,
    formatTags: Object.freeze({
        artist: 'transcode.vague-infinity.com',
        comment: 'kammal_app'
    }),
    // (mean, name, value) triples written as iTunes "----" custom boxes.
    dashTags: Object.freeze([]),
    videoHandlerName: 'VideoHandler',
    audioHandlerName: 'SoundHandler',
    copyrightSource: null
});

// ---- FORGE — Pro method (full re-encode) --------------------------------------
// Format tags: artist + comment + copyright(<md5 of input>) + encoder, plus
// the te_is_reencode=1 custom tag.
const FORGE = Object.freeze({
    method: 'pro',
    profile: 'forge',
    ftyp: FTYP,
    formatTags: Object.freeze({
        artist: 'transcode.vague-infinity.com',
        comment: 'kammal_app',
        encoder: 'Lavf60.16.100'
    }),
    dashTags: Object.freeze([
        Object.freeze({ mean: '', name: 'te_is_reencode', value: '1' })
    ]),
    videoHandlerName: 'VideoHandler',
    audioHandlerName: 'SoundHandler',
    copyrightSource: COPYRIGHT_FROM_INPUT_MD5
});

const METHODS = Object.freeze({ normal: PULSE, pro: FORGE });

/**
 * Returns a deep-cloned recipe object for the given method ("normal"|"pro"),
 * or null for an unknown method. Cloned so per-request code can never mutate
 * the frozen canonical definitions.
 */
function getRecipe(method) {
    const m = METHODS[String(method || '').toLowerCase()];
    if (!m) return null;
    return JSON.parse(JSON.stringify(m));
}

module.exports = { getRecipe, TAG_KEYS, COPYRIGHT_FROM_INPUT_MD5, METHODS: Object.keys(METHODS) };
