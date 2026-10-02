import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authenticate, parseTokenHashes, AUTH_CODES, MAX_PILOT_ENTRIES } from '../api/_lib/auth.js';

// Synthetic fixtures only: tokens are generated per test and nothing real is used.
const makeToken = () => randomBytes(32).toString('base64url');
const hashOf = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const entry = (pilotRef, token, expiry) => `${pilotRef}:${hashOf(token)}${expiry ? ':' + expiry : ''}`;
const bearer = (token) => `Bearer ${token}`;
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function assertFail(result, code) {
  assert.deepEqual(result, { ok: false, code });
}

test('generated tokens are 43 unpadded base64url characters', () => {
  for (let i = 0; i < 200; i++) assert.match(makeToken(), /^[A-Za-z0-9_-]{43}$/);
});

test('the hash is the SHA-256 of the token text, checked against a fixed vector', () => {
  const token = 'A'.repeat(43);
  const expected = '0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a';
  assert.equal(hashOf(token), expected);
  assert.deepEqual(authenticate(bearer(token), `p1:${expected}`, { now: NOW }), { ok: true, pilotRef: 'p1' });

  // A hash of the decoded 32 bytes is a different value and must not match the token text.
  const decodedHash = createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex');
  assert.notEqual(decodedHash, expected);
  assertFail(authenticate(bearer(token), `p1:${decodedHash}`, { now: NOW }), AUTH_CODES.UNKNOWN);
});

test('auth codes are the five documented values', () => {
  assert.deepEqual({ ...AUTH_CODES }, {
    CONFIG: 'config',
    MISSING: 'missing',
    MALFORMED: 'malformed',
    UNKNOWN: 'unknown',
    EXPIRED: 'expired',
  });
  assert.equal(MAX_PILOT_ENTRIES, 3);
});

// ---- parseTokenHashes ----

test('parse: one, two and three entries', () => {
  const one = parseTokenHashes(`p1:${HEX_A}`);
  assert.equal(one.length, 1);
  assert.equal(one[0].pilotRef, 'p1');
  assert.equal(one[0].hash.length, 32);
  assert.equal(one[0].hash.toString('hex'), HEX_A);
  assert.equal(one[0].expiresAtMs, null);
  assert.equal(parseTokenHashes(`p1:${HEX_A},p2:${HEX_B}`).length, 2);
  assert.deepEqual(parseTokenHashes(`p1:${HEX_A},p2:${HEX_B},p3:${HEX_C}`).map((e) => e.pilotRef), ['p1', 'p2', 'p3']);
});

test('parse: an ISO expiry is split off after the second colon only', () => {
  const cases = [
    ['2026-10-14T00:00:00Z', Date.UTC(2026, 9, 14)],
    ['2026-10-14T02:00:00+02:00', Date.UTC(2026, 9, 14)],
    ['2026-10-13T20:00:00-04:00', Date.UTC(2026, 9, 14)],
    ['2026-10-14T00:00Z', Date.UTC(2026, 9, 14)],
    ['2026-10-14T00:00:00.500Z', Date.UTC(2026, 9, 14) + 500],
    ['2028-02-29T00:00:00Z', Date.UTC(2028, 1, 29)],
  ];
  for (const [expiry, expected] of cases) {
    const parsed = parseTokenHashes(`p1:${HEX_A}:${expiry},p2:${HEX_B}`);
    assert.equal(parsed[0].expiresAtMs, expected, expiry);
    assert.equal(parsed[1].expiresAtMs, null);
  }
});

test('parse: surrounding whitespace is trimmed, inner whitespace is malformed', () => {
  assert.equal(parseTokenHashes(`  \np1:${HEX_A}\n `).length, 1);
  const spaced = [
    `p1:${HEX_A}, p2:${HEX_B}`,
    `p1:${HEX_A} ,p2:${HEX_B}`,
    `p1: ${HEX_A}`,
    `p1 :${HEX_A}`,
    `p1:${HEX_A}\n,p2:${HEX_B}`,
    `p1:${HEX_A}:2026-10-14T00:00:00Z ,p2:${HEX_B}`,
  ];
  for (const value of spaced) assert.equal(parseTokenHashes(value), null, JSON.stringify(value));
});

test('parse: missing, empty or non-string configuration is null', () => {
  for (const value of [undefined, null, '', '   ', '\n', 42, {}, [], true]) {
    assert.equal(parseTokenHashes(value), null, String(value));
  }
});

test('parse: any malformed entry makes the whole configuration null', () => {
  const bad = [
    'p1', 'p1:', ':' + HEX_A, 'P1:' + HEX_A, '1p:' + HEX_A, 'p-1:' + HEX_A, 'a'.repeat(17) + ':' + HEX_A,
    'p1:' + 'a'.repeat(63), 'p1:' + 'a'.repeat(65), 'p1:' + 'A'.repeat(64), 'p1:' + 'g'.repeat(64),
    `p1:${HEX_A}:`, `p1:${HEX_A}:2026-10-14T00:00:00Z:extra`,
  ];
  for (const value of bad) assert.equal(parseTokenHashes(value), null, value);
  // One bad entry poisons an otherwise valid list.
  assert.equal(parseTokenHashes(`p1:${HEX_A},p2:nothex`), null);
  assert.equal(parseTokenHashes(`p1:${HEX_A},`), null);
  assert.equal(parseTokenHashes(`,p1:${HEX_A}`), null);
  assert.equal(parseTokenHashes(`p1:${HEX_A},,p2:${HEX_B}`), null);
});

