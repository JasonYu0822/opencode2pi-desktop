'use strict';

const DEFAULT_MAX_EVENT_BYTES = 32 * 1024 * 1024;

class SseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SseError';
  }
}

function readerFor(source) {
  if (source && typeof source.getReader === 'function') {
    const reader = source.getReader();
    return {
      read: () => reader.read(),
      release: () => reader.releaseLock(),
      cancel: (reason) => reader.cancel(reason),
    };
  }
  if (source && typeof source[Symbol.asyncIterator] === 'function') {
    const iterator = source[Symbol.asyncIterator]();
    return {
      read: () => iterator.next(),
      release: () => {},
      cancel: (reason) => iterator.return ? iterator.return(reason) : undefined,
    };
  }
  throw new TypeError('SSE source must be an async iterable or a ReadableStream');
}

function concat(parts, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Parse an SSE byte stream into complete frames. The parser accepts arbitrary
 * byte boundaries, BOM, comments, CRLF/CR/LF line endings and multi-line data.
 */
async function* framesFrom(source, options = {}) {
  const maxEventBytes = Number.isFinite(options.maxEventBytes)
    ? options.maxEventBytes
    : DEFAULT_MAX_EVENT_BYTES;
  const maxTotalBytes = Number.isFinite(options.maxTotalBytes)
    ? options.maxTotalBytes
    : Infinity;
  const readTimeoutMs = Number.isFinite(options.readTimeoutMs) && options.readTimeoutMs > 0
    ? options.readTimeoutMs
    : 0;
  const reader = readerFor(source);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let parts = [];
  let lineBytes = 0;
  let eventBytes = 0;
  let totalBytes = 0;
  let lines = [];
  let rawLines = [];
  let skipLF = false;
  let pendingFrame;
  let firstLine = true;
  let finished = false;

  function charge(value) {
    eventBytes += value;
    if (eventBytes > maxEventBytes) {
      throw new SseError('upstream SSE event exceeds the buffer limit');
    }
  }

  function append(value) {
    charge(value.byteLength);
    if (value.byteLength === 0) return;
    parts.push(value);
    lineBytes += value.byteLength;
  }

  function decodeLine() {
    let line;
    try {
      line = decoder.decode(concat(parts, lineBytes));
    } catch (error) {
      throw new SseError('invalid UTF-8 in upstream SSE event', { cause: error });
    }
    parts = [];
    lineBytes = 0;
    return line;
  }

  function buildFrame() {
    let name = '';
    const data = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let content = colon < 0 ? '' : line.slice(colon + 1);
      if (content.startsWith(' ')) content = content.slice(1);
      if (field === 'event') name = content;
      if (field === 'data') data.push(content);
    }
    return {
      lines,
      name,
      text: data.join('\n'),
      raw: rawLines.join(''),
    };
  }

  function resetFrame() {
    lines = [];
    rawLines = [];
    eventBytes = 0;
  }

  function readChunk() {
    if (!readTimeoutMs) return reader.read();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SseError(`upstream SSE was silent for ${readTimeoutMs}ms`));
      }, readTimeoutMs);
      if (timer.unref) timer.unref();
      reader.read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  try {
    while (true) {
      const { done, value } = await readChunk();
      if (done) {
        finished = true;
        if (pendingFrame) {
          yield pendingFrame;
          pendingFrame = undefined;
          resetFrame();
        }
        if (eventBytes || lineBytes || parts.length || lines.length) {
          throw new SseError('upstream SSE ended inside an event');
        }
        return;
      }
      if (!value || value.byteLength === 0) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new SseError('upstream SSE exceeds the buffer limit');
      }

      let start = 0;
      if (skipLF && value.length) {
        if (value[0] === 10) {
          charge(1);
          if (pendingFrame) pendingFrame.raw += '\n';
          else rawLines[rawLines.length - 1] += '\n';
          start = 1;
        }
        skipLF = false;
        if (pendingFrame) {
          const frame = pendingFrame;
          pendingFrame = undefined;
          resetFrame();
          yield frame;
        }
      }

      for (let offset = start; offset < value.length; offset += 1) {
        if (value[offset] !== 10 && value[offset] !== 13) continue;
        append(value.subarray(start, offset));
        charge(1);
        let line = decodeLine();
        let rawLine = line + String.fromCharCode(value[offset]);
        if (firstLine) {
          line = line.replace(/^\uFEFF/, '');
          firstLine = false;
        }
        if (value[offset] === 13) {
          if (value[offset + 1] === 10) {
            rawLine += '\n';
            offset += 1;
            charge(1);
          } else if (offset + 1 === value.length) {
            skipLF = true;
          }
        }
        start = offset + 1;
        rawLines.push(rawLine);
        if (line) {
          lines.push(line);
        } else {
          const frame = buildFrame();
          resetFrame();
          if (skipLF) {
            pendingFrame = frame;
          } else {
            yield frame;
          }
        }
      }
      if (start < value.length) append(value.subarray(start));
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel('SSE consumer stopped before end of stream');
      } catch {
        /* cancellation is best effort */
      }
    }
    try {
      reader.release();
    } catch {
      /* releasing an already-cancelled reader is harmless */
    }
  }
}

function encodeEvent(data, name = '') {
  return `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function rewriteFrame(frame, data) {
  const keep = frame.lines.filter((line) => line !== 'data' && !line.startsWith('data:'));
  keep.push(`data: ${JSON.stringify(data)}`);
  return `${keep.join('\n')}\n\n`;
}

module.exports = {
  DEFAULT_MAX_EVENT_BYTES,
  SseError,
  encodeEvent,
  framesFrom,
  rewriteFrame,
};
