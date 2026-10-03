import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from '../api/_lib/http.js';

const { handlePost, readJsonBody, jsonResponse, errorResponse, methodNotAllowed } = http;

// Synthetic fixtures only: tokens are generated per run, nothing real is used, no network.
const ENDPOINT = ['https:', '', 'intake.test', 'api', 'test'].join('/');
const TOKEN = randomBytes(32).toString('base64url');
const TOKEN_HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const AUTH_CONFIG = `p1:${TOKEN_HASH}`;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const JSON_HEADERS = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const encoder = new TextEncoder();
const LOG_EVENTS = ['auth_rejected', 'auth_config_error', 'body_rejected', 'internal_error'];
const LOG_CODES = [
  'missing', 'malformed', 'unknown', 'expired', 'config', 'unsupported_media_type', 'payload_too_large',
  'invalid_json', 'invalid_body', 'invalid_body_limit', 'invalid_handler_result', 'request_failed',
  'auth_failed', 'body_read_failed', 'handler_failed',
];
const LOG_KINDS = ['type_error', 'range_error', 'error', 'non_error'];

function streamRequest(chunks, { headers = JSON_HEADERS, method = 'POST', onRead, onCancel, cancelRejects } = {}) {
  const queue = [...chunks];
  const state = { reads: 0, cancelled: false };
  // highWaterMark 0: pull runs only when a read is actually pending, so state.reads counts
  // real reads and is 0 when nothing has touched the body.
  const body = new ReadableStream({
    pull(controller) {
      state.reads++;
      if (onRead) onRead(controller);
      if (queue.length) controller.enqueue(queue.shift());
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
      if (onCancel) onCancel();
      if (cancelRejects) return Promise.reject(new Error('cancel failed'));
      return undefined;
    },
  }, { highWaterMark: 0 });
  return { request: new Request(ENDPOINT, { method, headers, body, duplex: 'half' }), state, body };
}

const textRequest = (text, headers = JSON_HEADERS, method = 'POST') =>
  new Request(ENDPOINT, { method, headers, body: text });

function makeHandler() {
  const calls = [];
  const handler = async (input) => {
    calls.push(input);
    return jsonResponse({ ok: true });
  };
  return { handler, calls };
}

const options = (overrides = {}) => ({ authConfig: AUTH_CONFIG, maxBodyBytes: 4096, now: NOW, ...overrides });
const bodyText = async (response) => response.text();
const snapshot = async (response) => ({
  status: response.status,
  headers: [...response.headers.entries()].sort(),
  body: await response.text(),
});

// ---- exports and hygiene ----

test('the public API is exactly five functions', () => {
  assert.deepEqual(Object.keys(http).sort(), ['errorResponse', 'handlePost', 'jsonResponse', 'methodNotAllowed', 'readJsonBody']);
});

test('http.js has no env, logging, network or blob use, no auth plumbing export, and one import', () => {
  const source = readFileSync(new URL('../api/_lib/http.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprocess\b/.test(code), false);
  assert.equal(/\bconsole\b/.test(code), false);
  assert.equal(/\bfetch\b|@vercel\/blob|\brequest\.json\(/.test(code), false);
  assert.equal(/export\s+(async\s+)?function\s+requirePilot|export\s+const\s+ERRORS/.test(code), false);
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./auth.js']);
});

// ---- response helpers ----

test('jsonResponse sets status, body and the safe headers', async () => {
  const response = jsonResponse({ ok: true, n: 1 });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await response.text(), '{"ok":true,"n":1}');
  assert.equal(jsonResponse({ ok: true }, 201).status, 201);
});

test('errorResponse covers exactly the known codes with their statuses and fixed bodies', async () => {
  const expected = {
    method_not_allowed: 405, unauthorized: 401, unsupported_media_type: 415, payload_too_large: 413,
    invalid_json: 400, invalid_body: 400, server_error: 500,
  };
  for (const [code, status] of Object.entries(expected)) {
    const response = errorResponse(code);
    assert.equal(response.status, status, code);
    assert.equal(await response.text(), JSON.stringify({ error: code }), code);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  }
  assert.equal(errorResponse('unauthorized').headers.get('www-authenticate'), 'Bearer');
  assert.equal(errorResponse('method_not_allowed').headers.get('allow'), 'POST');
  assert.equal(errorResponse('server_error').headers.get('www-authenticate'), null);
  assert.equal(errorResponse('payload_too_large').headers.get('allow'), null);
  for (const unknown of ['teapot', '', undefined, null, 'constructor', '__proto__', 401]) {
    assert.throws(() => errorResponse(unknown), RangeError);
  }
});

test('methodNotAllowed is the 405 error response', async () => {
  assert.deepEqual(await snapshot(methodNotAllowed()), await snapshot(errorResponse('method_not_allowed')));
});

// ---- method guard ----

test('POST reaches the handler, and every other method is a 405 with Allow: POST', async () => {
  const ok = makeHandler();
  assert.equal((await handlePost(textRequest('{}'), options(), ok.handler)).status, 200);
  assert.equal(ok.calls.length, 1);

  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const rejected = makeHandler();
    const request = new Request(ENDPOINT, { method, headers: JSON_HEADERS });
    const response = await handlePost(request, options(), rejected.handler);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'POST', method);
    assert.equal(rejected.calls.length, 0, method);
  }
});

