import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLogger } from '../api/_lib/log.js';
import { handlePost, jsonResponse } from '../api/_lib/http.js';

// Synthetic fixtures only: no network, nothing real. The sink captures lines instead of printing.
const ENDPOINT_URL = ['https:', '', 'intake.test', 'api', 'test'].join('/');
const TOKEN = randomBytes(32).toString('base64url');
const TOKEN_HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH_CONFIG = `p1:${TOKEN_HASH}`;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const SECRET = 'secret-value-must-never-appear';

const EVENTS = ['auth_rejected', 'auth_config_error', 'body_rejected', 'internal_error', 'request_rejected'];
const CODES = [
  'missing', 'malformed', 'unknown', 'expired', 'config',
  'unsupported_media_type', 'payload_too_large', 'invalid_json', 'invalid_body',
  'invalid_body_limit', 'invalid_handler_result',
  'request_failed', 'auth_failed', 'body_read_failed', 'handler_failed',
];
const KINDS = ['type_error', 'range_error', 'error', 'non_error'];
const REASONS = [
  'unknown_field', 'missing_field', 'wrong_type',
  'bad_case_id', 'bad_source_id', 'bad_mime_type', 'bad_file_size',
];
const INVALID = (endpoint) => ({ endpoint, event: 'invalid_log_entry' });

