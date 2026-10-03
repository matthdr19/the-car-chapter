// Shared POST/JSON plumbing for the Intake endpoints (Intake v0.2).
//
// handlePost() enforces one fixed order: method -> auth -> body -> handler. No blob operations,
// no payload schema, no Formspark, no process.env, no console. The endpoint reads its own
// environment and passes the raw PILOT_TOKEN_HASHES string in as authConfig.
//
// Client-facing errors are a code only: { "error": "<code>" }. Internal detail (auth codes,
// failure kinds) goes only to the optional log callback, as whitelisted constants. Error
// messages, stacks, request bodies, tokens, hashes and headers are never logged or returned.
import { AUTH_CODES, authenticate } from './auth.js';

const ERRORS = Object.freeze({
  method_not_allowed: 405,
  unauthorized: 401,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_json: 400,
  invalid_body: 400,
  invalid_request: 400,
  server_error: 500,
});

const ERROR_HEADERS = Object.freeze({
  method_not_allowed: Object.freeze({ allow: 'POST' }),
  unauthorized: Object.freeze({ 'www-authenticate': 'Bearer' }),
});

const BASE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

const AUTH_REJECTION_CODES = Object.freeze([
  AUTH_CODES.MISSING,
  AUTH_CODES.MALFORMED,
  AUTH_CODES.UNKNOWN,
  AUTH_CODES.EXPIRED,
]);
const PHASE_CODES = Object.freeze({
  request: 'request_failed',
  auth: 'auth_failed',
  body: 'body_read_failed',
  handler: 'handler_failed',
});

export function jsonResponse(data, status = 200) {
  return Response.json(data, { status, headers: BASE_HEADERS });
}

// Only known codes are accepted, so an arbitrary string can never reach a client response.
export function errorResponse(code) {
  if (!Object.hasOwn(ERRORS, code)) throw new RangeError('unknown error code');
  return Response.json({ error: code }, {
    status: ERRORS[code],
    headers: { ...BASE_HEADERS, ...ERROR_HEADERS[code] },
  });
}

export function methodNotAllowed() {
  return errorResponse('method_not_allowed');
}

const isValidLimit = (value) => Number.isSafeInteger(value) && value >= 1;

// application/json, case-insensitive, optional parameters; any charset must be utf-8.
function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const [type, ...parameters] = value.split(';');
  if (type.trim().toLowerCase() !== 'application/json') return false;
  for (const parameter of parameters) {
    if (parameter.trim() === '') continue;
    const equals = parameter.indexOf('=');
    if (equals === -1) return false;
    if (parameter.slice(0, equals).trim().toLowerCase() !== 'charset') continue;
    let charset = parameter.slice(equals + 1).trim();
    if (charset.length >= 2 && charset.startsWith('"') && charset.endsWith('"')) charset = charset.slice(1, -1);
    if (charset.toLowerCase() !== 'utf-8') return false;
  }
  return true;
}

// Reads at most maxBytes of the request body. Expected client failures come back as
// { ok: false, code }. Infrastructure and programmer failures throw: an invalid maxBytes
// (RangeError), a failing stream (the stream's error) and a non-Uint8Array chunk (TypeError).
export async function readJsonBody(request, { maxBytes } = {}) {
  if (!isValidLimit(maxBytes)) throw new RangeError('invalid maxBytes');

  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { ok: false, code: 'unsupported_media_type' };
  }

  // A declared length over the cap is refused without reading. A missing or malformed header
  // is ignored, because the streaming count below is what enforces the cap.
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared)) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) return { ok: false, code: 'payload_too_large' };
  }

  if (request.body === null) return { ok: false, code: 'invalid_json' };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('invalid body chunk');
      if (value.length > maxBytes - total) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort; the body is refused either way.
        }
        return { ok: false, code: 'payload_too_large' };
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'invalid_json' };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'invalid_body' };
  }
  return { ok: true, value };
}

// Constant, whitelisted error kinds only: never the message, stack or name of the error.
function errorKind(error) {
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof RangeError) return 'range_error';
  if (error instanceof Error) return 'error';
  return 'non_error';
}

// The logger can never affect the client response: a throw or a rejected promise is swallowed.
function makeReporter(log) {
  return (entry) => {
    if (typeof log !== 'function') return;
    try {
      const result = log(Object.freeze({ ...entry }));
      if (result && typeof result.then === 'function') result.then(undefined, () => {});
    } catch {
      // Logging is best effort.
    }
  };
}

// handler receives { pilotRef, body } and must return a Response (normally via jsonResponse).
// Order: method -> auth -> body -> handler. An unauthenticated caller always gets the same
// generic 401, whatever the body or content type, and the body is never read for them.
export async function handlePost(request, { authConfig, maxBodyBytes, now, log } = {}, handler) {
  const report = makeReporter(log);
  let phase = 'request';
  try {
    if (request.method !== 'POST') return methodNotAllowed();

    phase = 'auth';
    const auth = authenticate(request.headers.get('authorization'), authConfig, { now });
    if (!auth.ok) {
      if (auth.code === AUTH_CODES.CONFIG) {
        report({ event: 'auth_config_error', code: AUTH_CODES.CONFIG });
        return errorResponse('server_error');
      }
      const code = AUTH_REJECTION_CODES.includes(auth.code) ? auth.code : AUTH_CODES.UNKNOWN;
      report({ event: 'auth_rejected', code });
      return errorResponse('unauthorized');
    }

    phase = 'body';
    if (!isValidLimit(maxBodyBytes)) {
      report({ event: 'internal_error', code: 'invalid_body_limit' });
      return errorResponse('server_error');
    }
    const parsed = await readJsonBody(request, { maxBytes: maxBodyBytes });
    if (!parsed.ok) {
      report({ event: 'body_rejected', code: parsed.code });
      return errorResponse(parsed.code);
    }

    phase = 'handler';
    const response = await handler({ pilotRef: auth.pilotRef, body: parsed.value });
    if (!(response instanceof Response)) {
      report({ event: 'internal_error', code: 'invalid_handler_result' });
      return errorResponse('server_error');
    }
    return response;
  } catch (error) {
    report({ event: 'internal_error', code: PHASE_CODES[phase], kind: errorKind(error) });
    return errorResponse('server_error');
  }
}
