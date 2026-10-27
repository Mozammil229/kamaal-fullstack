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
 *
 * v43 (2026-10-21) — METHOD 3 (user-approved): the user's Python timescale
 * system as a third method. NOT a metadata method: the recipe is a pure
 * directive {mode: "timescale-normalize", targetFps: 30}. The client
 * measures the video track's real fps from its stts table, then rescales
 * the mvhd + every mdhd timescale by targetFps/fps (durations untouched)
 * on a stream copy of the original file. No remux, no re-encode, NO
 * metadata stamp — every stamp field below is null/empty by design.
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
        artist: 'Kamaal App',
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
        artist: 'Kamaal App',
        comment: 'Kamaal App',
        encoder: 'Kamaal App'
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

// ---- METHOD 3 — Python timescale system (v43, user-supplied method) --------
// NOT a metadata method: this recipe is a pure client directive. The client
// stream-copies the original file, measures the video track's real fps from
// its stts table, and rescales the mvhd + every mdhd timescale by
// targetFps/fps with durations untouched (the file then registers at
// ~targetFps). No remux, no re-encode, NO metadata stamp — so every stamp
// field is null/empty by design, and the client parser requires exactly
// that shape for this mode (fail-closed).
const METHOD3 = Object.freeze({
    method: 'method3',
    profile: 'method3',
    mode: 'timescale-normalize',
    targetFps: 30,
    ftyp: null,
    formatTags: Object.freeze({}),
    dashTags: Object.freeze([]),
    videoHandlerName: null,
    audioHandlerName: null,
    streamLanguage: null,
    copyrightSource: null,
    secondAudioTrack: null
});

// ---- METHOD 4 — AFS Convert recipe (v90, user-approved) --------------------
// Directive-style like Method 3 (NOT a metadata method): the client remuxes
// (video copy + AAC copy/transcode + silent AAC if no audio), then applies
// the AFS-shaped patch (mvhd v1 / timescale 1000 / duration all-ones /
// next_track 4, 3 tracks with a 9x-filler audio clone, trailing 8-byte free)
// and stamps video-trak ©too = tag ("Kamaal App"). No hash in the tag
// (decision §4.5: AFS-style no-hash; Forge keeps the hash as its
// differentiator). BUG-AS-IS (plan §10): the clone mdhd is byte-identical,
// the stts tail [9N, 1] is kept even though the stts sum overshoots the
// mdhd duration, handler names use the 20-byte hdlr prefix, rotation/VFR
// are preserved — the client verifier asserts these quirks are PRESENT.
const METHOD4 = Object.freeze({
    method: 'method4',
    profile: 'method4',
    mode: 'afs-convert',
    subMode: 'tiktok',
    tag: 'Kamaal App',
    metaStyle: 'ilst',
    mvhdTimescale: 1000,
    cloneMdhdIdentical: true,
    trailingFree: true,
    secondAudioTrack: SECOND_AUDIO_TRACK_FORGE,
    limits: Object.freeze({ maxLong: 4096, maxShort: 2304, maxFps: 120.5, maxDurationS: 900 }),
    ftyp: null,
    formatTags: Object.freeze({}),
    dashTags: Object.freeze([]),
    videoHandlerName: null,
    audioHandlerName: null,
    streamLanguage: 'und',
    copyrightSource: null
});

// ---- METHOD 5 — Lavf remux fingerprint (v90, user-approved) -----------------
// Directive-style like Method 4: the client remuxes (same base as Method 4)
// and shapes the output like an ordinary Lavf remux — top order
// ftyp,free,moov,mdat; mvhd v0 with the REAL (format) duration; exactly 2
// tracks; moov-level udta/meta/ilst/©too = tag ("Kamaal App", substituted
// for the reference's "Lavf62.3.100" per decision §4.6); handlers
// VideoHandle/SoundHandle with the STANDARD 24-byte hdlr prefix; language
// eng (not und). NO clone, NO fake samples, NO extra chunk, NO trailing
// free. BUG-AS-IS (plan §10): VFR stts preserved, audio-longer-than-video
// preserved (mvhd duration follows the longer format duration), rotation /
// coded dims preserved.
const METHOD5 = Object.freeze({
    method: 'method5',
    profile: 'method5',
    mode: 'lavf-remux',
    tag: 'Kamaal App',
    metaStyle: 'ilst-moov',
    mvhdVersion: 0,
    mvhdTimescale: 1000,
    language: 'eng',
    handlers: Object.freeze(['VideoHandle', 'SoundHandle']),
    secondAudioTrack: 'none',
    trailingFree: false,
    limits: Object.freeze({ maxLong: 4096, maxShort: 2304, maxFps: 120.5, maxDurationS: 900 }),
    ftyp: null,
    formatTags: Object.freeze({}),
    dashTags: Object.freeze([]),
    videoHandlerName: 'VideoHandle',
    audioHandlerName: 'SoundHandle',
    streamLanguage: 'eng',
    copyrightSource: null
});

const METHODS = Object.freeze({ normal: PULSE, pro: FORGE, method3: METHOD3, method4: METHOD4, method5: METHOD5 });

/**
 * Returns a deep-cloned recipe object for the given method
 * ("normal"|"pro"|"method3"|"method4"|"method5"), or null for an unknown method. Cloned so
 * per-request code can never mutate the frozen canonical definitions.
 */
function getRecipe(method) {
    const m = METHODS[String(method || '').toLowerCase()];
    if (!m) return null;
    return JSON.parse(JSON.stringify(m));
}

module.exports = { getRecipe, TAG_KEYS, COPYRIGHT_FROM_INPUT_SHA256_32, SECOND_AUDIO_TRACK_FORGE, METHODS: Object.keys(METHODS) };
