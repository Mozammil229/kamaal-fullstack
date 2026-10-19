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
// - Writes go to public/uploads/social/ (served by express.static in app.js).
// - Auth is enforced at the route layer (authenticateUser on every endpoint);
//   the 30/hr write rate limit is enforced in socialController.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'social');
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
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ---- magic-byte classification -------------------------------------------
// Returns 'jpg' | 'png' | 'webp' | 'm4a' | 'opus' | null.
// Inspects raw bytes only. Offset-4 'ftyp' box = MP4-family container
// (m4a voice notes from MediaRecorder AAC/MPEG_4). 'OggS' = Ogg/Opus.
function classifyByMagicBytes(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    const b = buf;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
        b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // 'RIFF'
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'; // 'WEBP'
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'; // 'ftyp'
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

    ensureUploadDir();
    const filename = `${crypto.randomUUID()}.${ext}`;
    const fullPath = path.join(UPLOAD_DIR, filename);
    // filename is 100% server-generated (randomUUID + validated ext) — no
    // path traversal possible.
    await fs.promises.writeFile(fullPath, bytes);
    return { url: `/uploads/social/${filename}`, ext };
}

module.exports = {
    upload,
    processUpload,
    classifyByMagicBytes,
    MAX_PHOTO_BYTES,
    MAX_VOICE_BYTES
};
