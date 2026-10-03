import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createUploadHandler, createRemoveHandler } from '../api/_lib/source-handlers.js';
import { handlePost } from '../api/_lib/http.js';
import { MAX_FILE_BYTES } from '../shared/rules.js';

// Fakes only: no network, no Blob SDK, no credentials. Nothing real is ever signed or deleted.
const CASE_ID = '3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23';
const SOURCE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const PRESIGNED = 'PRESIGNED-URL-FOR-TEST';
const SDK_SECRET = 'sdk-secret-message-must-never-leak';
const ENDPOINT_URL = ['https:', '', 'intake.test', 'api', 'test'].join('/');

const uploadBody = (overrides = {}) => ({ case_id: CASE_ID, source_id: SOURCE_ID, mime_type: 'image/heic', file_size: 243663, ...overrides });
const removeBody = (overrides = {}) => ({ case_id: CASE_ID, source_id: SOURCE_ID, ...overrides });
const without = (body, key) => Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));

function uploadSetup(signResult) {
  const calls = [];
  const logs = [];
  const signUpload = async (args) => {
    calls.push(args);
    return signResult === undefined ? { presignedUrl: PRESIGNED, expiresAt: 1234567890123, extra: 'x' } : signResult;
  };
  const handler = createUploadHandler({ signUpload, log: (entry) => logs.push(entry) });
  return { handler, calls, logs };
}

function removeSetup(deleteImpl) {
  const calls = [];
  const logs = [];
  const deleteSource = async (args) => {
    calls.push(args);
    if (deleteImpl) return deleteImpl(args, calls.length);
    return undefined;
  };
  const handler = createRemoveHandler({ deleteSource, log: (entry) => logs.push(entry) });
  return { handler, calls, logs };
}

const run = (handler, body, pilotRef = 'p1') => handler({ pilotRef, body });
const text = async (response) => response.text();

async function assertRejected(setup, body, reason, runner = run) {
  const { handler, calls, logs } = setup;
  const response = await runner(handler, body);
  assert.equal(response.status, 400, reason);
  assert.equal(await text(response), '{"error":"invalid_request"}', reason);
  assert.equal(calls.length, 0, reason);
  assert.deepEqual(logs, [{ event: 'request_rejected', reason }], reason);
}

// ---- upload: success ----

test('upload: a valid body calls signUpload exactly once with the exact mapped arguments', async () => {
  const { handler, calls } = uploadSetup();
  const response = await run(handler, uploadBody());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID, mime: 'image/heic', size: 243663 });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['caseId', 'mime', 'pilotRef', 'size', 'sourceId']);
});

test('upload: pilotRef comes from the handler context and never from the body', async () => {
  const { handler, calls } = uploadSetup();
  await run(handler, uploadBody(), 'p2');
  assert.equal(calls[0].pilotRef, 'p2');
  const hostile = uploadSetup();
  await assertRejected(hostile, uploadBody({ pilot_ref: 'p9' }), 'unknown_field');
  await assertRejected(uploadSetup(), uploadBody({ pilotRef: 'p9' }), 'unknown_field');
});

