// Handler factories for the source-file endpoints (Intake v0.2).
//
// Owns: strict field-set validation, field validation, mapping the snake_case request fields to
// the blob layer's camelCase arguments, calling the injected blob operation, and the endpoint
// success response. Validation failures return 400 invalid_request and log only
// { event: 'request_rejected', reason: <fixed constant> }, never a value.
//
// Does NOT own: auth, process.env, reading the HTTP body, the body size cap, blob paths, byte
// or signature validation, Formspark, source counts or CORS. Blob failures are not caught or
// translated here: they propagate to handlePost(), which turns them into a generic 500.
//
// Content-Type: the browser must PUT the file using the declared MIME as its Content-Type, and
// the signed upload is scoped using that declared MIME. MIME and header metadata is NOT proof
// of the actual bytes: submit performs the real validation later (head + sniff + signature).
import { errorResponse, jsonResponse } from './http.js';
import { isAllowedMime, isUuid, isValidFileSize } from '../../shared/rules.js';

const UPLOAD_FIELDS = Object.freeze(['case_id', 'source_id', 'mime_type', 'file_size']);
const REMOVE_FIELDS = Object.freeze(['case_id', 'source_id']);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Returns a fixed reason constant for the first failing check, or null when the body is valid.
function validate(body, fields) {
  if (!isPlainObject(body)) return 'wrong_type';

  const keys = Object.keys(body);
  if (keys.some((key) => !fields.includes(key))) return 'unknown_field';
  if (fields.some((field) => !Object.hasOwn(body, field))) return 'missing_field';

  if (typeof body.case_id !== 'string') return 'wrong_type';
  if (!isUuid(body.case_id)) return 'bad_case_id';
  if (typeof body.source_id !== 'string') return 'wrong_type';
  if (!isUuid(body.source_id)) return 'bad_source_id';
  if (fields === REMOVE_FIELDS) return null;

  if (typeof body.mime_type !== 'string') return 'wrong_type';
  if (!isAllowedMime(body.mime_type)) return 'bad_mime_type';
  if (typeof body.file_size !== 'number') return 'wrong_type';
  if (!Number.isInteger(body.file_size)) return 'bad_file_size';
  if (!isValidFileSize(body.file_size)) return 'bad_file_size';
  return null;
}

// A logger that is missing, throws or rejects can never change the response.
function makeReject(log) {
  return (reason) => {
    if (typeof log === 'function') {
      try {
        const result = log({ event: 'request_rejected', reason });
        if (result && typeof result.then === 'function') result.then(undefined, () => {});
      } catch {
        // Logging is best effort.
      }
    }
    return errorResponse('invalid_request');
  };
}

// Handler input is { pilotRef, body } only. pilotRef comes from authentication, never the body.
export function createUploadHandler({ signUpload, log } = {}) {
  if (typeof signUpload !== 'function') throw new TypeError('signUpload must be a function');
  const reject = makeReject(log);
  return async ({ pilotRef, body }) => {
    const reason = validate(body, UPLOAD_FIELDS);
    if (reason !== null) return reject(reason);

    const result = await signUpload({
      pilotRef,
      caseId: body.case_id,
      sourceId: body.source_id,
      mime: body.mime_type,
      size: body.file_size,
    });
    // Only the presigned URL is used. Nothing else from the blob layer is exposed.
    const presignedUrl = result?.presignedUrl;
    if (typeof presignedUrl !== 'string' || presignedUrl === '') throw new TypeError('invalid signing result');
    return jsonResponse({ upload_url: presignedUrl });
  };
}

export function createRemoveHandler({ deleteSource, log } = {}) {
  if (typeof deleteSource !== 'function') throw new TypeError('deleteSource must be a function');
  const reject = makeReject(log);
  return async ({ pilotRef, body }) => {
    const reason = validate(body, REMOVE_FIELDS);
    if (reason !== null) return reject(reason);

    await deleteSource({ pilotRef, caseId: body.case_id, sourceId: body.source_id });
    return jsonResponse({ ok: true });
  };
}
