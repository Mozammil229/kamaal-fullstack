// PHASE E — Upload security (blueprint E4, user's HARD requirement).
//
// Rules:
// - Whitelist ONLY: jpg/png/webp images, m4a/opus voice. MAGIC BYTES are
//   verified server-side from the file buffer — client MIME/filename/extension
//   is NEVER trusted.
// - Caps: photo 5MB, voice 2MB (multer rejects >5MB at the transport layer;
//   per-kind caps enforced again here before processing).
// - Images: re-encoded + metadata stripped via sharp (no EXIF/GPS survives),
//   resized to a 1600px bound.
// - Voice: accepted as-is after the type check (no trivial transcode available
//   in this stack; bytes are type-verified).
// - Randomized filenames: crypto.randomUUID() + server-validated extension.
// - Writes go to Vercel Blob (public object storage; token from env only).
//   Without BLOB_READ_WRITE_TOKEN the upload answers 503, never a disk error.
// - Auth is enforced at the route layer (authenticateUser on every endpoint);
//   the 30/hr write rate limit is enforced in socialController.
// v91 (BugHunter backend F1): Vercel serverless functions have a READ-ONLY
// filesystem except /tmp — the old write to public/uploads/social/ threw
// EROFS on every upload. Files now go to Vercel Blob (object storage).
// Token comes ONLY from env BLOB_READ_WRITE_TOKEN (Vercel dashboard; the
// user creates the Blob store there). Without a token the endpoint answers
// a clear 503 instead of a fake 400 — uploads are "not configured", not broken.
const crypto = require('crypto');
const multer = require('multer');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_VOICE_BYTES = 2 * 1024 * 1024;

// Multer transport cap: nothing larger than the biggest allowed kind ever
// reaches our code. Memory storage only — unvalidated bytes are NEVER
// written to disk.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1 }
});

function ensureUploadDir() {
    // v91: no local upload dir any more (Vercel Blob, see processUpload).
    // Kept as a no-op so older call sites do not break if referenced.
}

// ---- magic-byte classification -------------------------------------------
// Returns 'jpg' | 'png' | 'webp' | 'm4a' | 'opus' | null.
// Inspects raw bytes only. Offset-4 'ftyp' box = MP4-family container
// (m4a voice notes from MediaRecorder AAC/MPEG_4). 'OggS' = Ogg/Opus.
// v91 (BugHunter backend F27): the old check accepted ANY MP4 as a voice
// note (a video file passed as m4a). Now the ftyp major brand is checked:
// audio brands pass; known video brands fail; ambiguous 'mp42' is accepted
// only when no 'vide' handler track is present in the file.
function hasVideoTrack(buf) {
    // Scan for 'hdlr' boxes; the handler type sits 8 bytes after 'hdlr'.
    const needle = Buffer.from('hdlr', 'ascii');
    let at = 0;
    while (true) {
        const idx = buf.indexOf(needle, at);
        if (idx < 0 || idx + 12 > buf.length) return false;
        if (buf.toString('ascii', idx + 8, idx + 12) === 'vide') return true;
        at = idx + 4;
    }
}

const VIDEO_FTYP_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'dash', 'M4V ', '3gp4', '3gp5', '3gp6']);

function classifyByMagicBytes(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const b = buf;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
        b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // 'RIFF'
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'; // 'WEBP'
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) { // 'ftyp'
        const brand = b.toString('ascii', 8, 12);
        if (VIDEO_FTYP_BRANDS.has(brand)) return null;
        if (brand === 'mp42' && hasVideoTrack(b)) return null;
        return 'm4a';
    }
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'opus'; // 'OggS'
    return null;
}

function isImageExt(ext) { return ext === 'jpg' || ext === 'png' || ext === 'webp'; }
function isVoiceExt(ext) { return ext === 'm4a' || ext === 'opus'; }

// Validates + persists one multer file buffer. kind: 'photo' | 'voice'.
// Returns { url, ext }. Throws with a human-safe message on any rejection.
async function processUpload(file, kind) {
    if (!file || !file.buffer || !file.buffer.length) {
        throw new Error('No file received.');
    }
    const wantPhoto = kind === 'photo';
    const cap = wantPhoto ? MAX_PHOTO_BYTES : MAX_VOICE_BYTES;
    if (file.buffer.length > cap) {
        throw new Error(wantPhoto ? 'Photo too large (max 5MB).' : 'Voice note too large (max 2MB).');
    }
    const ext = classifyByMagicBytes(file.buffer);
    if (!ext) {
        throw new Error('File type not allowed. Only JPG, PNG, WebP images and M4A/Opus voice notes are accepted.');
    }
    if (wantPhoto && !isImageExt(ext)) throw new Error('Only JPG, PNG, or WebP photos are accepted.');
    if (!wantPhoto && !isVoiceExt(ext)) throw new Error('Only M4A or Opus voice notes are accepted.');

    let bytes = file.buffer;
    if (wantPhoto) {
        // Re-encode + strip ALL metadata (sharp strips metadata by default
        // unless .withMetadata() is called). 1600px bound keeps files small.
        // Lazy-require so a missing sharp install fails loudly at first use,
        // not at module load.
        const sharp = require('sharp');
        let pipeline = sharp(bytes).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true });
        if (ext === 'jpg') pipeline = pipeline.jpeg({ quality: 85 });
        else if (ext === 'png') pipeline = pipeline.png({ compressionLevel: 8 });
        else pipeline = pipeline.webp({ quality: 85 });
        bytes = await pipeline.toBuffer();
    }
    // Voice: accepted as-is after the magic-byte type check (E4 spec).

    // v91 (BugHunter backend F1): persist to Vercel Blob, never the local
    // disk (read-only on Vercel). Token from env only; without it the caller
    // gets a 503 with a human message instead of an EROFS 400.
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
        const err = new Error('Uploads are not configured on the server yet. Please try again later.');
        err.status = 503;
        throw err;
    }
    const { put } = require('@vercel/blob');
    const filename = `social/${crypto.randomUUID()}.${ext}`;
    const contentType = ext === 'jpg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'webp' ? 'image/webp'
        : ext === 'opus' ? 'audio/ogg'
        : 'audio/mp4';
    const blob = await put(filename, bytes, { access: 'public', contentType, token: blobToken });
    return { url: blob.url, ext };
}

module.exports = {
    upload,
    processUpload,
    classifyByMagicBytes,
    MAX_PHOTO_BYTES,
    MAX_VOICE_BYTES
};