test('upload: the success response contains only upload_url, and expiresAt is not exposed', async () => {
  const { handler } = uploadSetup();
  const response = await run(handler, uploadBody());
  const raw = await text(response);
  assert.equal(raw, `{"upload_url":"${PRESIGNED}"}`);
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['upload_url']);
  for (const leaked of ['expires', '1234567890123', 'extra', 'pathname', 'cases/', CASE_ID, SOURCE_ID, 'p1', 'image/heic']) {
    assert.equal(raw.includes(leaked), false, leaked);
  }
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('upload: an invalid signing result is a thrown TypeError, never a response', async () => {
  for (const result of [null, {}, { presignedUrl: '' }, { presignedUrl: 42 }, { presignedUrl: null }, 'url']) {
    const { handler } = uploadSetup(result);
    await assert.rejects(run(handler, uploadBody()), TypeError);
  }
});

// ---- upload: strict key set ----

test('upload: every missing required key is invalid_request, with no sign call', async () => {
  for (const key of ['case_id', 'source_id', 'mime_type', 'file_size']) {
    await assertRejected(uploadSetup(), without(uploadBody(), key), 'missing_field');
  }
  await assertRejected(uploadSetup(), {}, 'missing_field');
});

test('upload: unknown keys are invalid_request, including filename, pilot_ref, pathname, url, mime, size and __proto__', async () => {
  const unknown = [
    'filename', 'pilot_ref', 'pathname', 'url', 'mime', 'size', 'caption', 'pilotRef', 'caseId', 'sourceId',
    'file_name', 'expires_at', 'key', 'path',
  ];
  for (const key of unknown) {
    await assertRejected(uploadSetup(), uploadBody({ [key]: 'x' }), 'unknown_field');
  }
  const proto = JSON.parse(`{"case_id":"${CASE_ID}","source_id":"${SOURCE_ID}","mime_type":"image/heic","file_size":10,"__proto__":{"x":1}}`);
  await assertRejected(uploadSetup(), proto, 'unknown_field');
});

test('upload: a non-object body is rejected as wrong_type, without a sign call', async () => {
  for (const body of [null, undefined, [], 'x', 42, true]) {
    await assertRejected(uploadSetup(), body, 'wrong_type');
  }
});

// ---- upload: field validation ----

test('upload: invalid case_id values are rejected (wrong type, uppercase, wrong version, garbage)', async () => {
  for (const value of [42, null, true, [], {}, undefined]) {
    await assertRejected(uploadSetup(), uploadBody({ case_id: value }), 'wrong_type');
  }
  const bad = [
    CASE_ID.toUpperCase(), '3f2b8c1e-5a4d-1e7f-9b21-0c6d8a9e1f23', '3f2b8c1e-5a4d-4e7f-cb21-0c6d8a9e1f23',
    '../../etc/passwd', 'garbage', '', `${CASE_ID}\n`, ` ${CASE_ID}`, `{${CASE_ID}}`, CASE_ID.slice(0, -1),
  ];
  for (const value of bad) await assertRejected(uploadSetup(), uploadBody({ case_id: value }), 'bad_case_id');
});

test('upload: invalid source_id values are rejected the same way', async () => {
  for (const value of [42, null, true, [], {}, undefined]) {
    await assertRejected(uploadSetup(), uploadBody({ source_id: value }), 'wrong_type');
  }
  const bad = [
    SOURCE_ID.toUpperCase(), 'a1b2c3d4-e5f6-3a7b-8c9d-0e1f2a3b4c5d', 'a1b2c3d4-e5f6-4a7b-7c9d-0e1f2a3b4c5d',
    '../../x', 'garbage', '', `${SOURCE_ID}\n`, ` ${SOURCE_ID}`, SOURCE_ID.slice(0, -1),
  ];
  for (const value of bad) await assertRejected(uploadSetup(), uploadBody({ source_id: value }), 'bad_source_id');
});

test('upload: invalid MIME values are rejected, and nothing is normalised', async () => {
  for (const value of [42, null, true, ['image/png'], {}, undefined]) {
    await assertRejected(uploadSetup(), uploadBody({ mime_type: value }), 'wrong_type');
  }
  const bad = [
    'image/gif', 'image/avif', 'IMAGE/JPEG', 'Image/Png', 'image/jpeg; charset=utf-8', ' image/png', 'image/png ',
    'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'application/pdf',
  ];
  for (const value of bad) await assertRejected(uploadSetup(), uploadBody({ mime_type: value }), 'bad_mime_type');
});

test('upload: invalid file sizes are rejected (wrong type, fractions, zero, negative, over 50 MiB)', async () => {
  for (const value of ['243663', '1', null, true, [], {}, undefined]) {
    await assertRejected(uploadSetup(), uploadBody({ file_size: value }), 'wrong_type');
  }
  for (const value of [1.5, 0.5, NaN, Infinity, -Infinity]) {
    await assertRejected(uploadSetup(), uploadBody({ file_size: value }), 'bad_file_size');
  }
  for (const value of [0, -1, MAX_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER, 1e21]) {
    await assertRejected(uploadSetup(), uploadBody({ file_size: value }), 'bad_file_size');
  }
});

test('upload: the boundaries 1 byte and exactly 52,428,800 bytes are accepted', async () => {
  assert.equal(MAX_FILE_BYTES, 52428800);
  for (const size of [1, 52428800]) {
    const { handler, calls } = uploadSetup();
    const response = await run(handler, uploadBody({ file_size: size }));
    assert.equal(response.status, 200, String(size));
    assert.equal(calls[0].size, size);
  }
});

test('upload: validation runs in the specified deterministic order', async () => {
  const cases = [
    // unknown field first, even when other things are wrong or missing
    [{ ...uploadBody({ case_id: 'bad' }), extra: 1 }, 'unknown_field'],
    [{ ...without(uploadBody({ case_id: 'bad' }), 'mime_type'), extra: 1 }, 'unknown_field'],
    // then missing field, even when a present field is invalid
    [without(uploadBody({ case_id: 'bad' }), 'file_size'), 'missing_field'],
    // then case_id type, then case_id validity
    [uploadBody({ case_id: 42, source_id: 'bad', mime_type: 'image/gif', file_size: 0 }), 'wrong_type'],
    [uploadBody({ case_id: 'bad', source_id: 42, mime_type: 'image/gif', file_size: 0 }), 'bad_case_id'],
    // then source_id
    [uploadBody({ source_id: 42, mime_type: 'image/gif', file_size: 0 }), 'wrong_type'],
    [uploadBody({ source_id: 'bad', mime_type: 42, file_size: 0 }), 'bad_source_id'],
    // then mime type, then mime validity
    [uploadBody({ mime_type: 42, file_size: 0 }), 'wrong_type'],
    [uploadBody({ mime_type: 'image/gif', file_size: '10' }), 'bad_mime_type'],
    // then file size type, integer validity, range
    [uploadBody({ file_size: '10' }), 'wrong_type'],
    [uploadBody({ file_size: 1.5 }), 'bad_file_size'],
    [uploadBody({ file_size: 0 }), 'bad_file_size'],
  ];
  for (const [body, reason] of cases) await assertRejected(uploadSetup(), body, reason);
});

// ---- upload: failures, logging, leaks ----

test('upload: a signUpload failure propagates unchanged and nothing is logged or returned', async () => {
  const failure = new Error(SDK_SECRET);
  const logs = [];
  const handler = createUploadHandler({ signUpload: async () => { throw failure; }, log: (entry) => logs.push(entry) });
  await assert.rejects(run(handler, uploadBody()), (error) => error === failure);
  assert.deepEqual(logs, []);
});

test('upload: through handlePost a signing failure is a generic 500 with no SDK message anywhere', async () => {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  const logs = [];
  const log = (entry) => logs.push(entry);
  const handler = createUploadHandler({ signUpload: async () => { throw new Error(SDK_SECRET); }, log });
  const request = new Request(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(uploadBody()),
  });
  const response = await handlePost(request, { authConfig: `p1:${hash}`, maxBodyBytes: 4096, log }, handler);
  assert.equal(response.status, 500);
  assert.equal(await text(response), '{"error":"server_error"}');
  assert.deepEqual(logs, [{ event: 'internal_error', code: 'handler_failed', kind: 'error' }]);
  assert.equal(JSON.stringify(logs).includes(SDK_SECRET), false);
});

