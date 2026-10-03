// POST /api/upload-url: returns a signed PUT URL for one source file.
//
// Request (exact keys): { case_id, source_id, mime_type, file_size }. Response: { upload_url }.
// The pilot comes only from authentication.
//
// Content-Type: the browser must PUT the file using the declared MIME as its Content-Type, and
// the signed upload is scoped using that declared MIME. MIME and header metadata is NOT proof
// of the actual bytes: submit performs the real validation later (head + sniff + signature).
import { signUpload } from './_lib/blob.js';
import { handlePost } from './_lib/http.js';
import { createLogger } from './_lib/log.js';
import { createUploadHandler } from './_lib/source-handlers.js';

const MAX_BODY_BYTES = 4096;

export async function POST(request) {
  const log = createLogger('upload-url');
  return handlePost(
    request,
    { authConfig: process.env.PILOT_TOKEN_HASHES, maxBodyBytes: MAX_BODY_BYTES, log },
    createUploadHandler({ signUpload, log }),
  );
}
