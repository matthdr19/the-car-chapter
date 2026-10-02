import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MIN_FILES,
  RECOMMENDED_FILES,
  SIGNED_URL_TTL_MS,
  SNIFF_BYTES,
  isAllowedMime,
  extForMime,
  mimeFromExtension,
  isUuid,
  isPilotRef,
  isValidFileSize,
  blobPathname,
} from '../shared/rules.js';

const CASE_ID = '3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23';
const SOURCE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

test('constants match the approved plan', () => {
  assert.equal(MAX_FILE_BYTES, 52428800);
  assert.equal(MAX_FILES, 10);
  assert.equal(MIN_FILES, 1);
  assert.deepEqual({ ...RECOMMENDED_FILES }, { min: 3, max: 6 });
  assert.equal(SIGNED_URL_TTL_MS, 1800000);
  assert.equal(SNIFF_BYTES, 4096);
});

test('isAllowedMime accepts exactly the five canonical image types', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.equal(isAllowedMime(mime), true, mime);
  }
});

test('isAllowedMime rejects other types, odd casing and prototype keys', () => {
  const rejected = [
    'image/gif', 'image/svg+xml', 'image/avif', 'application/pdf', 'text/plain',
    'IMAGE/JPEG', 'Image/Png', ' image/png', 'image/png ', '',
    'constructor', '__proto__', 'toString', 'hasOwnProperty',
    null, undefined, 42, {}, [], ['image/png'],
  ];
  for (const mime of rejected) assert.equal(isAllowedMime(mime), false, String(mime));
});

test('extForMime derives the extension from the validated MIME type', () => {
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('image/png'), 'png');
  assert.equal(extForMime('image/webp'), 'webp');
  assert.equal(extForMime('image/heic'), 'heic');
  assert.equal(extForMime('image/heif'), 'heif');
  assert.equal(extForMime('image/gif'), null);
  assert.equal(extForMime('constructor'), null);
  assert.equal(extForMime(undefined), null);
});

test('mimeFromExtension is a provisional fallback that guesses a label from the filename', () => {
  assert.equal(mimeFromExtension('IMG_0001.HEIC'), 'image/heic');
  assert.equal(mimeFromExtension('photo.heif'), 'image/heif');
  assert.equal(mimeFromExtension('a.JPG'), 'image/jpeg');
  assert.equal(mimeFromExtension('a.jpeg'), 'image/jpeg');
  assert.equal(mimeFromExtension('a.png'), 'image/png');
  assert.equal(mimeFromExtension('a.webp'), 'image/webp');
  assert.equal(mimeFromExtension('archive.tar.heic'), 'image/heic');
});

test('mimeFromExtension returns an empty string when it cannot guess', () => {
  const unknown = ['noext', 'trailingdot.', '.heic', 'a.gif', 'a.heic.exe', 'a.constructor', '', null, undefined, 42];
  for (const name of unknown) assert.equal(mimeFromExtension(name), '', String(name));
});

test('the module exposes no verification helper, so a filename guess can never count as verification', () => {
  const source = readFileSync(new URL('../shared/rules.js', import.meta.url), 'utf8');
  assert.equal(/export\s+(async\s+)?function\s+(verify|validate|detect|check)\w*/i.test(source), false);
  assert.match(source, /NEVER verification/);
});

test('isUuid accepts canonical lowercase UUIDv4 from crypto.randomUUID()', () => {
  for (let i = 0; i < 200; i++) assert.equal(isUuid(randomUUID()), true);
  assert.equal(isUuid(CASE_ID), true);
  assert.equal(isUuid(SOURCE_ID), true);
});

test('isUuid rejects uppercase and mixed-case forms instead of normalising them', () => {
  assert.equal(isUuid(CASE_ID.toUpperCase()), false);
  assert.equal(isUuid('3F2B8C1E-5a4d-4e7f-9b21-0c6d8a9e1f23'), false);
  assert.equal(isUuid('3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f2A'), false);
});