test('upload: rejection logs carry only request_rejected and a fixed reason, never a value', async () => {
  const secrets = ['secret-case-value', 'secret-source-value', 'secret-mime-value', 'secret-extra-key'];
  const attempts = [
    uploadBody({ case_id: secrets[0] }), uploadBody({ source_id: secrets[1] }), uploadBody({ mime_type: secrets[2] }),
    uploadBody({ [secrets[3]]: 'v' }), without(uploadBody({ case_id: secrets[0] }), 'file_size'),
  ];
  const { handler, logs } = uploadSetup();
  for (const body of attempts) await run(handler, body, 'p7');
  assert.equal(logs.length, attempts.length);
  const allowed = ['unknown_field', 'missing_field', 'wrong_type', 'bad_case_id', 'bad_source_id', 'bad_mime_type', 'bad_file_size'];
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry), ['event', 'reason']);
    assert.equal(entry.event, 'request_rejected');
    assert.equal(allowed.includes(entry.reason), true);
  }
  const serialised = JSON.stringify(logs);
  for (const secret of [...secrets, CASE_ID, SOURCE_ID, 'p7', 'image/heic']) assert.equal(serialised.includes(secret), false, secret);
});

test('upload: a missing, throwing or rejecting log never changes the 400', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const loggers = [undefined, null, 'not a function', () => { throw new Error('x'); }, async () => { throw new Error('x'); }, () => Promise.reject(new Error('x'))];
    for (const log of loggers) {
      const handler = createUploadHandler({ signUpload: async () => ({ presignedUrl: PRESIGNED }), log });
      const response = await run(handler, uploadBody({ file_size: 0 }));
      assert.equal(response.status, 400);
      assert.equal(await text(response), '{"error":"invalid_request"}');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('upload: the factory requires a signUpload function, and log is optional', async () => {
  for (const signUpload of [undefined, null, 'x', {}, 42]) {
    assert.throws(() => createUploadHandler({ signUpload }), TypeError);
  }
  assert.throws(() => createUploadHandler(), TypeError);
  const handler = createUploadHandler({ signUpload: async () => ({ presignedUrl: PRESIGNED }) });
  assert.equal((await run(handler, uploadBody())).status, 200);
});

// ---- remove ----

test('remove: a valid body calls deleteSource exactly once with exactly pilotRef, caseId and sourceId', async () => {
  const { handler, calls } = removeSetup();
  const response = await run(handler, removeBody());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { pilotRef: 'p1', caseId: CASE_ID, sourceId: SOURCE_ID });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['caseId', 'pilotRef', 'sourceId']);
  assert.equal('mime' in calls[0], false);
});