test('parse: malformed or impossible expiries are rejected, including dates Date.parse would roll over', () => {
  const badExpiries = [
    'soon', '2026-10-14', '2026-10-14T00:00:00', '2026-10-14 00:00:00Z', '1e3', '1791936000000',
    '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-32T00:00:00Z', '2026-10-14T24:00:00Z',
    '2026-10-14T00:60:00Z', '2026-10-14T00:00:60Z', '2026-10-14T00:00:00+24:00', '2026-10-14T00:00:00+02:60',
    '2026-10-14T00:00:00.Z', '2026-10-14T00:00:00.1234Z', '2026-10-14T00Z',
  ];
  for (const expiry of badExpiries) {
    assert.equal(parseTokenHashes(`p1:${HEX_A}:${expiry}`), null, expiry);
  }
});

test('parse: duplicate labels, duplicate hashes and more than three entries are rejected', () => {
  assert.equal(parseTokenHashes(`p1:${HEX_A},p1:${HEX_B}`), null);
  assert.equal(parseTokenHashes(`p1:${HEX_A},p2:${HEX_A}`), null);
  assert.equal(parseTokenHashes(`p1:${HEX_A},p2:${HEX_B},p3:${HEX_C},p4:${'d'.repeat(64)}`), null);
});

// ---- authenticate: success ----

test('a valid token returns its pilotRef and nothing else', () => {
  const token = makeToken();
  const result = authenticate(bearer(token), entry('p1', token), { now: NOW });
  assert.deepEqual(result, { ok: true, pilotRef: 'p1' });
  assert.deepEqual(Object.keys(result), ['ok', 'pilotRef']);
});

test('each of three pilots resolves independently', () => {
  const tokens = [makeToken(), makeToken(), makeToken()];
  const config = tokens.map((token, index) => entry(`p${index + 1}`, token)).join(',');
  tokens.forEach((token, index) => {
    assert.deepEqual(authenticate(bearer(token), config, { now: NOW }), { ok: true, pilotRef: `p${index + 1}` });
  });
});

test('the Bearer scheme is case-insensitive, the token is not', () => {
  const token = makeToken();
  const config = entry('p1', token);
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
    assert.equal(authenticate(`${scheme} ${token}`, config, { now: NOW }).ok, true, scheme);
  }
  assertFail(authenticate(`Bearer ${token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase()}`, config, { now: NOW }), AUTH_CODES.UNKNOWN);
});

// ---- authenticate: failures ----

test('a missing or malformed configuration fails closed with the config code', () => {
  const token = makeToken();
  for (const config of [undefined, null, '', '  ', `p1:${HEX_A},p1:${HEX_B}`, 'p1:nothex', entry('P1', token)]) {
    assertFail(authenticate(bearer(token), config, { now: NOW }), AUTH_CODES.CONFIG);
  }
  // Configuration problems take precedence over a missing or bad header.
  assertFail(authenticate(undefined, undefined, { now: NOW }), AUTH_CODES.CONFIG);
  assertFail(authenticate('garbage', 'p1:nothex', { now: NOW }), AUTH_CODES.CONFIG);
});

test('a missing Authorization value has the missing code', () => {
  const config = entry('p1', makeToken());
  for (const value of [undefined, null, '', 42, {}, []]) {
    assertFail(authenticate(value, config, { now: NOW }), AUTH_CODES.MISSING);
  }
});

test('a malformed Authorization value has the malformed code', () => {
  const token = makeToken();
  const config = entry('p1', token);
  const bad = [
    `Basic ${token}`, `Token ${token}`, 'Bearer', 'Bearer ', `Bearer  ${token}`, `Bearer ${token} `,
    ` Bearer ${token}`, `Bearer\t${token}`, token, `Bearer ${token.slice(0, 42)}`, `Bearer ${token}A`,
    `Bearer ${'+'.repeat(43)}`, `Bearer ${'/'.repeat(43)}`, `Bearer ${token.slice(0, 42)}=`,
    `Bearer ${token.slice(0, 21)} ${token.slice(21)}`, `Bearer ${'é'.repeat(43)}`, `Bearer ${token}\n`,
  ];
  for (const value of bad) assertFail(authenticate(value, config, { now: NOW }), AUTH_CODES.MALFORMED);
});

test('a well-formed but unregistered or altered token is unknown', () => {
  const token = makeToken();
  const config = entry('p1', token);
  assertFail(authenticate(bearer(makeToken()), config, { now: NOW }), AUTH_CODES.UNKNOWN);
  const altered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assertFail(authenticate(bearer(altered), config, { now: NOW }), AUTH_CODES.UNKNOWN);
});

