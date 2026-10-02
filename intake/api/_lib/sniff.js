// Read only the leading bytes needed for server-side source signature validation.
// The range is an optimization; the bounded reader still rejects an ignored range.
import { get } from '@vercel/blob';
import { SNIFF_BYTES } from '../../shared/rules.js';

export class SniffWindowExceededError extends Error {
  constructor() {
    super('sniff window exceeded');
    this.name = 'SniffWindowExceededError';
  }
}

// Consume through EOF so an exact-limit prefix cannot conceal extra bytes.
// No bytes beyond the limit are copied or retained by this function.
export async function readBounded(stream, limit = SNIFF_BYTES, onOverflow = () => {}) {
  if (!stream || typeof stream.getReader !== 'function') throw new TypeError('missing blob stream');
  if (!Number.isInteger(limit) || limit < 1 || limit > SNIFF_BYTES) throw new RangeError('invalid sniff limit');

  const reader = stream.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytes.slice(0, length);
      if (!(value instanceof Uint8Array)) throw new TypeError('invalid blob stream chunk');
      if (value.length > limit - length) {
        try {
          await reader.cancel('sniff window exceeded');
        } catch {
          // Cancellation is best effort; the over-limit read still fails closed.
        } finally {
          onOverflow();
        }
        throw new SniffWindowExceededError();
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

// getBlob is injectable for local tests. Production uses the server-only SDK get().
export async function sniffBlob(pathname, getBlob = get) {
  const controller = new AbortController();
  const result = await getBlob(pathname, {
    access: 'private',
    useCache: false,
    headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` },
    abortSignal: controller.signal,
  });
  if (!result?.stream) throw new TypeError('missing blob stream');
  return readBounded(result.stream, SNIFF_BYTES, () => controller.abort());
}
