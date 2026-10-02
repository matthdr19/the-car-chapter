import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSignature, REASONS } from '../api/_lib/signature.js';
import { SNIFF_BYTES } from '../shared/rules.js';

// ---- Synthetic fixtures: built here from bytes, never from customer files ----

const ascii = (text) => Array.from(text, (character) => character.charCodeAt(0));
const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
// Each part is an array or Uint8Array of byte values. Parts are copied in order.
const concat = (...parts) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));
const zeros = (count) => new Array(count).fill(0);

function jpeg(marker = 0xe0) {
  return concat([0xff, 0xd8, 0xff, marker], [0x00, 0x10], ascii('JFIF'), [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], zeros(16));
}
function png() {
  return concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(13), ascii('IHDR'), zeros(13), zeros(16));
}
function webp() {
  return concat(ascii('RIFF'), [0x1a, 0x00, 0x00, 0x00], ascii('WEBP'), ascii('VP8 '), zeros(16));
}
// Well-formed ftyp box (size derived from the brand list) followed by filler, like a real file.
function ftyp({ major, compat = [], tail = 32 }) {
  const size = 16 + 4 * compat.length;
  return concat(u32(size), ascii('ftyp'), ascii(major), u32(0), compat.flatMap(ascii), zeros(tail));
}
// ftyp-shaped bytes with an explicit size field, for malformed-structure cases.
function rawFtyp({ size, major = 'heic', compat = [], total = 64 }) {
  const head = [...u32(size), ...ascii('ftyp'), ...ascii(major), ...u32(0), ...compat.flatMap(ascii)];
  const filler = Math.max(0, total - head.length);
  return concat(head, zeros(filler));
}

const HEIC = () => ftyp({ major: 'heic', compat: ['mif1', 'heic'] });

function assertOk(result, detectedType) {
  assert.deepEqual(result, { ok: true, detectedType, reason: null });
}
function assertFail(result, reason, detectedType = null) {
  assert.deepEqual(result, { ok: false, detectedType, reason });
}

// ---- Accepted formats ----

test('accepts a valid JPEG declared as image/jpeg, for the usual markers', () => {
  for (const marker of [0xe0, 0xe1, 0xdb, 0xee, 0xfe, 0xc0]) {
    assertOk(checkSignature('image/jpeg', jpeg(marker)), 'image/jpeg');
  }
});

test('accepts a valid PNG declared as image/png', () => {
  assertOk(checkSignature('image/png', png()), 'image/png');
});

test('accepts a valid WEBP declared as image/webp', () => {
  assertOk(checkSignature('image/webp', webp()), 'image/webp');
});

test('accepts HEIC/HEIF as one family, declared as either image/heic or image/heif', () => {
  assertOk(checkSignature('image/heic', HEIC()), 'image/heif');
  assertOk(checkSignature('image/heif', HEIC()), 'image/heif');
});

test('accepts the other HEIF-family brand layouts', () => {
  const layouts = [
    { major: 'mif1', compat: ['heic'] },
    { major: 'heix', compat: [] },
    { major: 'hevc', compat: ['mif1'] },
    { major: 'msf1', compat: ['heis'] },
    { major: 'isom', compat: ['iso2', 'heic'] }, // accepted brand only in the compatible list
    { major: 'heim', compat: ['hevx', 'heis'] },
  ];
  for (const layout of layouts) {
    assertOk(checkSignature('image/heic', ftyp(layout)), 'image/heif');
  }
});

test('accepts a Buffer as well as a plain Uint8Array', () => {
  assertOk(checkSignature('image/jpeg', Buffer.from(jpeg())), 'image/jpeg');
});

// ---- JPEG: FF D8 FF alone is not enough ----