test('isUuid rejects wrong version, wrong variant and non-canonical shapes', () => {
  assert.equal(isUuid('3f2b8c1e-5a4d-1e7f-9b21-0c6d8a9e1f23'), false); // version 1
  assert.equal(isUuid('3f2b8c1e-5a4d-5e7f-9b21-0c6d8a9e1f23'), false); // version 5
  assert.equal(isUuid('3f2b8c1e-5a4d-4e7f-cb21-0c6d8a9e1f23'), false); // variant c
  assert.equal(isUuid('3f2b8c1e-5a4d-4e7f-7b21-0c6d8a9e1f23'), false); // variant 7
  assert.equal(isUuid('3f2b8c1e5a4d4e7f9b210c6d8a9e1f23'), false); // no hyphens
  assert.equal(isUuid('{3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23}'), false);
  assert.equal(isUuid('urn:uuid:3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23'), false);
  assert.equal(isUuid(' ' + CASE_ID), false);
  assert.equal(isUuid(CASE_ID + ' '), false);
  assert.equal(isUuid(CASE_ID + '\n'), false);
  assert.equal(isUuid(CASE_ID.slice(0, -1)), false);
  assert.equal(isUuid(CASE_ID + '0'), false);
  assert.equal(isUuid('../' + CASE_ID), false);
});

test('isUuid rejects non-strings', () => {
  for (const value of [null, undefined, 42, {}, [], [CASE_ID], true]) assert.equal(isUuid(value), false);
});

test('isPilotRef accepts opaque labels and rejects everything else', () => {
  for (const ref of ['p1', 'p2', 'p3', 'abc123', 'a', 'a'.repeat(16)]) assert.equal(isPilotRef(ref), true, ref);
  for (const ref of ['', 'P1', '1p', 'p-1', 'p_1', 'p 1', 'a'.repeat(17), 'p1/..', '../p1', 'p1/', 'é1', null, undefined, 1]) {
    assert.equal(isPilotRef(ref), false, String(ref));
  }
});

test('isValidFileSize enforces 1 byte to exactly 50 MiB, integers only', () => {
  assert.equal(isValidFileSize(1), true);
  assert.equal(isValidFileSize(243663), true);
  assert.equal(isValidFileSize(MAX_FILE_BYTES), true);
  for (const size of [0, -1, MAX_FILE_BYTES + 1, 1.5, NaN, Infinity, '100', null, undefined]) {
    assert.equal(isValidFileSize(size), false, String(size));
  }
});

test('blobPathname returns exactly cases/{pilotRef}/{caseId}/{sourceId}.{ext}', () => {
  assert.equal(
    blobPathname({ pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID, mime: 'image/heic' }),
    `cases/p1/${CASE_ID}/${SOURCE_ID}.heic`,
  );
  assert.equal(
    blobPathname({ pilotRef: 'p3', caseId: CASE_ID, sourceId: SOURCE_ID, mime: 'image/jpeg' }),
    `cases/p3/${CASE_ID}/${SOURCE_ID}.jpg`,
  );
});

test('blobPathname matches the opaque pattern for every allowed type', () => {
  const pattern = /^cases\/[a-z][a-z0-9]{0,15}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|heic|heif)$/;
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.match(blobPathname({ pilotRef: 'p2', caseId: randomUUID(), sourceId: randomUUID(), mime }), pattern);
  }
});

test('blobPathname throws on every invalid piece and never echoes the rejected value', () => {
  const good = { pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID, mime: 'image/png' };
  const secret = 'jane.doe@example.com';
  const bad = [
    { ...good, pilotRef: secret },
    { ...good, pilotRef: '../p1' },
    { ...good, caseId: secret },
    { ...good, caseId: CASE_ID.toUpperCase() },
    { ...good, caseId: '../../etc/passwd' },
    { ...good, sourceId: secret },
    { ...good, sourceId: SOURCE_ID.toUpperCase() },
    { ...good, mime: 'image/gif' },
    { ...good, mime: 'constructor' },
    { ...good, mime: secret },
    { ...good, mime: undefined },
  ];
  for (const input of bad) {
    assert.throws(() => blobPathname(input), (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('passwd'), false);
      return true;
    });
  }
});

test('shared/rules.js is browser-safe: no Node-only imports or globals', () => {
  const source = readFileSync(new URL('../shared/rules.js', import.meta.url), 'utf8');
  assert.equal(/\bfrom\s+['"]node:/.test(source), false);
  assert.equal(/\brequire\s*\(/.test(source), false);
  assert.equal(/\bprocess\./.test(source), false);
  assert.equal(/\bBuffer\b/.test(source), false);
  assert.equal(/^\s*import\s/m.test(source), false);
});
