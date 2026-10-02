import test from 'node:test';
import assert from 'node:assert/strict';
import { SNIFF_BYTES } from '../shared/rules.js';
import { readBounded, sniffBlob, SniffWindowExceededError } from '../api/_lib/sniff.js';

const chunk = (size, value = 0x5a) => new Uint8Array(size).fill(value);

function streamOf(chunks, state = {}) {
  return new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift());
      else controller.close();
    },
    cancel(reason) {
      state.cancelReason = reason;
    },
  });
}

test('empty and short streams return only their actual bytes', async () => {
  assert.deepEqual(await readBounded(streamOf([])), new Uint8Array());
  assert.deepEqual(await readBounded(streamOf([chunk(2, 1), chunk(3, 2)])),
    Uint8Array.of(1, 1, 2, 2, 2));
});

test('an exact-limit stream across chunks succeeds and releases its reader', async () => {
  const stream = streamOf([chunk(1), chunk(2000), chunk(SNIFF_BYTES - 2001)]);
  const bytes = await readBounded(stream);
  assert.equal(bytes.length, SNIFF_BYTES);
  assert.equal(stream.locked, false);
});

test('the next byte beyond an exact-limit prefix cancels and fails closed', async () => {
  const state = {};
  const stream = streamOf([chunk(SNIFF_BYTES), chunk(1)], state);
  await assert.rejects(readBounded(stream), SniffWindowExceededError);
  assert.equal(state.cancelReason, 'sniff window exceeded');
  assert.equal(stream.locked, false);
});

test('one oversized chunk and an over-limit chunk boundary both fail closed', async () => {
  for (const chunks of [[chunk(SNIFF_BYTES + 1)], [chunk(2048), chunk(2049)]]) {
    const state = {};
    const stream = streamOf(chunks, state);
    await assert.rejects(readBounded(stream), SniffWindowExceededError);
    assert.equal(state.cancelReason, 'sniff window exceeded');
    assert.equal(stream.locked, false);
  }
});

test('an ignored range aborts the request as well as cancelling the stream', async () => {
  const state = {};
  let signal;
  const getBlob = async (_path, options) => {
    signal = options.abortSignal;
    return { stream: streamOf([chunk(SNIFF_BYTES + 1), chunk(1)], state), statusCode: 200 };
  };
  await assert.rejects(sniffBlob('cases/p1/file.jpg', getBlob), SniffWindowExceededError);
  assert.equal(signal.aborted, true);
  assert.equal(state.cancelReason, 'sniff window exceeded');
});

test('storage options request a private uncached 0–4095 byte range', async () => {
  let called = 0;
  const bytes = await sniffBlob('cases/p1/file.jpg', async (path, options) => {
    called++;
    assert.equal(path, 'cases/p1/file.jpg');
    assert.equal(options.access, 'private');
    assert.equal(options.useCache, false);
    assert.deepEqual(options.headers, { Range: 'bytes=0-4095' });
    assert.equal(options.abortSignal.aborted, false);
    return { stream: streamOf([Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)]), statusCode: 206 };
  });
  assert.equal(called, 1);
  assert.deepEqual(bytes, Uint8Array.of(0xff, 0xd8, 0xff, 0xe0));
});

test('SDK statusCode is irrelevant when a stream is present', async () => {
  for (const statusCode of [200, 206, undefined]) {
    const bytes = await sniffBlob('x', async () => ({ stream: streamOf([Uint8Array.of(7)]), statusCode }));
    assert.deepEqual(bytes, Uint8Array.of(7));
  }
});

test('missing blob or stream fails closed', async () => {
  for (const result of [null, { stream: null }, {}]) {
    await assert.rejects(sniffBlob('x', async () => result), /missing blob stream/);
  }
});

test('storage and stream read errors propagate, and the reader is released', async () => {
  const storageError = new Error('storage unavailable');
  await assert.rejects(sniffBlob('x', async () => { throw storageError; }), (error) => error === storageError);

  const readError = new Error('read failed');
  const stream = new ReadableStream({
    pull(controller) { controller.error(readError); },
  });
  await assert.rejects(readBounded(stream), (error) => error === readError);
  assert.equal(stream.locked, false);
});

test('invalid arguments throw TypeError or RangeError before the stream is read', async () => {
  const notStreams = [undefined, null, {}, { getReader: 'not a function' }, 'text', 42];
  for (const stream of notStreams) {
    await assert.rejects(
      readBounded(stream),
      (error) => error instanceof TypeError && error.message === 'missing blob stream',
    );
  }

  const badLimits = [0, -1, 1.5, NaN, Infinity, SNIFF_BYTES + 1, '10', null];
  for (const limit of badLimits) {
    const stream = streamOf([chunk(1)]);
    await assert.rejects(
      readBounded(stream, limit),
      (error) => error instanceof RangeError && error.message === 'invalid sniff limit',
    );
    assert.equal(stream.locked, false);
  }

  assert.equal((await readBounded(streamOf([chunk(1)]), 1)).length, 1);
  assert.equal((await readBounded(streamOf([chunk(SNIFF_BYTES)]), SNIFF_BYTES)).length, SNIFF_BYTES);
});

test('a non-Uint8Array chunk fails with TypeError and releases the reader', async () => {
  const badChunks = ['text', [1, 2, 3], new ArrayBuffer(4), { length: 2 }, 42];
  for (const bad of badChunks) {
    const stream = streamOf([bad]);
    await assert.rejects(
      readBounded(stream),
      (error) => error instanceof TypeError && error.message === 'invalid blob stream chunk',
    );
    assert.equal(stream.locked, false);
  }
});

test('a rejecting cancel() is swallowed: onOverflow still runs and the overflow error stands', async () => {
  const cancelError = new Error('cancel failed');
  let cancelCalled = false;
  let overflowCalls = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk(SNIFF_BYTES + 1));
    },
    cancel() {
      cancelCalled = true;
      return Promise.reject(cancelError);
    },
  });

  await assert.rejects(
    readBounded(stream, SNIFF_BYTES, () => { overflowCalls++; }),
    (error) =>
      error instanceof SniffWindowExceededError &&
      error !== cancelError &&
      error.message === 'sniff window exceeded',
  );
  assert.equal(cancelCalled, true);
  assert.equal(overflowCalls, 1);
  assert.equal(stream.locked, false);
});