test('JPEG: FF D8 FF alone, and every shorter prefix, is too_short', () => {
  assertFail(checkSignature('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff])), REASONS.TOO_SHORT);
  assertFail(checkSignature('image/jpeg', Uint8Array.from([0xff, 0xd8])), REASONS.TOO_SHORT);
  assertFail(checkSignature('image/jpeg', Uint8Array.from([0xff])), REASONS.TOO_SHORT);
  assertFail(checkSignature('image/jpeg', new Uint8Array(0)), REASONS.TOO_SHORT);
});

test('JPEG: FF D8 FF followed by a non-marker byte is unknown_format', () => {
  for (const marker of [0x00, 0x01, 0xbf, 0xff]) {
    assertFail(checkSignature('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff, marker, 0, 0, 0, 0])), REASONS.UNKNOWN_FORMAT);
  }
});

// ---- PNG and WEBP ----

test('PNG: a truncated or corrupted signature never passes', () => {
  assertFail(checkSignature('image/png', png().subarray(0, 7)), REASONS.TOO_SHORT);
  const corrupted = png();
  corrupted[7] = 0x0b;
  assertFail(checkSignature('image/png', corrupted), REASONS.UNKNOWN_FORMAT);
});

test('WEBP: needs RIFF and WEBP, and truncated input is too_short', () => {
  assertFail(checkSignature('image/webp', webp().subarray(0, 11)), REASONS.TOO_SHORT);
  assertFail(checkSignature('image/webp', webp().subarray(0, 4)), REASONS.TOO_SHORT);
  const wave = concat(ascii('RIFF'), [0x1a, 0, 0, 0], ascii('WAVE'), zeros(16));
  assertFail(checkSignature('image/webp', wave), REASONS.UNKNOWN_FORMAT);
  const rifx = concat(ascii('RIFX'), [0x1a, 0, 0, 0], ascii('WEBP'), zeros(16));
  assertFail(checkSignature('image/webp', rifx), REASONS.UNKNOWN_FORMAT);
});

// ---- ISO BMFF structure: invalid_ftyp ----

test('ftyp: box size 0 and the 64-bit extended-size form are invalid_ftyp', () => {
  assertFail(checkSignature('image/heic', rawFtyp({ size: 0 })), REASONS.INVALID_FTYP);
  assertFail(checkSignature('image/heic', rawFtyp({ size: 1 })), REASONS.INVALID_FTYP);
});

test('ftyp: box size below 16 is invalid_ftyp', () => {
  for (const size of [2, 8, 12, 15]) {
    assertFail(checkSignature('image/heic', rawFtyp({ size })), REASONS.INVALID_FTYP);
  }
});

test('ftyp: box size above the 4096-byte ceiling is invalid_ftyp, even when the bytes are there', () => {
  const big = rawFtyp({ size: 4100, total: 8000 });
  assert.equal(big.length > SNIFF_BYTES, true);
  assertFail(checkSignature('image/heic', big), REASONS.INVALID_FTYP);
  assertFail(checkSignature('image/heic', rawFtyp({ size: 0x7fffffff })), REASONS.INVALID_FTYP);
});

test('ftyp: box larger than the bytes provided is invalid_ftyp', () => {
  assertFail(checkSignature('image/heic', rawFtyp({ size: 40, total: 32 })), REASONS.INVALID_FTYP);
});

test('ftyp: a compatible-brand area that is not whole 4-byte entries is invalid_ftyp', () => {
  for (const size of [17, 18, 19, 22, 26]) {
    assertFail(checkSignature('image/heic', rawFtyp({ size, compat: ['mif1', 'heic'] })), REASONS.INVALID_FTYP);
  }
});

test('ftyp: a truncated box (16 bytes or more, shorter than its size) is invalid_ftyp', () => {
  const full = HEIC();
  for (let length = 16; length < 24; length++) {
    assertFail(checkSignature('image/heic', full.subarray(0, length)), REASONS.INVALID_FTYP);
  }
  assertOk(checkSignature('image/heic', full.subarray(0, 24)), 'image/heif');
});

test('ftyp: boundary sizes 16 and exactly 4096 are accepted when well formed', () => {
  assertOk(checkSignature('image/heic', ftyp({ major: 'heic', compat: [] })), 'image/heif');
  const compat = new Array(1020).fill('mif1'); // 16 + 4 * 1020 = 4096
  const box = ftyp({ major: 'heic', compat, tail: 4000 });
  assert.equal(box.length > SNIFF_BYTES, true);
  assertOk(checkSignature('image/heic', box), 'image/heif');
});

test('ftyp: fewer than 16 bytes with the ftyp tag visible is too_short', () => {
  for (let length = 8; length < 16; length++) {
    assertFail(checkSignature('image/heic', HEIC().subarray(0, length)), REASONS.TOO_SHORT);
  }
});

// ---- ISO BMFF brands: unknown_format ----

test('ftyp: structurally valid but no accepted HEIF-family brand is unknown_format', () => {
  const others = [
    { major: 'isom', compat: ['iso2', 'mp41'] }, // MP4
    { major: 'qt  ', compat: [] }, // QuickTime
    { major: 'M4A ', compat: ['mp42', 'isom'] },
    { major: 'HEIC', compat: [] }, // brands are case-sensitive for acceptance
  ];
  for (const layout of others) {
    assertFail(checkSignature('image/heic', ftyp(layout)), REASONS.UNKNOWN_FORMAT);
  }
});

test('AVIF: any avif or avis brand rejects the file, including next to mif1 or msf1', () => {
  const avifLayouts = [
    { major: 'avif', compat: [] },
    { major: 'avis', compat: [] },
    { major: 'avif', compat: ['mif1', 'miaf'] },
    { major: 'mif1', compat: ['avif'] }, // AVIF + mif1
    { major: 'msf1', compat: ['avis'] }, // AVIS + msf1
    { major: 'heic', compat: ['mif1', 'avif'] }, // accepted major, AVIF compatible brand
    { major: 'heic', compat: ['avis', 'msf1'] },
    { major: 'mif1', compat: ['heic', 'AVIF'] }, // uppercase AVIF is still rejected
  ];
  for (const layout of avifLayouts) {
    assertFail(checkSignature('image/heic', ftyp(layout)), REASONS.UNKNOWN_FORMAT);
    assertFail(checkSignature('image/heif', ftyp(layout)), REASONS.UNKNOWN_FORMAT);
  }
});

test('AVIF: an avif brand late in a long compatible-brand list is still rejected', () => {
  const compat = new Array(500).fill('mif1');
  compat[499] = 'avif';
  assertFail(checkSignature('image/heic', ftyp({ major: 'heic', compat })), REASONS.UNKNOWN_FORMAT);
});

// ---- Declared type must match: type_mismatch ----

test('type_mismatch: HEIC bytes declared as PNG or JPEG (the spike reproduction)', () => {
  assertFail(checkSignature('image/png', HEIC()), REASONS.TYPE_MISMATCH, 'image/heif');
  assertFail(checkSignature('image/jpeg', HEIC()), REASONS.TYPE_MISMATCH, 'image/heif');
});

test('type_mismatch: every accepted format declared as a different one', () => {
  assertFail(checkSignature('image/jpeg', png()), REASONS.TYPE_MISMATCH, 'image/png');
  assertFail(checkSignature('image/png', jpeg()), REASONS.TYPE_MISMATCH, 'image/jpeg');
  assertFail(checkSignature('image/png', webp()), REASONS.TYPE_MISMATCH, 'image/webp');
  assertFail(checkSignature('image/heic', png()), REASONS.TYPE_MISMATCH, 'image/png');
  assertFail(checkSignature('image/heif', jpeg()), REASONS.TYPE_MISMATCH, 'image/jpeg');
  assertFail(checkSignature('image/webp', HEIC()), REASONS.TYPE_MISMATCH, 'image/heif');
});

test('type_mismatch: a declared type outside the allow-list never passes', () => {
  for (const declared of ['image/gif', 'image/avif', 'application/pdf', '', 'constructor', '__proto__', null, undefined, 42]) {
    assertFail(checkSignature(declared, jpeg()), REASONS.TYPE_MISMATCH, 'image/jpeg');
  }
});

// ---- Unknown or ambiguous bytes fail ----

test('unknown_format: other file types and non-image bytes', () => {
  const samples = [
    ascii('GIF89a'),
    ascii('%PDF-1.7\n'),
    ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ascii('hello world, this is text'),
    zeros(100),
    [0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0], // ZIP
    [0x41, 0x42], // two bytes that start no accepted format
  ];
  for (const sample of samples) {
    assertFail(checkSignature('image/jpeg', Uint8Array.from(sample)), REASONS.UNKNOWN_FORMAT);
  }
});

test('ambiguous bytes fail closed: a JPEG start that also carries an ftyp tag', () => {
  const polyglot = concat([0xff, 0xd8, 0xff, 0xe0], ascii('ftyp'), ascii('heic'), u32(0), zeros(32));
  const result = checkSignature('image/jpeg', polyglot);
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASONS.UNKNOWN_FORMAT);
});

test('non-byte inputs never throw and never pass', () => {
  for (const input of [null, undefined, 'ffd8ffe0', [0xff, 0xd8, 0xff, 0xe0], new ArrayBuffer(16), 42, {}]) {
    assertFail(checkSignature('image/jpeg', input), REASONS.UNKNOWN_FORMAT);
  }
});

// ---- Windowing, prefixes and invariants ----

test('only the first SNIFF_BYTES are inspected, and the input is not modified', () => {
  assert.equal(SNIFF_BYTES, 4096);
  const longJpeg = concat(jpeg(), zeros(9000));
  const before = Uint8Array.from(longJpeg);
  assertOk(checkSignature('image/jpeg', longJpeg), 'image/jpeg');
  assert.deepEqual(longJpeg, before);
  // An avif brand far beyond the window cannot be seen, and a small valid box still passes.
  const farAvif = concat(HEIC(), zeros(6000), ascii('avif'));
  assertOk(checkSignature('image/heic', farAvif), 'image/heif');
});

test('every proper prefix of a valid file is rejected until the signature can be judged', () => {
  const cases = [
    { name: 'jpeg', mime: 'image/jpeg', bytes: jpeg(), minimum: 4 },
    { name: 'png', mime: 'image/png', bytes: png(), minimum: 8 },
    { name: 'webp', mime: 'image/webp', bytes: webp(), minimum: 12 },
  ];
  for (const sample of cases) {
    for (let length = 0; length < sample.minimum; length++) {
      assertFail(checkSignature(sample.mime, sample.bytes.subarray(0, length)), REASONS.TOO_SHORT);
    }
    assert.equal(checkSignature(sample.mime, sample.bytes.subarray(0, sample.minimum)).ok, true, sample.name);
  }
  const heic = HEIC();
  for (let length = 0; length < 16; length++) {
    assertFail(checkSignature('image/heic', heic.subarray(0, length)), REASONS.TOO_SHORT);
  }
});

test('random bytes never pass', () => {
  let seed = 123456789;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let trial = 0; trial < 3000; trial++) {
    const length = Math.floor(next() * 80);
    const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256));
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
      assert.equal(checkSignature(mime, bytes).ok, false);
    }
  }
});

test('results have a fixed shape, and only type_mismatch carries a detectedType on failure', () => {
  const results = [
    checkSignature('image/jpeg', jpeg()),
    checkSignature('image/png', jpeg()),
    checkSignature('image/jpeg', new Uint8Array(0)),
    checkSignature('image/jpeg', null),
  ];
  for (const result of results) assert.deepEqual(Object.keys(result), ['ok', 'detectedType', 'reason']);
  assert.equal(results[0].reason, null);
  assert.equal(results[1].detectedType, 'image/jpeg');
  assert.equal(results[2].detectedType, null);
  assert.equal(results[3].detectedType, null);
  assert.deepEqual({ ...REASONS }, {
    TOO_SHORT: 'too_short',
    INVALID_FTYP: 'invalid_ftyp',
    UNKNOWN_FORMAT: 'unknown_format',
    TYPE_MISMATCH: 'type_mismatch',
  });
});
