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
 *
 * v38 (2026-10-20) — recipes now mirror the user-supplied REFERENCE outputs
 * (Pulse/Forge files verified with ffprobe + streamhash + box analysis):
 *   - comment tag is the method name ("Pulse" / "Forge"), not "kammal_app";
 *   - every stream's mdhd language is stamped "und";
 *   - Forge copyright is the first 32 hex chars of the SOURCE file's
 *     SHA-256 (client-computed; the server never sees the video);
 *   - Forge carries a second audio track: the primary AAC frames duplicated
 *     plus 9xN appended 8-byte filler samples with stts delta 1.
 * This SUPERSEDES the older custom ffprobe spec (hvc1 compatible_brands,
 * "kammal_app"/"Mozammil_Talk" handler names, INPUT_MD5 copyright) for these
 * two methods.
 *
 * v42 (2026-10-21) — pattern-match round 2 (user-approved):
 *   - comment tag is "Kamaal App" in BOTH methods (user override; the
 *     reference files carry the method name, ours carries the app brand);
 *   - new `metaStyle` directive: Pulse metadata stays iTunes `ilst`
 *     (©ART/©cmt items, as in the Pulse reference); Forge metadata is
 *     written mdta `keys` style exactly as in the Forge reference — a
 *     `keys` box (namespace "mdta") with entries in `metaKeys` order and
 *     an `ilst` whose items are the 1-based key indices. In keys style
 *     ALL Forge tags come from the recipe: formatTags (artist, comment,
 *     encoder), the copyright sentinel, and dashTags (te_is_reencode);
 *     dashTags are NOT written as iTunes "----" freeform boxes in keys
 *     style — they are keys entries like the rest.
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

// Sentinel: the client computes the SHA-256 of the INPUT file itself and
// writes the first 32 lowercase hex chars as the ©cpy (copyright) tag. The
// server never sees the video, so the hash cannot be precomputed here.
// (Matches the reference Forge output, whose ©cpy is the first 32 hex chars
// of the source file's SHA-256 name.)
const COPYRIGHT_FROM_INPUT_SHA256_32 = 'sha256:32';

// Structural directive for the Forge second audio track: duplicate the
// primary track's AAC frames, then append 9 filler samples per real frame —
// each filler is 8 bytes with an stts delta of 1 (see client stamper).
const SECOND_AUDIO_TRACK_FORGE = 'dup+9x-filler';

// ---- PULSE — Normal method (video copy + AAC re-encode, no re-encode of video)
// Format tags: artist + comment ONLY. No encoder, no copyright, no custom
// "----" tags. Video handler -> "VideoHandler", audio -> "SoundHandler",
// stream language -> "und".
const PULSE = Object.freeze({
    method: 'normal',
    profile: 'pulse',
    ftyp: FTYP,
    // Metadata container style: iTunes ilst items (see TAG_KEYS), exactly
    // as the Pulse reference carries them (©ART + ©cmt only).
    metaStyle: 'ilst',
    formatTags: Object.freeze({
        artist: 'transcode.vague-infinity.com',
        comment: 'Kamaal App'
    }),
    // (mean, name, value) triples written as iTunes "----" custom boxes.
    dashTags: Object.freeze([]),
    videoHandlerName: 'VideoHandler',
    audioHandlerName: 'SoundHandler',
    streamLanguage: 'und',
    copyrightSource: null,
    secondAudioTrack: null
});

// ---- FORGE — Pro method (Pulse pipeline + second audio track) ---------------
// Format tags: artist + comment + copyright(<sha256:32 of input>) + encoder,
// plus the te_is_reencode=1 custom tag. The video stream is still copied
// untouched — "re-encode" is the method's label, exactly as in the reference.
const FORGE = Object.freeze({
    method: 'pro',
    profile: 'forge',
    ftyp: FTYP,
    // Metadata container style: mdta `keys`, exactly as the Forge
    // reference carries it. `metaKeys` is the ordered key list for the
    // `keys` box (namespace "mdta"); the client writes one ilst data
    // item per key, addressed by its 1-based index in this list. Value
    // sources: artist/comment/encoder <- formatTags, copyright <- the
    // copyrightSource sentinel, te_is_reencode <- dashTags.
    metaStyle: 'keys',
    metaKeys: Object.freeze(['artist', 'comment', 'copyright', 'te_is_reencode', 'encoder']),
    formatTags: Object.freeze({
        artist: 'transcode.vague-infinity.com',
        comment: 'Kamaal App',
        encoder: 'Lavf60.16.100'
    }),
    dashTags: Object.freeze([
        Object.freeze({ mean: '', name: 'te_is_reencode', value: '1' })
    ]),
    videoHandlerName: 'VideoHandler',
    audioHandlerName: 'SoundHandler',
    streamLanguage: 'und',
    copyrightSource: COPYRIGHT_FROM_INPUT_SHA256_32,
    secondAudioTrack: SECOND_AUDIO_TRACK_FORGE
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

module.exports = { getRecipe, TAG_KEYS, COPYRIGHT_FROM_INPUT_SHA256_32, SECOND_AUDIO_TRACK_FORGE, METHODS: Object.keys(METHODS) };
