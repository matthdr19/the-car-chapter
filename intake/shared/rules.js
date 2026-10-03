// Shared rules for The Car Chapter Intake v0.2.
// Pure ES module, no Node-only imports: the browser and the Vercel Functions both use it.

// 50 MiB per file, exactly 52,428,800 bytes. Enforced at signing and again at submit.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Hard maximum. The UI recommends 3 to 6 photos and never requires more than the minimum.
export const MAX_FILES = 10;
// Technical minimum only (at least one clear vehicle reference). Not a recommendation.
export const MIN_FILES = 1;
export const RECOMMENDED_FILES = Object.freeze({ min: 3, max: 6 });

export const SIGNED_URL_TTL_MS = 30 * 60 * 1000;
// The server inspects at most this many leading bytes of a source file.
export const SNIFF_BYTES = 4096;

// The extension is derived from the validated MIME type, never from a filename.
const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
});

// Every allowed source MIME type, in the mapping's own order. Derived from EXT_BY_MIME so that
// mapping stays the single source of truth: there is no second handwritten list of types.
export const ALLOWED_MIME_TYPES = Object.freeze(Object.keys(EXT_BY_MIME));

const MIME_BY_EXT = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
});

// Canonical lowercase UUIDv4 only, as produced by crypto.randomUUID().
// Uppercase or otherwise non-canonical forms are rejected, never normalised.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PILOT_REF = /^[a-z][a-z0-9]{0,15}$/;

export function isAllowedMime(mime) {
  return typeof mime === 'string' && Object.hasOwn(EXT_BY_MIME, mime);
}

export function extForMime(mime) {
  return isAllowedMime(mime) ? EXT_BY_MIME[mime] : null;
}

// PROVISIONAL fallback for browsers that leave File.type empty (notably HEIC/HEIF).
// It only guesses a label from the filename. It is NEVER verification: the server-side
// signature check on the stored bytes alone decides whether a source is accepted.
export function mimeFromExtension(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  const ext = filename.slice(dot + 1).toLowerCase();
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : '';
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

// Opaque pilot label resolved server-side from the access token (for example "p1").
export function isPilotRef(value) {
  return typeof value === 'string' && PILOT_REF.test(value);
}

export function isValidFileSize(size) {
  return Number.isInteger(size) && size >= 1 && size <= MAX_FILE_BYTES;
}

// cases/{pilotRef}/{caseId}/{sourceId}.{ext}: built only from validated identifiers,
// so no name, email or original filename can ever reach a storage pathname.
// Error messages never echo the rejected value.
export function blobPathname({ pilotRef, caseId, sourceId, mime }) {
  if (!isPilotRef(pilotRef)) throw new Error('invalid pilotRef');
  if (!isUuid(caseId)) throw new Error('invalid caseId');
  if (!isUuid(sourceId)) throw new Error('invalid sourceId');
  const ext = extForMime(mime);
  if (ext === null) throw new Error('invalid mime');
  return `cases/${pilotRef}/${caseId}/${sourceId}.${ext}`;
}