test('remove: pilotRef comes from the handler context and never from the body', async () => {
  const { handler, calls } = removeSetup();
  await run(handler, removeBody(), 'p3');
  assert.equal(calls[0].pilotRef, 'p3');
  await assertRejected(removeSetup(), removeBody({ pilot_ref: 'p9' }), 'unknown_field');
});

test('remove: success is exactly { ok: true }, whatever deleteSource returns', async () => {
  for (const result of [undefined, null, true, { deleted: 0 }, 'x']) {
    const { handler } = removeSetup(async () => result);
    const response = await run(handler, removeBody());
    assert.equal(response.status, 200);
    assert.equal(await text(response), '{"ok":true}');
  }
});

test('remove: repeated valid calls all succeed, and a missing source is not an error', async () => {
  const { handler, calls } = removeSetup();
  for (let i = 0; i < 3; i++) {
    const response = await run(handler, removeBody());
    assert.equal(response.status, 200);
    assert.equal(await text(response), '{"ok":true}');
  }
  assert.equal(calls.length, 3);
});

test('remove: missing keys are rejected with no delete call', async () => {
  for (const key of ['case_id', 'source_id']) {
    await assertRejected(removeSetup(), without(removeBody(), key), 'missing_field');
  }
  await assertRejected(removeSetup(), {}, 'missing_field');
});

test('remove: unknown keys are rejected, and mime_type is an unknown field', async () => {
  const unknown = [
    'mime_type', 'mime', 'file_size', 'size', 'filename', 'pilot_ref', 'pathname', 'url', 'caption', 'pilotRef',
    'caseId', 'sourceId', 'path', 'key',
  ];
  for (const key of unknown) await assertRejected(removeSetup(), removeBody({ [key]: 'x' }), 'unknown_field');
  const proto = JSON.parse(`{"case_id":"${CASE_ID}","source_id":"${SOURCE_ID}","__proto__":{"x":1}}`);
  await assertRejected(removeSetup(), proto, 'unknown_field');
});

test('remove: a non-object body is rejected as wrong_type', async () => {
  for (const body of [null, undefined, [], 'x', 42, true]) await assertRejected(removeSetup(), body, 'wrong_type');
});

test('remove: invalid identifiers are rejected, and the checks run in order', async () => {
  for (const value of [42, null, true, [], {}, undefined]) {
    await assertRejected(removeSetup(), removeBody({ case_id: value }), 'wrong_type');
    await assertRejected(removeSetup(), removeBody({ source_id: value }), 'wrong_type');
  }
  for (const value of [CASE_ID.toUpperCase(), '3f2b8c1e-5a4d-1e7f-9b21-0c6d8a9e1f23', '../x', 'garbage', '', `${CASE_ID}\n`]) {
    await assertRejected(removeSetup(), removeBody({ case_id: value }), 'bad_case_id');
  }
  for (const value of [SOURCE_ID.toUpperCase(), 'a1b2c3d4-e5f6-3a7b-8c9d-0e1f2a3b4c5d', '../x', 'garbage', '', `${SOURCE_ID}\n`]) {
    await assertRejected(removeSetup(), removeBody({ source_id: value }), 'bad_source_id');
  }
  await assertRejected(removeSetup(), { ...removeBody({ case_id: 'bad' }), extra: 1 }, 'unknown_field');
  await assertRejected(removeSetup(), without(removeBody({ case_id: 'bad' }), 'source_id'), 'missing_field');
  await assertRejected(removeSetup(), removeBody({ case_id: 'bad', source_id: 42 }), 'bad_case_id');
  await assertRejected(removeSetup(), removeBody({ case_id: 42, source_id: 'bad' }), 'wrong_type');
});

