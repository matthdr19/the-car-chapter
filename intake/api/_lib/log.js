// Smallest safe logger for the Intake endpoints (Intake v0.2).
//
// An entry may only carry whitelisted keys with whitelisted constant values, plus a fixed
// endpoint label added here. Anything else (an Error, a message, a stack, a request value, a
// token, a pilot ref, an id, a MIME value) cannot be logged: the whole entry is replaced by
// { endpoint, event: 'invalid_log_entry' } and the offending value is never written.
//
// The same logger is passed to handlePost() and to the handler factories. It never throws
// and never affects a response. console is used here only, as the default sink.
const ENDPOINTS = Object.freeze(['upload-url', 'remove']);

const ALLOWED = Object.freeze({
  event: Object.freeze(['auth_rejected', 'auth_config_error', 'body_rejected', 'internal_error', 'request_rejected']),
  code: Object.freeze([
    'missing', 'malformed', 'unknown', 'expired', 'config',
    'unsupported_media_type', 'payload_too_large', 'invalid_json', 'invalid_body',
    'invalid_body_limit', 'invalid_handler_result',
    'request_failed', 'auth_failed', 'body_read_failed', 'handler_failed',
  ]),
  kind: Object.freeze(['type_error', 'range_error', 'error', 'non_error']),
  reason: Object.freeze([
    'unknown_field', 'missing_field', 'wrong_type',
    'bad_case_id', 'bad_source_id', 'bad_mime_type', 'bad_file_size',
  ]),
});

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

// Returns a new object containing only validated whitelisted values, or null if anything is off.
function sanitize(entry) {
  if (!isPlainObject(entry)) return null;
  const keys = Object.keys(entry);
  if (!keys.includes('event')) return null;
  const safe = {};
  for (const key of keys) {
    if (!Object.hasOwn(ALLOWED, key)) return null;
    const value = entry[key];
    if (typeof value !== 'string' || !ALLOWED[key].includes(value)) return null;
    safe[key] = value;
  }
  return safe;
}

export function createLogger(endpoint, sink = (line) => console.error(line)) {
  if (!ENDPOINTS.includes(endpoint)) throw new RangeError('unknown endpoint');
  return (entry) => {
    const safe = sanitize(entry);
    const line = JSON.stringify(safe === null
      ? { endpoint, event: 'invalid_log_entry' }
      : { endpoint, ...safe });
    try {
      const result = sink(line);
      if (result && typeof result.then === 'function') result.then(undefined, () => {});
    } catch {
      // Logging is best effort and must never affect the request.
    }
  };
}
