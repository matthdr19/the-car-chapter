import test, { after, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Real Request/Response objects, real wrappers and the real handlePost. Only requests that fail
// BEFORE the Blob SDK is reachable are sent here (the environment has no Blob credentials, so a
// stray SDK call would surface as a 500 rather than the expected 4xx). The success and Blob
// orchestration paths are covered with injected fakes in source-handlers.test.js.
const uploadUrl = await import('../api/upload-url.js');
const remove = await import('../api/remove.js');

const ENDPOINT_URL = ['https:', '', 'intake.test', 'api', 'test'].join('/');
const ORIGINAL_ENV = Object.hasOwn(process.env, 'PILOT_TOKEN_HASHES') ? process.env.PILOT_TOKEN_HASHES : undefined;
const ORIGINAL_HAD_ENV = Object.hasOwn(process.env, 'PILOT_TOKEN_HASHES');
const TOKEN = randomBytes(32).toString('base64url');
const HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const CONFIG = `p1:${HASH}`;
const CASE_ID = '3f2b8c1e-5a4d-4e7f-9b21-0c6d8a9e1f23';
const SOURCE_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const encoder = new TextEncoder();
const AUTHED = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

const ENDPOINTS = [
  { name: 'upload-url', module: uploadUrl, file: 'upload-url.js', label: 'upload-url' },
  { name: 'remove', module: remove, file: 'remove.js', label: 'remove' },
];

// The wrappers log real lines through console.error. They are silenced for this file so the
// test output stays readable; the logging test below captures and checks the exact lines.
const realConsoleError = console.error;
before(() => { console.error = () => {}; });
after(() => { console.error = realConsoleError; });

async function withEnv(value, fn) {
  const had = Object.hasOwn(process.env, 'PILOT_TOKEN_HASHES');
  const previous = process.env.PILOT_TOKEN_HASHES;
  if (value === undefined) delete process.env.PILOT_TOKEN_HASHES;
  else process.env.PILOT_TOKEN_HASHES = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.PILOT_TOKEN_HASHES = previous;
    else delete process.env.PILOT_TOKEN_HASHES;
  }
}

async function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

afterEach(() => {
  const has = Object.hasOwn(process.env, 'PILOT_TOKEN_HASHES');
  assert.equal(has, ORIGINAL_HAD_ENV);
  if (has) assert.equal(process.env.PILOT_TOKEN_HASHES, ORIGINAL_ENV);
});

// highWaterMark 0: pull runs only on a real read, so reads === 0 proves the body was never touched.
function streamRequest(chunks, headers) {
  const queue = [...chunks];
  const state = { reads: 0 };
  const body = new ReadableStream({
    pull(controller) {
      state.reads++;
      if (queue.length) controller.enqueue(queue.shift());
      else controller.close();
    },
  }, { highWaterMark: 0 });
  return { request: new Request(ENDPOINT_URL, { method: 'POST', headers, body, duplex: 'half' }), state };
}

const post = (body, headers = AUTHED) => new Request(ENDPOINT_URL, { method: 'POST', headers, body });
const snapshot = async (response) => ({
  status: response.status,
  headers: [...response.headers.entries()].sort(),
  body: await response.text(),
});
const exactJson = (bytes) => `{"x":"${'a'.repeat(bytes - 8)}"}`;

