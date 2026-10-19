'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { _internals } = require('../main.js');

function event(value, name) {
  return `${name ? `event: ${name}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function upstreamSse(text, headers = {}) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 5) {
        controller.enqueue(bytes.subarray(offset, offset + 5));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'x-request-id': 'upstream-request',
      'retry-after': '3',
      'content-length': '999',
      ...headers,
    },
  });
}

async function withProxy(upstreamFetch, run) {
  const server = http.createServer((req, res) => {
    const path = req.url.endsWith('/responses') ? '/v1/responses' : '/v1/chat/completions';
    void _internals.handleUpstream(req, res, path).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  _internals.setTransport({ fetch: upstreamFetch });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    _internals.setTransport(null);
    await new Promise((resolve) => server.close(resolve));
  }
}

test('proxy aggregates a non-streaming Chat reply and maps split tool names', async () => {
  let upstreamBody;
  await withProxy(async (_url, init) => {
    upstreamBody = JSON.parse(init.body);
    return upstreamSse(
      event({
        id: 'chat-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'beam-free',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'Ba', arguments: '{"cmd":' } }] },
        }],
      })
      + event({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: 'sh', arguments: '"pwd"}' } }] },
          finish_reason: 'tool_calls',
        }],
      })
      + event({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })
      + event('[DONE]'),
    );
  }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'beam-free',
        stream: false,
        messages: [{ role: 'user', content: 'run pwd' }],
        tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'upstream-request');
    assert.equal(response.headers.get('retry-after'), '3');
    assert.equal(response.headers.get('content-length'), null);
    const body = await response.json();
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Bash');
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"pwd"}');
    assert.deepEqual(body.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
  assert.equal(upstreamBody.stream, true);
  assert.equal(upstreamBody.stream_options.include_usage, true);
  assert.ok(upstreamBody.tools.some((tool) => tool.function?.name === 'Bash'));
});

test('proxy guards a streaming Responses call through its terminal snapshot', async () => {
  await withProxy(async () => upstreamSse(
    event({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'call-1', call_id: 'call', name: 'read', arguments: '' },
    })
    + event({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      delta: '{"path":"a"}',
    })
    + event({
      type: 'response.completed',
      response: {
        id: 'resp-1',
        object: 'response',
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'call-1',
          call_id: 'call',
          name: 'read',
          arguments: '{"path":"a"}',
        }],
      },
    }),
  ), async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'muse-spark-test',
        stream: true,
        input: 'read a',
        tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal((text.match(/"name":"Read"/g) || []).length, 2);
    assert.match(text, /response\.completed/);
    assert.doesNotMatch(text, /upstream_error/);
  });
});

test('proxy ends a text-only cut-short Chat stream with a notice, not a fake silent success', async () => {
  await withProxy(async () => upstreamSse(event({
    id: 'chat-cut',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'partial' } }],
  })), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'beam-free',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /reply was cut short/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /upstream_error/);
  });
});

test('proxy turns an upstream SSE error into a failed non-streaming response', async () => {
  await withProxy(async () => upstreamSse(event({
    error: { message: 'quota exhausted' },
  })), async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'beam-free',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.type, 'upstream_error');
    assert.match(body.error.message, /quota exhausted/);
  });
});