test('remove: a deleteSource failure propagates unchanged, and a later retry can succeed', async () => {
  const failure = new Error(SDK_SECRET);
  const { handler, calls, logs } = removeSetup(async (_args, attempt) => {
    if (attempt === 1) throw failure;
    return undefined;
  });
  await assert.rejects(run(handler, removeBody()), (error) => error === failure);
  assert.deepEqual(logs, []);
  const retry = await run(handler, removeBody());
  assert.equal(retry.status, 200);
  assert.equal(await text(retry), '{"ok":true}');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('remove: through handlePost a deletion failure is a generic 500 with no SDK message anywhere', async () => {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  const logs = [];
  const log = (entry) => logs.push(entry);
  const handler = createRemoveHandler({ deleteSource: async () => { throw new Error(SDK_SECRET); }, log });
  const request = new Request(ENDPOINT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(removeBody()),
  });
  const response = await handlePost(request, { authConfig: `p1:${hash}`, maxBodyBytes: 4096, log }, handler);
  assert.equal(response.status, 500);
  assert.equal(await text(response), '{"error":"server_error"}');
  assert.equal(JSON.stringify(logs).includes(SDK_SECRET), false);
});

test('remove: logs and responses never carry ids, pilotRef or other request values', async () => {
  const { handler, logs } = removeSetup();
  const responses = [
    await run(handler, removeBody({ case_id: 'secret-case-value' }), 'p7'),
    await run(handler, removeBody({ 'secret-extra-key': 'v' }), 'p7'),
    await run(handler, removeBody(), 'p7'),
  ];
  const serialised = JSON.stringify(logs) + (await Promise.all(responses.map(text))).join('');
  for (const secret of ['secret-case-value', 'secret-extra-key', CASE_ID, SOURCE_ID, 'p7']) {
    assert.equal(serialised.includes(secret), false, secret);
  }
  for (const entry of logs) assert.deepEqual(Object.keys(entry), ['event', 'reason']);
});

test('remove: the factory requires a deleteSource function, and log is optional and cannot change a response', async () => {
  for (const deleteSource of [undefined, null, 'x', {}, 42]) {
    assert.throws(() => createRemoveHandler({ deleteSource }), TypeError);
  }
  assert.throws(() => createRemoveHandler(), TypeError);
  const throwing = createRemoveHandler({ deleteSource: async () => {}, log: () => { throw new Error('x'); } });
  assert.equal((await run(throwing, removeBody({ extra: 1 }))).status, 400);
  const quiet = createRemoveHandler({ deleteSource: async () => {} });
  assert.equal((await run(quiet, removeBody())).status, 200);
});

// ---- hygiene ----

test('source-handlers.js reads no env, uses no console or fetch, and imports no SDK, blob, log or auth module', () => {
  const source = readFileSync(new URL('../api/_lib/source-handlers.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprocess\b/.test(code), false);
  assert.equal(/\bconsole\b/.test(code), false);
  assert.equal(/\bfetch\b/.test(code), false);
  assert.equal(/@vercel\/blob/.test(code), false);
  assert.equal(/maxBodyBytes|4096|4 \* 1024|payload_too_large/.test(code), false);
  assert.equal(/\bexpiresAt\b|expires_at/.test(code), false);
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['../../shared/rules.js', './http.js']);
  const exported = [...code.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(exported, ['createUploadHandler', 'createRemoveHandler']);
});

test('the Content-Type invariant is documented without claiming Vercel enforcement', () => {
  const source = readFileSync(new URL('../api/_lib/source-handlers.js', import.meta.url), 'utf8');
  assert.match(source, /declared MIME as its Content-Type/);
  assert.match(source, /MIME and header metadata is NOT proof/);
  assert.match(source, /head \+ sniff \+ signature/);
  assert.equal(/\bVercel (rejects|enforces|checks|validates)\b/i.test(source), false);
});
