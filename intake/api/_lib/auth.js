// Pilot access-token check for Intake v0.2 (a bounded H1 anti-abuse control, not customer auth).
//
// Pure: no process.env, no logging, no HTTP. The endpoint passes in the Authorization header
// value and the raw PILOT_TOKEN_HASHES string, and decides the HTTP response itself.
//
// Token: 32 random bytes as unpadded base64url, exactly 43 characters (openssl rand -base64url 32).
// Config: "pilotRef:sha256hex[:expiryISO]" entries, comma-separated, at most three.
// The stored hash is the SHA-256 of the token TEXT (the 43 characters), as lowercase hex:
//   printf '%s' "<token>" | shasum -a 256
// Failure codes are for server logs only. They never contain a token, hash or header value.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isPilotRef } from '../../shared/rules.js';

export const MAX_PILOT_ENTRIES = 3;

export const AUTH_CODES = Object.freeze({
  CONFIG: 'config', // server configuration problem, not a client error
  MISSING: 'missing',
  MALFORMED: 'malformed',
  UNKNOWN: 'unknown',
  EXPIRED: 'expired',
});

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
// Strict ISO 8601 with a mandatory timezone, so an expiry never depends on the server's locale.
const EXPIRY = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;

// Date.parse silently rolls impossible dates (2026-02-30) forward, so every part is checked.
function parseExpiry(text) {
  const match = EXPIRY.exec(text);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > daysInMonth) return null;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  if (second !== undefined && Number(second) > 59) return null;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return null;
  const milliseconds = Date.parse(text);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

// ISO timestamps contain colons, so only the first two separators split the entry.
function parseEntry(entry) {
  const first = entry.indexOf(':');
  if (first === -1) return null;
  const second = entry.indexOf(':', first + 1);
  const pilotRef = entry.slice(0, first);
  const hash = entry.slice(first + 1, second === -1 ? entry.length : second);
  const expiryText = second === -1 ? null : entry.slice(second + 1);

  if (!isPilotRef(pilotRef) || !HASH_HEX.test(hash)) return null;
  let expiresAtMs = null;
  if (expiryText !== null) {
    expiresAtMs = parseExpiry(expiryText);
    if (expiresAtMs === null) return null;
  }
  return { pilotRef, hash: Buffer.from(hash, 'hex'), expiresAtMs };
}

// Returns an array of { pilotRef, hash (32-byte Buffer), expiresAtMs | null }, or null when the
// configuration is missing or anything in it is malformed (the caller must then fail closed).
export function parseTokenHashes(configValue) {
  if (typeof configValue !== 'string') return null;
  const trimmed = configValue.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split(',');
  if (parts.length > MAX_PILOT_ENTRIES) return null;

  const entries = [];
  for (const part of parts) {
    const entry = parseEntry(part);
    if (entry === null) return null;
    entries.push(entry);
  }

  const labels = new Set(entries.map((entry) => entry.pilotRef));
  const hashes = new Set(entries.map((entry) => entry.hash.toString('hex')));
  if (labels.size !== entries.length || hashes.size !== entries.length) return null;
  return entries;
}

function readBearerToken(authorizationValue) {
  if (typeof authorizationValue !== 'string' || authorizationValue === '') {
    return { code: AUTH_CODES.MISSING };
  }
  const space = authorizationValue.indexOf(' ');
  if (space === -1 || authorizationValue.slice(0, space).toLowerCase() !== 'bearer') {
    return { code: AUTH_CODES.MALFORMED };
  }
  const token = authorizationValue.slice(space + 1);
  return TOKEN.test(token) ? { token } : { code: AUTH_CODES.MALFORMED };
}

function fail(code) {
  return { ok: false, code };
}

// authorizationValue: the raw Authorization header value (request.headers.get('authorization')).
// configValue: the raw PILOT_TOKEN_HASHES string, passed in explicitly by the endpoint.
// Returns { ok: true, pilotRef } or { ok: false, code }.
export function authenticate(authorizationValue, configValue, { now = Date.now() } = {}) {
  const entries = parseTokenHashes(configValue);
  if (entries === null) return fail(AUTH_CODES.CONFIG);

  const bearer = readBearerToken(authorizationValue);
  if (!('token' in bearer)) return fail(bearer.code);

  const presented = createHash('sha256').update(bearer.token, 'utf8').digest();

  // Compare against every entry, without stopping at the first hit.
  let matched = null;
  for (const entry of entries) {
    if (timingSafeEqual(presented, entry.hash) && matched === null) matched = entry;
  }
  if (matched === null) return fail(AUTH_CODES.UNKNOWN);

  // Expiry is exclusive (expiry <= now is expired), and an unusable clock fails closed.
  if (matched.expiresAtMs !== null && !(Number.isFinite(now) && now < matched.expiresAtMs)) {
    return fail(AUTH_CODES.EXPIRED);
  }
  return { ok: true, pilotRef: matched.pilotRef };
}
