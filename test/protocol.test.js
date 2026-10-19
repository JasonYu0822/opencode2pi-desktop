'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');

const { ProtocolError, collectSse } = require('../lib/protocol.js');

function event(value, name) {
  return `${name ? `event: ${name}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function stream(text, chunkSize = 7) {
  const bytes = Buffer.from(text);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  return Readable.from(chunks);
}

test('Chat aggregation preserves choices, reasoning, tool calls, legacy calls and usage', async () => {
  const text =
    event({
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 123,
      model: 'zen',
      system_fingerprint: 'fp',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: '你',
          reasoning_content: '想',
          tool_calls: [
            { index: 1, id: 'call-b', type: 'function', function: { name: 'second', arguments: '{"b":' } },
            { index: 0, id: 'call-a', type: 'function', function: { name: 'first', arguments: '{"a":' } },
          ],
        },
      }],
    }) +
    event({
      choices: [
        { index: 1, delta: { content: 'other' }, finish_reason: 'stop' },
        {
          index: 0,
          delta: {
            content: '好',
            reasoning_content: '法',
            function_call: { name: 'legacy', arguments: '{"x":' },
            tool_calls: [
              { index: 0, function: { arguments: '1}' } },
              { index: 1, function: { arguments: '2}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }) +
    event({
      choices: [{
        index: 0,
        delta: { function_call: { arguments: '1}' } },
      }],
    }) +
    event({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
    }) +
    event('[DONE]');

  const body = await collectSse(stream(text), 'chat');
  assert.equal(body.id, 'chat-1');
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.created, 123);
  assert.equal(body.model, 'zen');
  assert.equal(body.system_fingerprint, 'fp');
  assert.equal(body.choices[0].message.content, '你好');
  assert.equal(body.choices[0].message.reasoning_content, '想法');
  assert.deepEqual(body.choices[0].message.tool_calls, [
    { id: 'call-a', type: 'function', function: { name: 'first', arguments: '{"a":1}' } },
    { id: 'call-b', type: 'function', function: { name: 'second', arguments: '{"b":2}' } },
  ]);
  assert.deepEqual(body.choices[0].message.function_call, { name: 'legacy', arguments: '{"x":1}' });
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[1].message.content, 'other');
  assert.equal(body.choices[1].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 });
});

test('Responses aggregation keeps text, reasoning and function calls without a final snapshot', async () => {
  const text = [
    {
      type: 'response.created',
      response: { id: 'resp-1', object: 'response', model: 'zen', status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg-1', type: 'message', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'reason-1', type: 'reasoning', summary: [] },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 1,
      summary_index: 0,
      delta: 'think',
    },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { id: 'call-1', type: 'function_call', call_id: 'call', name: 'read', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a"}' },
    { type: 'response.completed', usage: { input_tokens: 2, output_tokens: 4, total_tokens: 6 } },
  ].map((value) => event(value)).join('');

  const body = await collectSse(stream(text), 'responses');
  assert.equal(body.id, 'resp-1');
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].content[0].text, 'hello');
  assert.equal(body.output[1].summary[0].text, 'think');
  assert.equal(body.output[2].arguments, '{"path":"a"}');
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 4, total_tokens: 6 });
});

test('authoritative final Responses output is retained', async () => {
  const final = {
    id: 'resp-final',
    object: 'response',
    status: 'completed',
    model: 'zen',
    output: [{
      type: 'function_call',
      id: 'call-1',
      call_id: 'call',
      name: 'read',
      arguments: '{"path":"a"}',
    }],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
  };
  const body = await collectSse(stream(event({ type: 'response.completed', response: final })), 'responses');
  assert.deepEqual(body, final);
});

test('error events and truncation never become successful replies', async () => {
  await assert.rejects(
    collectSse(stream(event({ error: { message: 'quota exhausted' } })), 'chat'),
    (error) => error instanceof ProtocolError && /quota exhausted/.test(error.message),
  );
  await assert.rejects(
    collectSse(stream(event({ choices: [{ index: 0, delta: { content: 'partial' } }] })), 'chat'),
    (error) => error instanceof ProtocolError && /completion marker/.test(error.message),
  );
  await assert.rejects(
    collectSse(stream(event({ type: 'response.failed', response: { error: { message: 'boom' } } })), 'responses'),
    (error) => error instanceof ProtocolError && /boom/.test(error.message),
  );
});

test('literal completion-looking text inside content does not count as a terminal frame', async () => {
  await assert.rejects(
    collectSse(stream(event({
      choices: [{ index: 0, delta: { content: '[DONE] "finish_reason":"stop"' } }],
    })), 'chat'),
    ProtocolError,
  );
});
