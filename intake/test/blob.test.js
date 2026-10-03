import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlobNotFoundError } from '@vercel/blob';
import { signUpload, headSource, deleteSource } from '../api/_lib/blob.js';
import { ALLOWED_MIME_TYPES, MAX_FILE_BYTES, SIGNED_URL_TTL_MS, blobPathname } from '../shared/rules.js';

// SDK doubles only: no network, no credentials, and nothing real is ever signed.
const CASE_ID = '3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23';
const SOURCE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const SECRET_INPUT = 'jane.doe@example.com';
const CANONICAL_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const CANONICAL_EXTENSIONS = ['jpg', 'png', 'webp', 'heic', 'heif'];

const ref = (overrides = {}) => ({ pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID, mime: 'image/heic', ...overrides });
const identity = (overrides = {}) => ({ pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID, ...overrides });
const request = (overrides = {}) => ({ ...ref(), size: 243663, ...overrides });

// headError / delError: thrown after the call is recorded, so the pathname used stays visible.
// delFor(pathname): per-pathname delete behaviour; return an error to throw, or undefined.
function makeSdk({ headError, delError, delFor, ...overrides } = {}) {
  const calls = { issueSignedToken: [], presignUrl: [], head: [], del: [] };
  const issued = { delegationToken: 'DELEGATION-TEST', clientSigningToken: 'SIGNING-SECRET-TEST', validUntil: 0 };
  const sdk = {
    async issueSignedToken(options) {
      calls.issueSignedToken.push(options);
      return issued;
    },
    async presignUrl(token, options) {
      calls.presignUrl.push({ token, options });
      return { presignedUrl: 'PRESIGNED-URL-FOR-TEST' };
    },
    async head(pathname) {
      calls.head.push(pathname);
      if (headError) throw headError;
      return { size: 243663, contentType: 'image/heic', etag: 'ETAG', url: 'STORE-URL-TEST', pathname };
    },
    async del(pathname) {
      calls.del.push(pathname);
      const error = delFor ? delFor(pathname) : delError;
      if (error) throw error;
    },
    ...overrides,
  };
  return { sdk, calls, issued };
}

const noCalls = (calls) => Object.values(calls).every((list) => list.length === 0);
const pathFor = (pilotRef, caseId, sourceId, ext) => `cases/${pilotRef}/${caseId}/${sourceId}.${ext}`;
const allFive = ({ pilotRef, caseId, sourceId }) => CANONICAL_EXTENSIONS.map((ext) => pathFor(pilotRef, caseId, sourceId, ext));

// ---- signUpload ----