test('revocation: removing an entry stops its token and leaves the others working', () => {
  const [first, second] = [makeToken(), makeToken()];
  const both = `${entry('p1', first)},${entry('p2', second)}`;
  assert.equal(authenticate(bearer(first), both, { now: NOW }).ok, true);
  const revoked = entry('p2', second);
  assertFail(authenticate(bearer(first), revoked, { now: NOW }), AUTH_CODES.UNKNOWN);
  assert.deepEqual(authenticate(bearer(second), revoked, { now: NOW }), { ok: true, pilotRef: 'p2' });
});

// ---- authenticate: expiry ----

test('expiry is exclusive: valid before, expired at and after the expiry instant', () => {
  const token = makeToken();
  const config = entry('p1', token, '2026-10-03T12:00:00Z');
  assert.equal(authenticate(bearer(token), config, { now: NOW - 1 }).ok, true);
  assertFail(authenticate(bearer(token), config, { now: NOW }), AUTH_CODES.EXPIRED);
  assertFail(authenticate(bearer(token), config, { now: NOW + 1 }), AUTH_CODES.EXPIRED);
});

test('an expiry with an offset is compared as an instant', () => {
  const token = makeToken();
  const config = entry('p1', token, '2026-10-03T14:00:00+02:00'); // 12:00:00Z
  assert.equal(authenticate(bearer(token), config, { now: NOW - 1 }).ok, true);
  assertFail(authenticate(bearer(token), config, { now: NOW }), AUTH_CODES.EXPIRED);
});

test('the default clock is used when now is omitted', () => {
  const token = makeToken();
  assertFail(authenticate(bearer(token), entry('p1', token, '2000-01-01T00:00:00Z')), AUTH_CODES.EXPIRED);
  assert.equal(authenticate(bearer(token), entry('p1', token, '2999-01-01T00:00:00Z')).ok, true);
});

test('an unusable clock fails closed for an entry with an expiry, and is irrelevant without one', () => {
  const token = makeToken();
  const expiring = entry('p1', token, '2999-01-01T00:00:00Z');
  for (const now of [NaN, Infinity, -Infinity, null, 'x', {}]) {
    assertFail(authenticate(bearer(token), expiring, { now }), AUTH_CODES.EXPIRED);
  }
  assert.equal(authenticate(bearer(token), entry('p1', token), { now: NaN }).ok, true);
});

test('one pilot expiring does not affect another, and unknown wins over expired', () => {
  const [first, second] = [makeToken(), makeToken()];
  const config = `${entry('p1', first, '2026-10-03T12:00:00Z')},${entry('p2', second)}`;
  assertFail(authenticate(bearer(first), config, { now: NOW }), AUTH_CODES.EXPIRED);
  assert.deepEqual(authenticate(bearer(second), config, { now: NOW }), { ok: true, pilotRef: 'p2' });
  assertFail(authenticate(bearer(makeToken()), config, { now: NOW }), AUTH_CODES.UNKNOWN);
});

// ---- safety ----

test('results never contain the token, its hash or the header value', () => {
  const token = makeToken();
  const config = `${entry('p1', token)},${entry('p2', makeToken(), '2000-01-01T00:00:00Z')}`;
  const header = bearer(token);
  const results = [
    authenticate(header, config, { now: NOW }),
    authenticate(header, undefined, { now: NOW }),
    authenticate(undefined, config, { now: NOW }),
    authenticate('Bearer nope', config, { now: NOW }),
    authenticate(bearer(makeToken()), config, { now: NOW }),
    authenticate(header, entry('p1', token, '2000-01-01T00:00:00Z'), { now: NOW }),
  ];
  for (const result of results) {
    const text = JSON.stringify(result);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(hashOf(token)), false);
    assert.equal(text.includes('Bearer'), false);
    assert.deepEqual(Object.keys(result), result.ok ? ['ok', 'pilotRef'] : ['ok', 'code']);
  }
});

test('authenticate ignores process.env: the configuration must be passed in explicitly', () => {
  const token = makeToken();
  const previous = process.env.PILOT_TOKEN_HASHES;
  process.env.PILOT_TOKEN_HASHES = entry('p1', token);
  try {
    assertFail(authenticate(bearer(token), undefined, { now: NOW }), AUTH_CODES.CONFIG);
  } finally {
    if (previous === undefined) delete process.env.PILOT_TOKEN_HASHES;
    else process.env.PILOT_TOKEN_HASHES = previous;
  }
});

test('auth.js stays pure: no env, logging or HTTP, constant-time compare, minimal imports', () => {
  const source = readFileSync(new URL('../api/_lib/auth.js', import.meta.url), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\bprocess\b/.test(code), false);
  assert.equal(/\bconsole\b/.test(code), false);
  assert.equal(/\bResponse\b|\bunauthorized/i.test(code), false);
  assert.equal(/\bheaders\b/.test(code), false);
  assert.match(code, /timingSafeEqual\(/);
  assert.equal(/\.equals\(|entry\.hash\s*===/.test(code), false);
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ['../../shared/rules.js', 'node:crypto']);
});