function capture(endpoint = 'upload-url') {
  const lines = [];
  const log = createLogger(endpoint, (line) => lines.push(line));
  return { log, lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

// ---- endpoints ----

test('only the known endpoint labels are accepted', () => {
  assert.equal(typeof createLogger('upload-url', () => {}), 'function');
  assert.equal(typeof createLogger('remove', () => {}), 'function');
  for (const endpoint of ['submit', '', 'upload_url', 'UPLOAD-URL', 'constructor', '__proto__', undefined, null, 42, {}]) {
    assert.throws(() => createLogger(endpoint, () => {}), RangeError, String(endpoint));
  }
});

test('an entry is logged as one JSON line with the endpoint first', () => {
  const { log, lines } = capture('remove');
  log({ event: 'body_rejected', code: 'invalid_json' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '{"endpoint":"remove","event":"body_rejected","code":"invalid_json"}');
  assert.equal(lines[0].includes('\n'), false);
});

// ---- whitelist ----

test('every whitelisted event, code, kind and reason passes through unchanged', () => {
  const { log, entries } = capture();
  for (const event of EVENTS) log({ event });
  for (const code of CODES) log({ event: 'internal_error', code });
  for (const kind of KINDS) log({ event: 'internal_error', code: 'handler_failed', kind });
  for (const reason of REASONS) log({ event: 'request_rejected', reason });
  const logged = entries();
  assert.equal(logged.length, EVENTS.length + CODES.length + KINDS.length + REASONS.length);
  assert.equal(logged.some((entry) => entry.event === 'invalid_log_entry'), false);
  assert.deepEqual(logged[0], { endpoint: 'upload-url', event: EVENTS[0] });
});

test('a value outside the whitelist replaces the whole entry and is never written', () => {
  const bad = [
    { event: SECRET }, { event: 'internal_error', code: SECRET }, { event: 'internal_error', kind: SECRET },
    { event: 'request_rejected', reason: SECRET }, { event: 'internal_error', code: 'Handler_Failed' },
    { event: 'invalid_log_entry' }, { event: '' }, { event: 'internal_error', code: '' },
  ];
  for (const entry of bad) {
    const { log, lines, entries } = capture();
    log(entry);
    assert.equal(lines.length, 1);
    assert.deepEqual(entries()[0], INVALID('upload-url'));
    assert.equal(lines[0].includes(SECRET), false);
  }
});

test('keys outside the whitelist are never logged, whatever they hold', () => {
  const extras = ['message', 'stack', 'error', 'token', 'hash', 'authorization', 'pilotRef', 'pilot', 'caseId', 'case_id', 'sourceId', 'mime', 'body', 'url', 'pathname', 'name'];
  for (const key of extras) {
    const { log, lines, entries } = capture();
    log({ event: 'internal_error', [key]: SECRET });
    assert.deepEqual(entries()[0], INVALID('upload-url'), key);
    assert.equal(lines[0].includes(SECRET), false, key);
  }
  const { log, entries } = capture();
  log(JSON.parse(`{"event":"internal_error","__proto__":"${SECRET}"}`));
  assert.deepEqual(entries()[0], INVALID('upload-url'));
});

test('values must be strings: numbers, objects, arrays and Error objects are rejected', () => {
  const values = [42, true, null, undefined, ['internal_error'], { toString: () => 'internal_error' }, new Error(SECRET)];
  for (const value of values) {
    const { log, lines, entries } = capture();
    log({ event: value });
    log({ event: 'internal_error', code: value });
    log({ event: 'internal_error', kind: value });
    log({ event: 'request_rejected', reason: value });
    for (const entry of entries()) assert.deepEqual(entry, INVALID('upload-url'));
    assert.equal(lines.join('').includes(SECRET), false);
  }
});

test('entries that are not plain objects, or have no event, are replaced and never throw', () => {
  const entries = [
    null, undefined, 'internal_error', 42, true, [], [{ event: 'internal_error' }], () => {}, new Error(SECRET),
    new Map([['event', 'internal_error']]), Object.create({ event: 'internal_error' }), Object.create(null),
    {}, { code: 'config' }, { reason: 'bad_case_id' },
  ];
  for (const entry of entries) {
    const { log, lines, entries: parsed } = capture();
    assert.doesNotThrow(() => log(entry));
    assert.deepEqual(parsed()[0], INVALID('upload-url'));
    assert.equal(lines[0].includes(SECRET), false);
  }
});

// ---- never affects the caller ----

test('a throwing or rejecting sink never throws and never leaks an unhandled rejection', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const sinks = [
      () => { throw new Error('sink exploded'); },
      async () => { throw new Error('sink rejected'); },
      () => Promise.reject(new Error('sink rejected later')),
    ];
    for (const sink of sinks) {
      const log = createLogger('upload-url', sink);
      assert.doesNotThrow(() => log({ event: 'internal_error', code: 'handler_failed', kind: 'error' }));
      assert.doesNotThrow(() => log({ message: SECRET }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('the default sink is console.error and receives exactly one string line', () => {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    const log = createLogger('remove');
    log({ event: 'request_rejected', reason: 'bad_source_id' });
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(typeof calls[0][0], 'string');
  assert.equal(calls[0][0], '{"endpoint":"remove","event":"request_rejected","reason":"bad_source_id"}');
});

// ---- the whitelist covers everything http.js emits ----

function request(headers, body = '{}', method = 'POST') {
  return new Request(ENDPOINT_URL, { method, headers, body });
}

test('every entry http.js emits passes the whitelist untouched, and nothing is dropped as invalid', async () => {
  const { log, entries } = capture();
  const json = { 'content-type': 'application/json' };
  const authed = { ...json, authorization: `Bearer ${TOKEN}` };
  const options = (overrides = {}) => ({ authConfig: AUTH_CONFIG, maxBodyBytes: 4096, now: NOW, log, ...overrides });
  const ok = async () => jsonResponse({ ok: true });
  const other = randomBytes(32).toString('base64url');

  await handlePost(request(json), options(), ok); // missing
  await handlePost(request({ ...json, authorization: 'Basic x' }), options(), ok); // malformed
  await handlePost(request({ ...json, authorization: `Bearer ${other}` }), options(), ok); // unknown
  await handlePost(request(authed), options({ authConfig: `p1:${TOKEN_HASH}:2026-01-01T00:00:00Z` }), ok); // expired
  await handlePost(request(authed), options({ authConfig: undefined }), ok); // config
  await handlePost(request({ ...authed, 'content-type': 'text/plain' }), options(), ok); // unsupported_media_type
  await handlePost(request({ ...authed, 'content-length': '999999' }), options(), ok); // payload_too_large
  await handlePost(request(authed, '{'), options(), ok); // invalid_json
  await handlePost(request(authed, '[]'), options(), ok); // invalid_body
  await handlePost(request(authed), options({ maxBodyBytes: 0 }), ok); // invalid_body_limit
  await handlePost(request(authed), options(), async () => 'not a response'); // invalid_handler_result
  await handlePost(request(authed), options(), async () => { throw new TypeError('x'); }); // handler_failed, type_error
  await handlePost(request(authed), options(), async () => { throw new RangeError('x'); }); // range_error
  await handlePost(request(authed), options(), async () => { throw new Error('x'); }); // error
  await handlePost(request(authed), options(), async () => { throw 'x'; }); // non_error
  const failing = new Request(ENDPOINT_URL, {
    method: 'POST', headers: authed, duplex: 'half',
    body: new ReadableStream({ pull(controller) { controller.error(new Error('x')); } }),
  });
  await handlePost(failing, options(), ok); // body_read_failed
  await handlePost({ method: 'POST', headers: { get() { throw new Error('x'); } } }, options(), ok); // auth_failed
  await handlePost(null, options(), ok); // request_failed

  const logged = entries();
  assert.equal(logged.length, 18);
  assert.equal(logged.some((entry) => entry.event === 'invalid_log_entry'), false);
  for (const entry of logged) assert.equal(entry.endpoint, 'upload-url');
  const codes = new Set(logged.map((entry) => entry.code));
  for (const code of ['missing', 'malformed', 'unknown', 'expired', 'config', 'unsupported_media_type', 'payload_too_large',
    'invalid_json', 'invalid_body', 'invalid_body_limit', 'invalid_handler_result', 'handler_failed', 'body_read_failed',
    'auth_failed', 'request_failed']) {
    assert.equal(codes.has(code), true, code);
  }
  const kinds = new Set(logged.map((entry) => entry.kind).filter(Boolean));
  for (const kind of KINDS) assert.equal(kinds.has(kind), true, kind);
});

// ---- hygiene ----

test('log.js has no env, network or error handling, no imports, and console only as the default sink', () => {
  const source = readFileSync(new URL('../api/_lib/log.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprocess\b/.test(code), false);
  assert.equal(/\bfetch\b|@vercel\/blob|\.message\b|\.stack\b/.test(code), false);
  assert.equal(/^import\s/m.test(code), false);
  assert.equal((code.match(/\bconsole\./g) || []).length, 1);
  assert.match(code, /export function createLogger/);
});
