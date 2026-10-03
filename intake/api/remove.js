// POST /api/remove: deletes one source file, whatever allowed MIME variant it was stored as.
//
// Request (exact keys): { case_id, source_id }. Response: { ok: true }. Idempotent: a source that
// is already gone still succeeds. The pilot comes only from authentication.
import { deleteSource } from './_lib/blob.js';
import { handlePost } from './_lib/http.js';
import { createLogger } from './_lib/log.js';
import { createRemoveHandler } from './_lib/source-handlers.js';

const MAX_BODY_BYTES = 4096;

export async function POST(request) {
  const log = createLogger('remove');
  return handlePost(
    request,
    { authConfig: process.env.PILOT_TOKEN_HASHES, maxBodyBytes: MAX_BODY_BYTES, log },
    createRemoveHandler({ deleteSource, log }),
  );
}