test('signUpload sends exactly the approved signing constraints', async () => {
  const { sdk, calls, issued } = makeSdk();
  await signUpload(request(), { now: NOW, sdk });
  const pathname = pathFor('p1', CASE_ID, SOURCE_ID, 'heic');
  const validUntil = NOW + SIGNED_URL_TTL_MS;

  assert.equal(calls.issueSignedToken.length, 1);
  assert.deepEqual(calls.issueSignedToken[0], {
    pathname,
    operations: ['put'],
    validUntil,
    allowedContentTypes: ['image/heic'],
    maximumSizeInBytes: 243663,
  });

  assert.equal(calls.presignUrl.length, 1);
  assert.equal(calls.presignUrl[0].token, issued);
  assert.deepEqual(calls.presignUrl[0].options, {
    operation: 'put',
    pathname,
    access: 'private',
    validUntil,
    allowedContentTypes: ['image/heic'],
    maximumSizeInBytes: 243663,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
});

test('signUpload is PUT only, one exact pathname, one content type, no wildcard', async () => {
  const { sdk, calls } = makeSdk();
  await signUpload(request({ mime: 'image/png' }), { now: NOW, sdk });
  const token = calls.issueSignedToken[0];
  const url = calls.presignUrl[0].options;
  assert.deepEqual(token.operations, ['put']);
  assert.equal(url.operation, 'put');
  assert.deepEqual(token.allowedContentTypes, ['image/png']);
  assert.deepEqual(url.allowedContentTypes, ['image/png']);
  assert.equal(token.pathname.includes('*'), false);
  assert.equal(url.pathname.includes('*'), false);
  assert.equal(token.pathname, url.pathname);
});

test('signUpload derives each extension from the validated MIME type', async () => {
  for (let index = 0; index < CANONICAL_MIMES.length; index++) {
    const mime = CANONICAL_MIMES[index];
    const { sdk, calls } = makeSdk();
    await signUpload(request({ mime }), { now: NOW, sdk });
    assert.equal(calls.issueSignedToken[0].pathname, pathFor('p1', CASE_ID, SOURCE_ID, CANONICAL_EXTENSIONS[index]));
    assert.deepEqual(calls.issueSignedToken[0].allowedContentTypes, [mime]);
  }
});

test('the signed size cap is the declared size, and 1 byte and exactly 50 MiB are accepted', async () => {
  for (const size of [1, 243663, MAX_FILE_BYTES]) {
    const { sdk, calls } = makeSdk();
    await signUpload(request({ size }), { now: NOW, sdk });
    assert.equal(calls.issueSignedToken[0].maximumSizeInBytes, size);
    assert.equal(calls.presignUrl[0].options.maximumSizeInBytes, size);
  }
});

test('expiry is exactly the injected now plus the 30-minute TTL, in token, URL and result', async () => {
  assert.equal(SIGNED_URL_TTL_MS, 1800000);
  for (const now of [NOW, 0, 1, Date.UTC(2030, 0, 1)]) {
    const { sdk, calls } = makeSdk();
    const result = await signUpload(request(), { now, sdk });
    assert.equal(result.expiresAt, now + 1800000);
    assert.equal(calls.issueSignedToken[0].validUntil, now + 1800000);
    assert.equal(calls.presignUrl[0].options.validUntil, now + 1800000);
  }
});

test('the real clock is used when now is omitted', async () => {
  const { sdk } = makeSdk();
  const before = Date.now();
  const result = await signUpload(request(), { sdk });
  const after = Date.now();
  assert.equal(result.expiresAt >= before + SIGNED_URL_TTL_MS, true);
  assert.equal(result.expiresAt <= after + SIGNED_URL_TTL_MS, true);
});

test('signUpload returns only the presigned URL and its expiry', async () => {
  const { sdk } = makeSdk();
  const result = await signUpload(request(), { now: NOW, sdk });
  assert.deepEqual(Object.keys(result), ['presignedUrl', 'expiresAt']);
  assert.equal(result.presignedUrl, 'PRESIGNED-URL-FOR-TEST');
  const text = JSON.stringify(result);
  for (const secret of ['DELEGATION-TEST', 'SIGNING-SECRET-TEST', 'STORE-URL-TEST', 'cases/', CASE_ID, SOURCE_ID, 'p1']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('signUpload validates everything before any SDK call, and errors never echo the input', async () => {
  const badRequests = [
    request({ pilotRef: SECRET_INPUT }), request({ pilotRef: 'P1' }), request({ pilotRef: '../p1' }), request({ pilotRef: undefined }),
    request({ caseId: SECRET_INPUT }), request({ caseId: CASE_ID.toUpperCase() }), request({ caseId: '../../x' }),
    request({ sourceId: SECRET_INPUT }), request({ sourceId: SOURCE_ID.toUpperCase() }), request({ sourceId: undefined }),
    request({ mime: 'image/gif' }), request({ mime: 'constructor' }), request({ mime: SECRET_INPUT }), request({ mime: undefined }),
    ...[0, -1, 1.5, NaN, Infinity, MAX_FILE_BYTES + 1, '100', null, undefined].map((size) => request({ size })),
  ];
  for (const bad of badRequests) {
    const { sdk, calls } = makeSdk();
    await assert.rejects(signUpload(bad, { now: NOW, sdk }), (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message.includes(SECRET_INPUT), false);
      return true;
    });
    assert.equal(noCalls(calls), true);
  }
  for (const now of [NaN, Infinity, -Infinity, 'x', null, {}]) {
    const { sdk, calls } = makeSdk();
    await assert.rejects(signUpload(request(), { now, sdk }), /invalid clock/);
    assert.equal(noCalls(calls), true);
  }
  const { sdk, calls } = makeSdk();
  await assert.rejects(signUpload(undefined, { now: NOW, sdk }), TypeError);
  assert.equal(noCalls(calls), true);
});

test('invalid input is rejected before the real SDK could be reached', async () => {
  await assert.rejects(signUpload(request({ size: 0 })), /invalid size/);
  await assert.rejects(signUpload(request({ mime: 'image/gif' })), /invalid mime/);
  await assert.rejects(headSource(ref({ caseId: 'nope' })), /invalid caseId/);
  await assert.rejects(deleteSource(identity({ sourceId: 'nope' })), /invalid sourceId/);
  await assert.rejects(deleteSource(identity({ pilotRef: 'P1' })), /invalid pilotRef/);
});

test('signUpload propagates SDK errors unchanged and stops at the first failure', async () => {
  const signingError = new Error('control api unavailable');
  const first = makeSdk({ async issueSignedToken() { throw signingError; } });
  await assert.rejects(signUpload(request(), { now: NOW, sdk: first.sdk }), (error) => error === signingError);
  assert.equal(first.calls.presignUrl.length, 0);

  const presignError = new Error('presign failed');
  const second = makeSdk({ async presignUrl() { throw presignError; } });
  await assert.rejects(signUpload(request(), { now: NOW, sdk: second.sdk }), (error) => error === presignError);
});

// ---- headSource ----

test('headSource returns only size and contentType for an existing source', async () => {
  const { sdk, calls } = makeSdk();
  const result = await headSource(ref(), { sdk });
  assert.deepEqual(result, { size: 243663, contentType: 'image/heic' });
  assert.deepEqual(Object.keys(result), ['size', 'contentType']);
  assert.deepEqual(calls.head, [pathFor('p1', CASE_ID, SOURCE_ID, 'heic')]);
});

test('headSource maps a missing blob to null, using the real BlobNotFoundError', async () => {
  const { sdk, calls } = makeSdk({ headError: new BlobNotFoundError() });
  assert.equal(await headSource(ref(), { sdk }), null);
  assert.deepEqual(calls.head, [pathFor('p1', CASE_ID, SOURCE_ID, 'heic')]);
});

test('headSource propagates every other error unchanged', async () => {
  const lookalike = Object.assign(new Error('not found by name only'), { name: 'BlobNotFoundError' });
  const errors = [new Error('storage unavailable'), new TypeError('bad response'), lookalike];
  for (const error of errors) {
    const { sdk, calls } = makeSdk({ headError: error });
    await assert.rejects(headSource(ref(), { sdk }), (thrown) => thrown === error);
    assert.equal(calls.head.length, 1);
  }
});

test('headSource validates before any SDK call', async () => {
  for (const bad of [ref({ pilotRef: 'P1' }), ref({ caseId: SECRET_INPUT }), ref({ sourceId: CASE_ID.toUpperCase() }), ref({ mime: 'image/gif' }), ref({ mime: undefined })]) {
    const { sdk, calls } = makeSdk();
    await assert.rejects(headSource(bad, { sdk }), (error) => error instanceof Error && !error.message.includes(SECRET_INPUT));
    assert.equal(noCalls(calls), true);
  }
});

// ---- deleteSource: operates on the source identity, not on a caller-supplied MIME ----

test('deleteSource targets all five canonical variants of one source identity, and nothing else', async () => {
  const { sdk, calls } = makeSdk();
  assert.equal(await deleteSource(identity(), { sdk }), undefined);
  assert.deepEqual(calls.del, allFive(identity()));

  const prefix = `cases/p1/${CASE_ID}/${SOURCE_ID}.`;
  assert.equal(calls.del.length, 5);
  assert.equal(new Set(calls.del).size, 5);
  for (const pathname of calls.del) assert.equal(pathname.startsWith(prefix), true, pathname);
  assert.deepEqual(calls.del.map((pathname) => pathname.slice(prefix.length)), CANONICAL_EXTENSIONS);
  assert.equal(calls.del.some((pathname) => pathname.includes('*')), false);
});

test('deleteSource needs no MIME, and an extra mime property is ignored', async () => {
  const bare = makeSdk();
  await deleteSource(identity(), { sdk: bare.sdk });
  assert.deepEqual(bare.calls.del, allFive(identity()));

  for (const mime of ['image/png', 'image/heic', 'image/gif', 'constructor', undefined, 42]) {
    const { sdk, calls } = makeSdk();
    await deleteSource({ ...identity(), mime }, { sdk });
    assert.deepEqual(calls.del, allFive(identity()));
  }
});

test('deleteSource: missing variants are harmless, even when all five are missing', async () => {
  const { sdk, calls } = makeSdk({ delError: new BlobNotFoundError() });
  assert.equal(await deleteSource(identity(), { sdk }), undefined);
  assert.deepEqual(calls.del, allFive(identity()));
});

test('deleteSource completes when some variants exist and others are missing', async () => {
  const existing = new Set([pathFor('p1', CASE_ID, SOURCE_ID, 'jpg'), pathFor('p1', CASE_ID, SOURCE_ID, 'heif')]);
  const { sdk, calls } = makeSdk({ delFor: (pathname) => (existing.has(pathname) ? undefined : new BlobNotFoundError()) });
  assert.equal(await deleteSource(identity(), { sdk }), undefined);
  assert.deepEqual(calls.del, allFive(identity()));
});

test('deleteSource propagates a non-not-found error unchanged and stops there, so a retry is safe', async () => {
  const lookalike = Object.assign(new Error('not found by name only'), { name: 'BlobNotFoundError' });
  for (const error of [new Error('storage unavailable'), new TypeError('bad response'), lookalike]) {
    const { sdk, calls } = makeSdk({ delError: error });
    await assert.rejects(deleteSource(identity(), { sdk }), (thrown) => thrown === error);
    assert.equal(calls.del.length, 1);
  }

  // A partial deletion followed by a real failure: the error surfaces, later variants are not attempted.
  const failure = new Error('storage unavailable');
  const paths = allFive(identity());
  const partial = makeSdk({
    delFor: (pathname) => {
      if (pathname === paths[0] || pathname === paths[1]) return new BlobNotFoundError();
      if (pathname === paths[2]) return failure;
      return undefined;
    },
  });
  await assert.rejects(deleteSource(identity(), { sdk: partial.sdk }), (thrown) => thrown === failure);
  assert.deepEqual(partial.calls.del, paths.slice(0, 3));

  // The retry after the failure clears up, and completes.
  const retry = makeSdk();
  await deleteSource(identity(), { sdk: retry.sdk });
  assert.deepEqual(retry.calls.del, paths);
});

test('deleteSource validates identifiers before any SDK call', async () => {
  const badIdentities = [
    identity({ pilotRef: 'P1' }), identity({ pilotRef: '../p1' }), identity({ pilotRef: undefined }), identity({ pilotRef: SECRET_INPUT }),
    identity({ caseId: 'x' }), identity({ caseId: CASE_ID.toUpperCase() }), identity({ caseId: undefined }),
    identity({ sourceId: SECRET_INPUT }), identity({ sourceId: SOURCE_ID.toUpperCase() }), identity({ sourceId: undefined }),
  ];
  for (const bad of badIdentities) {
    const { sdk, calls } = makeSdk();
    await assert.rejects(deleteSource(bad, { sdk }), (error) => error instanceof Error && !error.message.includes(SECRET_INPUT));
    assert.equal(calls.del.length, 0);
    assert.equal(noCalls(calls), true);
  }
  const { sdk, calls } = makeSdk();
  await assert.rejects(deleteSource(undefined, { sdk }), TypeError);
  assert.equal(noCalls(calls), true);
});

test('deleteSource derives its variants from the exported ALLOWED_MIME_TYPES collection', async () => {
  const { sdk, calls } = makeSdk();
  await deleteSource(identity(), { sdk });
  const derived = ALLOWED_MIME_TYPES.map((mime) => blobPathname({ ...identity(), mime }));
  assert.deepEqual(calls.del, derived);
  assert.equal(calls.del.length, ALLOWED_MIME_TYPES.length);
  // Pins the current canonical order and extensions at the integration level as well.
  assert.deepEqual(calls.del, allFive(identity()));
});

// ---- isolation ----

test('caller-supplied pathname, path, url and key fields can never redirect any operation', async () => {
  const hostile = 'cases/p2/other-case/other-source.png';
  const injected = { pathname: hostile, path: hostile, url: hostile, key: hostile };
  const expected = pathFor('p1', CASE_ID, SOURCE_ID, 'heic');

  const signing = makeSdk();
  await signUpload({ ...request(), ...injected }, { now: NOW, sdk: signing.sdk });
  assert.equal(signing.calls.issueSignedToken[0].pathname, expected);
  assert.equal(signing.calls.presignUrl[0].options.pathname, expected);

  const heading = makeSdk();
  await headSource({ ...ref(), ...injected }, { sdk: heading.sdk });
  assert.deepEqual(heading.calls.head, [expected]);

  const deleting = makeSdk();
  await deleteSource({ ...identity(), ...injected }, { sdk: deleting.sdk });
  assert.deepEqual(deleting.calls.del, allFive(identity()));
  assert.equal(deleting.calls.del.includes(hostile), false);
});

test('pathnames are isolated by pilot, case, source and extension', async () => {
  const otherCase = randomUUID();
  const otherSource = randomUUID();
  const variants = [
    ref(),
    ref({ pilotRef: 'p2' }),
    ref({ caseId: otherCase }),
    ref({ sourceId: otherSource }),
    ref({ mime: 'image/png' }),
  ];
  const signedOrHeadPaths = new Set();
  const identities = new Map();
  for (const variant of variants) {
    const expected = pathFor(variant.pilotRef, variant.caseId, variant.sourceId, variant.mime === 'image/png' ? 'png' : 'heic');
    const { sdk, calls } = makeSdk();
    await signUpload({ ...variant, size: 10 }, { now: NOW, sdk });
    await headSource(variant, { sdk });
    assert.equal(calls.issueSignedToken[0].pathname, expected);
    assert.deepEqual(calls.head, [expected]);
    assert.equal(signedOrHeadPaths.has(expected), false);
    signedOrHeadPaths.add(expected);

    // Delete works on the identity: every targeted path stays under exactly this pilot/case/source.
    const deleting = makeSdk();
    const { mime, ...sourceIdentity } = variant;
    await deleteSource(sourceIdentity, { sdk: deleting.sdk });
    assert.deepEqual(deleting.calls.del, allFive(sourceIdentity));
    identities.set(`${variant.pilotRef}/${variant.caseId}/${variant.sourceId}`, deleting.calls.del);
  }
  assert.equal(signedOrHeadPaths.size, variants.length);

  // Four distinct identities (the png variant shares the base identity), with no overlapping paths.
  assert.equal(identities.size, 4);
  const everyDeletedPath = [...identities.values()].flat();
  assert.equal(new Set(everyDeletedPath).size, 20);
});

// ---- hygiene ----

test('blob.js has no env, logging, URLs, HTTP, auth or caller-supplied pathname parameter', () => {
  const source = readFileSync(new URL('../api/_lib/blob.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprocess\b/.test(code), false);
  assert.equal(/\bconsole\b/.test(code), false);
  assert.equal(/https?:\/\//i.test(source), false);
  assert.equal(/\bfetch\b|\bResponse\b|\bRequest\b|\bheaders\b/.test(code), false);
  assert.equal(/authoriz|authenticat|Bearer|PILOT_TOKEN/i.test(code), false);
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['../../shared/rules.js', '@vercel/blob']);
  // The only exported functions take identifiers, never a pathname or URL.
  const signatures = [...code.matchAll(/export async function (\w+)\(\{([^}]*)\}/g)].map((match) => [match[1], match[2].trim()]);
  assert.deepEqual(signatures.map(([name]) => name), ['signUpload', 'headSource', 'deleteSource']);
  for (const [, params] of signatures) assert.equal(/pathname|path\b|url/i.test(params), false);
  // deleteSource takes the source identity only.
  assert.equal(signatures.find(([name]) => name === 'deleteSource')[1], 'pilotRef, caseId, sourceId');
  // Wording: the PUT is scoped to the pathname and constraints, not described as single-use.
  assert.equal(/single-use/i.test(source), false);
});

test('blob.js keeps no handwritten MIME list and takes its variants from rules.js', () => {
  const source = readFileSync(new URL('../api/_lib/blob.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/SOURCE_MIMES/.test(source), false);
  assert.equal(/'image\//.test(code), false);
  assert.match(code, /import \{[^}]*\bALLOWED_MIME_TYPES\b[^}]*\} from '\.\.\/\.\.\/shared\/rules\.js';/);
  assert.match(code, /ALLOWED_MIME_TYPES\.map\(/);
});