test('the method guard runs before auth: a GET with no credentials and a broken config is still a 405', async () => {
  const { handler, calls } = makeHandler();
  const request = new Request(ENDPOINT, { method: 'GET' });
  const response = await handlePost(request, { authConfig: undefined, maxBodyBytes: 4096 }, handler);
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0);
});

// ---- auth ----

test('a valid token calls the handler with exactly { pilotRef, body } and nothing else', async () => {
  const { handler, calls } = makeHandler();
  const response = await handlePost(textRequest('{"a":1,"b":{"c":[1,2]}}'), options(), handler);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]), ['pilotRef', 'body']);
  assert.equal(calls[0].pilotRef, 'p1');
  assert.deepEqual(calls[0].body, { a: 1, b: { c: [1, 2] } });
  assert.equal(calls[0] instanceof Request, false);
});

test('every rejected credential gets the same generic 401, and the body is never read', async () => {
  const otherToken = randomBytes(32).toString('base64url');
  const expiredConfig = `p1:${TOKEN_HASH}:2026-01-01T00:00:00Z`;
  const cases = [
    { headers: { 'content-type': 'application/json' }, config: AUTH_CONFIG },
    { headers: { 'content-type': 'application/json', authorization: 'Basic abc' }, config: AUTH_CONFIG },
    { headers: { 'content-type': 'application/json', authorization: 'Bearer short' }, config: AUTH_CONFIG },
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` }, config: AUTH_CONFIG },
    { headers: JSON_HEADERS, config: expiredConfig },
  ];
  const seen = [];
  for (const { headers, config } of cases) {
    const { handler, calls } = makeHandler();
    const { request, state } = streamRequest([encoder.encode('{}')], { headers });
    const response = await handlePost(request, options({ authConfig: config }), handler);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(calls.length, 0);
    assert.equal(state.reads, 0);
    seen.push(await snapshot(response));
  }
  for (const entry of seen) assert.deepEqual(entry, seen[0]);
  assert.equal(seen[0].body, '{"error":"unauthorized"}');
});

test('an auth config failure is a generic 500 that differs from a 401, and is logged by code only', async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  for (const authConfig of [undefined, '', 'p1:nothex', `p1:${TOKEN_HASH},p1:${'a'.repeat(64)}`]) {
    const { handler, calls } = makeHandler();
    const { request, state } = streamRequest([encoder.encode('{}')]);
    const response = await handlePost(request, options({ authConfig, log }), handler);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(await bodyText(response), '{"error":"server_error"}');
    assert.equal(calls.length, 0);
    assert.equal(state.reads, 0);
  }
  assert.equal(logs.length, 4);
  for (const entry of logs) assert.deepEqual(entry, { event: 'auth_config_error', code: 'config' });
});

test('auth runs before the content type and size checks, so an unauthenticated caller learns nothing about them', async () => {
  const headers = { 'content-type': 'text/plain', 'content-length': '999999999' };
  const { handler, calls } = makeHandler();
  const response = await handlePost(new Request(ENDPOINT, { method: 'POST', headers, body: '{}' }), options(), handler);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('the injected clock decides expiry', async () => {
  const config = `p1:${TOKEN_HASH}:2026-11-01T12:00:00Z`;
  const { handler } = makeHandler();
  assert.equal((await handlePost(textRequest('{}'), options({ authConfig: config, now: NOW - 1 }), handler)).status, 200);
  assert.equal((await handlePost(textRequest('{}'), options({ authConfig: config, now: NOW }), handler)).status, 401);
});

// ---- content type ----

test('application/json is accepted case-insensitively, with a utf-8 charset and normal whitespace', async () => {
  const accepted = [
    'application/json', 'Application/JSON', 'application/json; charset=utf-8', 'application/json;charset=UTF-8',
    '  application/json  ;  charset = "utf-8" ', 'application/json;', 'application/json; profile=x',
  ];
  for (const contentType of accepted) {
    const { handler, calls } = makeHandler();
    const headers = { ...JSON_HEADERS, 'content-type': contentType };
    const response = await handlePost(textRequest('{"ok":1}', headers), options(), handler);
    assert.equal(response.status, 200, contentType);
    assert.equal(calls.length, 1, contentType);
  }
});

test('other media types and non-utf-8 charsets are 415, and the body is not read', async () => {
  const rejected = [
    undefined, 'text/plain', 'application/jsonp', 'application/json-patch+json', 'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x', 'application/json; charset=iso-8859-1', 'application/json; charset=utf8',
    'application/json; charset=utf-16', 'application/json; charset=', 'application/json; charset=utf-8; charset=latin1',
    'application/json; bogus',
  ];
  for (const contentType of rejected) {
    const headers = { authorization: `Bearer ${TOKEN}` };
    if (contentType !== undefined) headers['content-type'] = contentType;
    const { handler, calls } = makeHandler();
    const { request, state } = streamRequest([encoder.encode('{}')], { headers });
    const response = await handlePost(request, options(), handler);
    assert.equal(response.status, 415, String(contentType));
    assert.equal(await bodyText(response), '{"error":"unsupported_media_type"}');
    assert.equal(calls.length, 0);
    assert.equal(state.reads, 0, String(contentType));
  }
});

// ---- body size ----

test('a declared length over the cap is a 413 without reading the body', async () => {
  const headers = { ...JSON_HEADERS, 'content-length': '5000' };
  const { handler, calls } = makeHandler();
  const { request, state } = streamRequest([encoder.encode('{}')], { headers });
  const response = await handlePost(request, options({ maxBodyBytes: 4096 }), handler);
  assert.equal(response.status, 413);
  assert.equal(await bodyText(response), '{"error":"payload_too_large"}');
  assert.equal(calls.length, 0);
  assert.equal(state.reads, 0);
});

test('a body of exactly the cap passes and one byte more is a 413', async () => {
  const pad = (bytes) => `{"a":"${'x'.repeat(bytes - 8)}"}`;
  const exact = pad(100);
  assert.equal(encoder.encode(exact).length, 100);
  const first = makeHandler();
  assert.equal((await handlePost(textRequest(exact), options({ maxBodyBytes: 100 }), first.handler)).status, 200);
  assert.equal(first.calls.length, 1);

  const over = pad(101);
  const second = makeHandler();
  assert.equal((await handlePost(textRequest(over), options({ maxBodyBytes: 100 }), second.handler)).status, 413);
  assert.equal(second.calls.length, 0);
});

test('an undeclared stream over the cap is a 413, the reader is cancelled and no more is pulled', async () => {
  const chunks = Array.from({ length: 50 }, () => encoder.encode('x'.repeat(10)));
  const { request, state, body } = streamRequest(chunks, { headers: JSON_HEADERS });
  const result = await readJsonBody(request, { maxBytes: 25 });
  assert.deepEqual(result, { ok: false, code: 'payload_too_large' });
  assert.equal(state.cancelled, true);
  assert.equal(state.reads <= 5, true);
  assert.equal(body.locked, false);
});

test('an overflow across a chunk boundary is a 413, including an exact-cap prefix followed by one more byte', async () => {
  const split = streamRequest([encoder.encode('{"a'), encoder.encode('":1}')]);
  assert.deepEqual(await readJsonBody(split.request, { maxBytes: 5 }), { ok: false, code: 'payload_too_large' });
  assert.equal(split.state.cancelled, true);

  const exactThenMore = streamRequest([encoder.encode('{"a":1}'), encoder.encode(' ')]);
  assert.deepEqual(await readJsonBody(exactThenMore.request, { maxBytes: 7 }), { ok: false, code: 'payload_too_large' });
});

test('a rejecting cancel() is swallowed, the 413 still stands and the reader lock is released', async () => {
  const { request, state, body } = streamRequest([encoder.encode('x'.repeat(30))], { cancelRejects: true });
  assert.deepEqual(await readJsonBody(request, { maxBytes: 10 }), { ok: false, code: 'payload_too_large' });
  assert.equal(state.cancelled, true);
  assert.equal(body.locked, false);
});

test('a malformed Content-Length is ignored, and the streaming cap still applies', async () => {
  for (const declared of ['abc', '-5', '1e3', '12abc', '', ' 5 ', '0x10']) {
    const headers = { ...JSON_HEADERS, 'content-length': declared };
    const small = streamRequest([encoder.encode('{"a":1}')], { headers });
    assert.deepEqual(await readJsonBody(small.request, { maxBytes: 100 }), { ok: true, value: { a: 1 } }, declared);

    const big = streamRequest([encoder.encode('x'.repeat(200))], { headers });
    assert.deepEqual(await readJsonBody(big.request, { maxBytes: 100 }), { ok: false, code: 'payload_too_large' }, declared);
  }
});

test('maxBodyBytes must be a positive safe integer: readJsonBody throws, handlePost is a generic 500', async () => {
  const invalid = [0, -1, 1.5, NaN, Infinity, '10', null, undefined, Number.MAX_SAFE_INTEGER + 1];
  for (const maxBytes of invalid) {
    await assert.rejects(readJsonBody(textRequest('{}'), { maxBytes }), RangeError);
  }
  await assert.rejects(readJsonBody(textRequest('{}')), RangeError);

  for (const maxBodyBytes of invalid) {
    const logs = [];
    const { handler, calls } = makeHandler();
    const { request, state } = streamRequest([encoder.encode('{}')]);
    const response = await handlePost(request, options({ maxBodyBytes, log: (entry) => logs.push(entry) }), handler);
    assert.equal(response.status, 500);
    assert.equal(await bodyText(response), '{"error":"server_error"}');
    assert.equal(calls.length, 0);
    assert.equal(state.reads, 0);
    assert.deepEqual(logs, [{ event: 'internal_error', code: 'invalid_body_limit' }]);
  }
});

// ---- JSON ----

test('empty, whitespace-only, truncated, non-JSON, invalid UTF-8 and bodiless requests are invalid_json', async () => {
  const bad = ['', '   ', '{', '{"a":', 'nope', "{'a':1}", '{"a":1}}'];
  for (const text of bad) {
    const { handler, calls } = makeHandler();
    const response = await handlePost(textRequest(text), options(), handler);
    assert.equal(response.status, 400, JSON.stringify(text));
    assert.equal(await bodyText(response), '{"error":"invalid_json"}');
    assert.equal(calls.length, 0);
  }

  const invalidUtf8 = streamRequest([Uint8Array.of(0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d)]);
  assert.deepEqual(await readJsonBody(invalidUtf8.request, { maxBytes: 100 }), { ok: false, code: 'invalid_json' });

  const bodiless = new Request(ENDPOINT, { method: 'POST', headers: JSON_HEADERS });
  assert.equal(bodiless.body, null);
  assert.deepEqual(await readJsonBody(bodiless, { maxBytes: 100 }), { ok: false, code: 'invalid_json' });
});

test('valid JSON that is not an object is invalid_body', async () => {
  for (const text of ['[]', '[{"a":1}]', 'null', '1', '"x"', 'true', '0']) {
    const { handler, calls } = makeHandler();
    const response = await handlePost(textRequest(text), options(), handler);
    assert.equal(response.status, 400, text);
    assert.equal(await bodyText(response), '{"error":"invalid_body"}');
    assert.equal(calls.length, 0);
  }
});

test('JSON objects parse, including multi-byte text split across chunks, and __proto__ never pollutes', async () => {
  assert.deepEqual(await readJsonBody(textRequest('{}'), { maxBytes: 10 }), { ok: true, value: {} });

  const bytes = encoder.encode('{"story":"café 🚗 日本語"}');
  const split = streamRequest([bytes.slice(0, 13), bytes.slice(13)]);
  assert.deepEqual(await readJsonBody(split.request, { maxBytes: 200 }), { ok: true, value: { story: 'café 🚗 日本語' } });

  const hostile = await readJsonBody(textRequest('{"__proto__":{"polluted":true},"a":1}'), { maxBytes: 200 });
  assert.equal(hostile.ok, true);
  assert.equal(Object.getPrototypeOf(hostile.value), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(hostile.value.a, 1);
});

test('client failures are logged by code only, with no body content', async () => {
  const logs = [];
  const { handler } = makeHandler();
  await handlePost(textRequest('{secret-body'), options({ log: (entry) => logs.push(entry) }), handler);
  await handlePost(textRequest('[]'), options({ log: (entry) => logs.push(entry) }), handler);
  assert.deepEqual(logs, [
    { event: 'body_rejected', code: 'invalid_json' },
    { event: 'body_rejected', code: 'invalid_body' },
  ]);
});

// ---- infrastructure failures are 500s, never invalid_json ----

test('a failing stream, a non-Uint8Array chunk and a throwing handler are generic 500s with whitelisted logs', async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);

  const failing = new Request(ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    duplex: 'half',
    body: new ReadableStream({ pull(controller) { controller.error(new Error('boom-secret-stream')); } }),
  });
  const first = await handlePost(failing, options({ log }), makeHandler().handler);
  assert.equal(first.status, 500);
  assert.equal(await bodyText(first), '{"error":"server_error"}');

  for (const chunk of ['text', 42, [1, 2], new ArrayBuffer(4), { length: 2 }]) {
    const { request, body } = streamRequest([chunk]);
    await assert.rejects(readJsonBody(request, { maxBytes: 100 }), (error) => error instanceof TypeError);
    assert.equal(body.locked, false);
    const second = await handlePost(streamRequest([chunk]).request, options({ log }), makeHandler().handler);
    assert.equal(second.status, 500);
    assert.equal(await bodyText(second), '{"error":"server_error"}');
  }

  const throwing = async () => { throw new Error('boom-secret-handler'); };
  const third = await handlePost(textRequest('{}'), options({ log }), throwing);
  assert.equal(third.status, 500);
  assert.equal(await bodyText(third), '{"error":"server_error"}');

  assert.deepEqual(logs[0], { event: 'internal_error', code: 'body_read_failed', kind: 'error' });
  assert.deepEqual(logs[1], { event: 'internal_error', code: 'body_read_failed', kind: 'type_error' });
  assert.deepEqual(logs.at(-1), { event: 'internal_error', code: 'handler_failed', kind: 'error' });
  assert.equal(JSON.stringify(logs).includes('boom-secret'), false);
});

test('a failing stream surfaces from readJsonBody unchanged and releases the lock', async () => {
  const streamError = new Error('read failed');
  const body = new ReadableStream({ pull(controller) { controller.error(streamError); } });
  const request = new Request(ENDPOINT, { method: 'POST', headers: JSON_HEADERS, body, duplex: 'half' });
  await assert.rejects(readJsonBody(request, { maxBytes: 100 }), (error) => error === streamError);
  assert.equal(body.locked, false);
});

test('a handler that returns something other than a Response is a generic 500', async () => {
  for (const result of [undefined, null, 'ok', { ok: true }, 42]) {
    const logs = [];
    const response = await handlePost(textRequest('{}'), options({ log: (entry) => logs.push(entry) }), async () => result);
    assert.equal(response.status, 500);
    assert.equal(await bodyText(response), '{"error":"server_error"}');
    assert.deepEqual(logs, [{ event: 'internal_error', code: 'invalid_handler_result' }]);
  }
  const notAFunction = await handlePost(textRequest('{}'), options(), undefined);
  assert.equal(notAFunction.status, 500);
});

test('a non-Error throw is logged as a constant kind only', async () => {
  const logs = [];
  const response = await handlePost(textRequest('{}'), options({ log: (entry) => logs.push(entry) }), async () => {
    throw 'secret-string-thrown';
  });
  assert.equal(response.status, 500);
  assert.deepEqual(logs, [{ event: 'internal_error', code: 'handler_failed', kind: 'non_error' }]);
});

// ---- logging hardening ----

test('a throwing or rejecting logger never changes the client response and never leaks an unhandled rejection', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const loggers = [
      () => { throw new Error('logger exploded'); },
      async () => { throw new Error('logger rejected'); },
      () => Promise.reject(new Error('logger rejected later')),
      'not a function',
      null,
      42,
    ];
    for (const log of loggers) {
      const missingAuth = new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal((await handlePost(missingAuth, options({ log }), makeHandler().handler)).status, 401);
      assert.equal((await handlePost(textRequest('{'), options({ log }), makeHandler().handler)).status, 400);
      assert.equal((await handlePost(textRequest('{}'), options({ log, authConfig: undefined }), makeHandler().handler)).status, 500);
      assert.equal((await handlePost(textRequest('{}'), options({ log }), async () => { throw new Error('x'); })).status, 500);
      const ok = await handlePost(textRequest('{}'), options({ log }), makeHandler().handler);
      assert.equal(ok.status, 200);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('every log entry is frozen, uses only whitelisted keys and constants, and never carries request data', async () => {
  const logs = [];
  const log = (entry) => logs.push(entry);
  const otherToken = randomBytes(32).toString('base64url');
  const secrets = [TOKEN, TOKEN_HASH, otherToken, 'secret-body-text', 'boom-secret', 'Bearer'];

  const requests = [
    new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` }, body: '{}' }),
    new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic x' }, body: '{}' }),
    textRequest('{"secret-body-text'),
    textRequest('[]'),
    new Request(ENDPOINT, { method: 'POST', headers: { ...JSON_HEADERS, 'content-type': 'text/plain' }, body: 'secret-body-text' }),
    new Request(ENDPOINT, { method: 'POST', headers: { ...JSON_HEADERS, 'content-length': '999999' }, body: '{}' }),
  ];
  for (const request of requests) await handlePost(request, options({ log }), makeHandler().handler);
  await handlePost(textRequest('{}'), options({ log, authConfig: undefined }), makeHandler().handler);
  await handlePost(textRequest('{}'), options({ log, maxBodyBytes: 0 }), makeHandler().handler);
  await handlePost(textRequest('{}'), options({ log }), async () => { throw new Error('boom-secret'); });
  await handlePost(textRequest('{}'), options({ log }), async () => 'not a response');

  assert.equal(logs.length >= 10, true);
  for (const entry of logs) {
    assert.equal(Object.isFrozen(entry), true);
    for (const key of Object.keys(entry)) assert.equal(['event', 'code', 'kind'].includes(key), true, key);
    assert.equal(LOG_EVENTS.includes(entry.event), true, entry.event);
    assert.equal(LOG_CODES.includes(entry.code), true, entry.code);
    if ('kind' in entry) assert.equal(LOG_KINDS.includes(entry.kind), true, entry.kind);
    const text = JSON.stringify(entry);
    for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  }
});

test('error responses never contain input, tokens, hashes or header values', async () => {
  const hostile = 'secret-body-text';
  const responses = [
    await handlePost(textRequest(`{"${hostile}`), options(), makeHandler().handler),
    await handlePost(textRequest('[]'), options(), makeHandler().handler),
    await handlePost(new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}x` }, body: hostile }), options(), makeHandler().handler),
    await handlePost(textRequest('{}'), options({ authConfig: AUTH_CONFIG.replace('p1', 'P1') }), makeHandler().handler),
    await handlePost(textRequest('{}'), options(), async () => { throw new Error(hostile); }),
  ];
  for (const response of responses) {
    const text = JSON.stringify(await snapshot(response));
    for (const secret of [TOKEN, TOKEN_HASH, hostile, 'Bearer ' + TOKEN, AUTH_CONFIG]) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
});