for (const { name, module, file, label } of ENDPOINTS) {
  // ---- shape ----

  test(`${name}: only POST is exported`, () => {
    assert.deepEqual(Object.keys(module), ['POST']);
    assert.equal(typeof module.POST, 'function');
  });

  test(`${name}: a non-POST method is a 405 with Allow: POST`, async () => {
    await withEnv(CONFIG, async () => {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await module.POST(new Request(ENDPOINT_URL, { method, headers: AUTHED }));
        assert.equal(response.status, 405, method);
        assert.equal(response.headers.get('allow'), 'POST', method);
      }
    });
  });

  // ---- auth ----

  test(`${name}: missing or invalid credentials get the same generic 401, and the body is never read`, async () => {
    const other = randomBytes(32).toString('base64url');
    const variants = [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', authorization: 'Basic abc' },
      { 'content-type': 'application/json', authorization: 'Bearer short' },
      { 'content-type': 'application/json', authorization: `Bearer ${other}` },
    ];
    const seen = [];
    await withEnv(CONFIG, async () => {
      for (const headers of variants) {
        const { request, state } = streamRequest([encoder.encode('{}')], headers);
        const response = await module.POST(request);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('www-authenticate'), 'Bearer');
        assert.equal(state.reads, 0);
        seen.push(await snapshot(response));
      }
    });
    for (const entry of seen) assert.deepEqual(entry, seen[0]);
    assert.equal(seen[0].body, '{"error":"unauthorized"}');
  });

  test(`${name}: a broken or missing auth config is a generic 500, and the body is never read`, async () => {
    for (const config of [undefined, '', 'p1:nothex', `p1:${HASH},p1:${'a'.repeat(64)}`]) {
      await withEnv(config, async () => {
        const { request, state } = streamRequest([encoder.encode('{}')], AUTHED);
        const response = await module.POST(request);
        assert.equal(response.status, 500);
        assert.equal(await response.text(), '{"error":"server_error"}');
        assert.equal(response.headers.get('www-authenticate'), null);
        assert.equal(state.reads, 0);
      });
    }
  });

  test(`${name}: PILOT_TOKEN_HASHES is read at request time, not cached at import`, async () => {
    const otherToken = randomBytes(32).toString('base64url');
    const otherHash = createHash('sha256').update(otherToken, 'utf8').digest('hex');
    const bad = JSON.stringify({});
    const run = async () => (await module.POST(post(bad))).status;
    assert.equal(await withEnv(CONFIG, run), 400); // authenticated, then rejected by field validation
    assert.equal(await withEnv(`p1:${otherHash}`, run), 401); // same credentials, different configuration
    assert.equal(await withEnv(undefined, run), 500); // no configuration at all
    assert.equal(await withEnv(CONFIG, run), 400);
  });

  // ---- content type and body ----

  test(`${name}: a wrong content type is a 415`, async () => {
    await withEnv(CONFIG, async () => {
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/json; charset=latin1', undefined]) {
        const headers = { authorization: `Bearer ${TOKEN}` };
        if (contentType !== undefined) headers['content-type'] = contentType;
        const response = await module.POST(post('{}', headers));
        assert.equal(response.status, 415, String(contentType));
        assert.equal(await response.text(), '{"error":"unsupported_media_type"}');
      }
    });
  });

  test(`${name}: a body over 4096 bytes is a 413, and exactly 4096 bytes is not`, async () => {
    await withEnv(CONFIG, async () => {
      const declared = streamRequest([encoder.encode('{}')], { ...AUTHED, 'content-length': '5000' });
      const first = await module.POST(declared.request);
      assert.equal(first.status, 413);
      assert.equal(await first.text(), '{"error":"payload_too_large"}');
      assert.equal(declared.state.reads, 0);

      const over = await module.POST(post(exactJson(4097)));
      assert.equal(over.status, 413);
      assert.equal(await over.text(), '{"error":"payload_too_large"}');

      const exact = exactJson(4096);
      assert.equal(encoder.encode(exact).length, 4096);
      const accepted = await module.POST(post(exact));
      assert.equal(accepted.status, 400); // past the body cap, rejected by field validation
      assert.equal(await accepted.text(), '{"error":"invalid_request"}');
    });
  });

  test(`${name}: malformed JSON is a 400 invalid_json, and a non-object is invalid_body`, async () => {
    await withEnv(CONFIG, async () => {
      for (const text of ['', '{', 'nope', '{"a":']) {
        const response = await module.POST(post(text));
        assert.equal(response.status, 400, JSON.stringify(text));
        assert.equal(await response.text(), '{"error":"invalid_json"}');
      }
      for (const text of ['[]', 'null', '1', '"x"']) {
        const response = await module.POST(post(text));
        assert.equal(response.status, 400, text);
        assert.equal(await response.text(), '{"error":"invalid_body"}');
      }
    });
  });

  test(`${name}: a field validation failure is a 400 invalid_request`, async () => {
    const bodies = [
      {},
      { case_id: CASE_ID },
      { case_id: CASE_ID, source_id: SOURCE_ID, filename: 'x.heic' },
      { case_id: CASE_ID.toUpperCase(), source_id: SOURCE_ID, mime_type: 'image/heic', file_size: 10 },
      { case_id: CASE_ID, source_id: 'garbage', mime_type: 'image/heic', file_size: 10 },
      { case_id: CASE_ID, source_id: SOURCE_ID, mime_type: 'image/heic', file_size: 10, pilot_ref: 'p9' },
    ];
    await withEnv(CONFIG, async () => {
      for (const body of bodies) {
        const response = await module.POST(post(JSON.stringify(body)));
        assert.equal(response.status, 400, JSON.stringify(Object.keys(body)));
        assert.equal(await response.text(), '{"error":"invalid_request"}');
      }
    });
  });

  // ---- logging ----

  test(`${name}: failures are logged as one safe line labelled with the endpoint`, async () => {
    const lines = await captureConsoleError(async () => {
      await withEnv(CONFIG, async () => {
        await module.POST(new Request(ENDPOINT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        await module.POST(post(JSON.stringify({ case_id: 'secret-case-value' })));
      });
    });
    assert.equal(lines.length, 2);
    for (const args of lines) {
      assert.equal(args.length, 1);
      assert.equal(typeof args[0], 'string');
      assert.equal(JSON.parse(args[0]).endpoint, label);
    }
    assert.equal(lines[0][0], `{"endpoint":"${label}","event":"auth_rejected","code":"missing"}`);
    assert.equal(lines[1][0], `{"endpoint":"${label}","event":"request_rejected","reason":"missing_field"}`);
    const serialised = lines.join('');
    for (const secret of [TOKEN, HASH, 'secret-case-value', CASE_ID, 'Bearer']) assert.equal(serialised.includes(secret), false, secret);
  });

  // ---- wrapper hygiene ----

  test(`${name}: the wrapper is thin, reads only PILOT_TOKEN_HASHES and exports only POST`, () => {
    const source = readFileSync(new URL(`../api/${file}`, import.meta.url), 'utf8');
    const code = source.replace(/^\s*\/\/.*$/gm, '');
    assert.deepEqual(code.match(/process\.env\.\w+/g), ['process.env.PILOT_TOKEN_HASHES']);
    assert.equal((code.match(/\bprocess\b/g) || []).length, 1);
    assert.deepEqual([...code.matchAll(/^export .*$/gm)].map((match) => match[0]), ['export async function POST(request) {']);
    assert.match(code, /const MAX_BODY_BYTES = 4096;/);
    assert.match(code, /maxBodyBytes: MAX_BODY_BYTES/);
    assert.match(code, new RegExp(`createLogger\\('${label}'\\)`));
    assert.equal(/\bconsole\b|\bfetch\b|@vercel\/blob/.test(code), false);
    const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]).sort();
    assert.deepEqual(imports, ['./_lib/blob.js', './_lib/http.js', './_lib/log.js', './_lib/source-handlers.js']);
  });
}

test('upload-url.js documents the Content-Type invariant without claiming Vercel enforcement', () => {
  const source = readFileSync(new URL('../api/upload-url.js', import.meta.url), 'utf8');
  assert.match(source, /declared MIME as its Content-Type/);
  assert.match(source, /MIME and header metadata is NOT proof/);
  assert.match(source, /head \+ sniff \+ signature/);
  assert.equal(/\bVercel (rejects|enforces|checks|validates)\b/i.test(source), false);
});

test('the environment is restored after every test', () => {
  const has = Object.hasOwn(process.env, 'PILOT_TOKEN_HASHES');
  assert.equal(has, ORIGINAL_HAD_ENV);
  if (has) assert.equal(process.env.PILOT_TOKEN_HASHES, ORIGINAL_ENV);
});
