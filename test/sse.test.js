'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { SseError, framesFrom } = require('../lib/sse.js');

function bytesStream(text, chunkSize = 1) {
  const bytes = Buffer.from(text);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return Readable.from(chunks);
}

async function collect(text, chunkSize) {
  const frames = [];
  for await (const frame of framesFrom(bytesStream(text, chunkSize))) frames.push(frame);
  return frames;
}

test('SSE parser handles BOM, comments, multi-line data, CRLF and arbitrary byte boundaries', async () => {
  const text = '\uFEFF: keepalive\r\nid: 3\r\nevent: message\r\ndata: {"value":\r\ndata: [1,2,3]}\r\n\r\ndata: [DONE]\r\n\r\n';
  for (const chunkSize of [1, 2, 3, 7, 64]) {
    const frames = await collect(text, chunkSize);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].name, 'message');
    assert.equal(frames[0].text, '{"value":\n[1,2,3]}');
    assert.equal(frames[1].text, '[DONE]');
  }
});

test('SSE parser handles CR-only line endings', async () => {
  const frames = await collect('event: ping\rdata: one\r\rdata: [DONE]\r\r', 1);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].name, 'ping');
  assert.equal(frames[0].text, 'one');
  assert.equal(frames[1].text, '[DONE]');
});

test('SSE parser rejects a stream that ends inside an event', async () => {
  await assert.rejects(
    collect('data: {"choices":[]}\n', 2),
    (error) => error instanceof SseError && /ended inside an event/.test(error.message),
  );
});

test('SSE parser rejects invalid UTF-8', async () => {
  const stream = Readable.from([Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])]);
  await assert.rejects(async () => {
    for await (const _frame of framesFrom(stream)) { /* consume */ }
  }, SseError);
});

test('SSE parser cancels and unlocks a source when the consumer stops early', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: one\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const frame of framesFrom(stream)) {
    assert.equal(frame.text, 'one');
    break;
  }
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('SSE parser times out a source that stops producing bytes', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const _frame of framesFrom(stream, { readTimeoutMs: 10 })) { /* consume */ }
  }, (error) => error instanceof SseError && /silent for 10ms/.test(error.message));
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
