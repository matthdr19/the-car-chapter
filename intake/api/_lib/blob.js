// Thin, injectable wrapper over @vercel/blob for Intake source files (Intake v0.2).
//
// No HTTP, no auth, no process.env, no logging. The SDK authenticates through the project's
// OIDC and BLOB_STORE_ID on its own. Every pathname is recomputed here from validated
// identifiers (cases/{pilotRef}/{caseId}/{sourceId}.{ext}); a caller-supplied pathname is never
// accepted or used. SDK errors propagate unchanged, except a missing blob where noted.
import { issueSignedToken, presignUrl, head, del, BlobNotFoundError } from '@vercel/blob';
import { SIGNED_URL_TTL_MS, blobPathname, isValidFileSize } from '../../shared/rules.js';

const defaultSdk = Object.freeze({ issueSignedToken, presignUrl, head, del });

// The five canonical source formats currently allowed by shared/rules.js, in a fixed order.
// rules.js exports no iterable collection of them, so they are listed here; a test keeps this
// list in step with rules.js.
const SOURCE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// The real BlobNotFoundError has name === 'Error', so only instanceof identifies it.
const isNotFound = (error) => error instanceof BlobNotFoundError;

// Signs a PUT scoped to the exact pathname and the signing constraints below.
// Returns only what the browser needs: the presigned URL and its expiry. No pathname,
// store identifier or signing secret.
export async function signUpload({ pilotRef, caseId, sourceId, mime, size }, { now = Date.now(), sdk = defaultSdk } = {}) {
  const pathname = blobPathname({ pilotRef, caseId, sourceId, mime });
  if (!isValidFileSize(size)) throw new Error('invalid size');
  if (!Number.isFinite(now)) throw new Error('invalid clock');

  const validUntil = now + SIGNED_URL_TTL_MS;
  const token = await sdk.issueSignedToken({
    pathname,
    operations: ['put'],
    validUntil,
    allowedContentTypes: [mime],
    maximumSizeInBytes: size,
  });
  const { presignedUrl } = await sdk.presignUrl(token, {
    operation: 'put',
    pathname,
    access: 'private',
    validUntil,
    allowedContentTypes: [mime],
    maximumSizeInBytes: size,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { presignedUrl, expiresAt: validUntil };
}

// Returns { size, contentType } for the stored source, or null when it does not exist.
// contentType is the blob's declared or pathname-derived metadata, not a content check.
export async function headSource({ pilotRef, caseId, sourceId, mime }, { sdk = defaultSdk } = {}) {
  const pathname = blobPathname({ pilotRef, caseId, sourceId, mime });
  try {
    const result = await sdk.head(pathname);
    return { size: result.size, contentType: result.contentType };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// Deletes every canonical variant of one source identity. The extension is part of the
// pathname, so the caller's MIME is neither needed nor trusted: all five variants under exactly
// this pilotRef/caseId/sourceId are attempted, in a fixed order. Idempotent: a missing variant
// is skipped. Any other SDK error propagates unchanged and stops the loop, which is safe to retry.
export async function deleteSource({ pilotRef, caseId, sourceId }, { sdk = defaultSdk } = {}) {
  const pathnames = SOURCE_MIMES.map((mime) => blobPathname({ pilotRef, caseId, sourceId, mime }));
  for (const pathname of pathnames) {
    try {
      await sdk.del(pathname);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
