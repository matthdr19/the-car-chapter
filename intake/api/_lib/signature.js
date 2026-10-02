// Server-side file-signature validation for source uploads (Intake v0.2).
//
// Fail closed: ok is true only when the leading bytes clearly match exactly one accepted
// format AND the declared MIME type belongs to that format. It inspects at most SNIFF_BYTES
// bytes, never decodes, re-encodes or resizes anything, and never mutates its input.
//
// A matching signature is not proof of a valid or safe image. Sources stay untrusted.
import { SNIFF_BYTES, isAllowedMime } from '../../shared/rules.js';

export const REASONS = Object.freeze({
  TOO_SHORT: 'too_short',
  INVALID_FTYP: 'invalid_ftyp',
  UNKNOWN_FORMAT: 'unknown_format',
  TYPE_MISMATCH: 'type_mismatch',
});

// detectedType values. HEIC and HEIF share one accepted family because real files mix brands.
const FORMAT_FOR_MIME = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/heic': 'image/heif',
  'image/heif': 'image/heif',
});

const ascii = (text) => Array.from(text, (character) => character.charCodeAt(0));

const JPEG_SOI = [0xff, 0xd8, 0xff];
const JPEG_MIN_BYTES = 4; // FF D8 FF plus the marker byte that follows
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const FTYP = ascii('ftyp');
const MIN_FTYP_BOX = 16; // size(4) + 'ftyp'(4) + major brand(4) + minor version(4)

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
// Any AVIF brand anywhere rejects the file, even next to mif1 or msf1. Compared lowercase.
const AVIF_BRANDS = new Set(['avif', 'avis']);

const NO = Object.freeze({ status: 'no' });
const SHORT = Object.freeze({ status: 'short' });
const INVALID_FTYP = Object.freeze({ status: 'invalid_ftyp' });
const UNKNOWN = Object.freeze({ status: 'unknown' });
const match = (type) => Object.freeze({ status: 'match', type });

// Every pattern byte is present and equal.
function matchesAt(view, pattern, offset) {
  if (view.length < offset + pattern.length) return false;
  return pattern.every((value, index) => view[offset + index] === value);
}

// Every byte that is present equals the pattern. Bytes not yet available are ignored.
function consistentAt(view, pattern, offset) {
  for (let index = 0; index < pattern.length; index++) {
    const position = offset + index;
    if (position >= view.length) return true;
    if (view[position] !== pattern[index]) return false;
  }
  return true;
}

function tryJpeg(view) {
  if (!consistentAt(view, JPEG_SOI, 0)) return NO;
  if (view.length < JPEG_MIN_BYTES) return SHORT;
  const marker = view[3];
  return marker >= 0xc0 && marker <= 0xfe ? match('image/jpeg') : NO;
}

function tryPng(view) {
  if (!consistentAt(view, PNG_SIGNATURE, 0)) return NO;
  return view.length < PNG_SIGNATURE.length ? SHORT : match('image/png');
}

function tryWebp(view) {
  if (!consistentAt(view, RIFF, 0) || !consistentAt(view, WEBP, 8)) return NO;
  return view.length < 12 ? SHORT : match('image/webp');
}

function brandAt(view, offset) {
  return String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
}

// ISO BMFF 'ftyp' box: 32-bit size only, 16 to SNIFF_BYTES bytes, fully inside the bytes
// provided, with the compatible-brand area made of whole 4-byte entries.
function tryBmff(view) {
  const length = view.length;

  if (length < 8) {
    // The 'ftyp' tag is not fully visible yet: judge only what a valid box could look like.
    if (length >= 1 && view[0] !== 0x00) return NO;
    if (length >= 2 && view[1] !== 0x00) return NO;
    if (length >= 3 && view[2] > 0x10) return NO;
    if (length >= 4) {
      const early = ((view[0] << 24) | (view[1] << 16) | (view[2] << 8) | view[3]) >>> 0;
      if (early < MIN_FTYP_BOX || early > SNIFF_BYTES) return NO;
    }
    return consistentAt(view, FTYP, 4) ? SHORT : NO;
  }

  if (!matchesAt(view, FTYP, 4)) return NO;
  // From here the bytes claim to be an ftyp box, so structural problems are invalid_ftyp.
  if (length < MIN_FTYP_BOX) return SHORT;

  const size = ((view[0] << 24) | (view[1] << 16) | (view[2] << 8) | view[3]) >>> 0;
  if (size === 0) return INVALID_FTYP; // box runs to end of file
  if (size === 1) return INVALID_FTYP; // 64-bit extended-size form
  if (size < MIN_FTYP_BOX || size > SNIFF_BYTES) return INVALID_FTYP;
  if (size > length) return INVALID_FTYP; // box must fit in the bytes provided
  if ((size - MIN_FTYP_BOX) % 4 !== 0) return INVALID_FTYP; // whole 4-byte brand entries

  const brands = [brandAt(view, 8)];
  for (let offset = MIN_FTYP_BOX; offset < size; offset += 4) brands.push(brandAt(view, offset));

  if (brands.some((brand) => AVIF_BRANDS.has(brand.toLowerCase()))) return UNKNOWN;
  return brands.some((brand) => HEIF_BRANDS.has(brand)) ? match('image/heif') : UNKNOWN;
}

function fail(reason, detectedType = null) {
  return { ok: false, detectedType, reason };
}

// bytes: Uint8Array (or Buffer) holding the start of the stored source file.
// Returns { ok, detectedType, reason }. detectedType is set when a format was recognised,
// including on type_mismatch, so the recorded provenance stays honest.
export function checkSignature(declaredMime, bytes) {
  try {
    if (!(bytes instanceof Uint8Array)) return fail(REASONS.UNKNOWN_FORMAT);

    const view = bytes.subarray(0, Math.min(bytes.length, SNIFF_BYTES));
    const attempts = [tryJpeg(view), tryPng(view), tryWebp(view), tryBmff(view)];
    const matches = attempts.filter((attempt) => attempt.status === 'match');

    if (matches.length > 0) {
      // Exactly one clear match, and every other format must plainly not apply.
      const ambiguous =
        matches.length > 1 || attempts.some((attempt) => attempt.status !== 'match' && attempt.status !== 'no');
      if (ambiguous) return fail(REASONS.UNKNOWN_FORMAT);

      const detectedType = matches[0].type;
      const declaredFormat = isAllowedMime(declaredMime) ? FORMAT_FOR_MIME[declaredMime] : null;
      if (declaredFormat !== detectedType) return fail(REASONS.TYPE_MISMATCH, detectedType);
      return { ok: true, detectedType, reason: null };
    }

    if (attempts.some((attempt) => attempt.status === 'invalid_ftyp')) return fail(REASONS.INVALID_FTYP);
    if (attempts.some((attempt) => attempt.status === 'unknown')) return fail(REASONS.UNKNOWN_FORMAT);
    if (attempts.some((attempt) => attempt.status === 'short')) return fail(REASONS.TOO_SHORT);
    return fail(REASONS.UNKNOWN_FORMAT);
  } catch {
    return fail(REASONS.UNKNOWN_FORMAT);
  }
}
