'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createChatStreamGuard,
  createResponsesStreamGuard,
  declaredToolNames,
  guardChatCompletion,
  guardResponsesResponse,
  nameGuard,
} = require('../lib/tool-policy.js');

test('declaredToolNames reads nested Chat tools and legacy functions only', () => {
  const names = declaredToolNames({
    tools: [{ type: 'function', function: { name: 'Read' } }, { type: 'function', function: { name: 'todo_write' } }],
    functions: [{ name: 'legacy' }],
  }, 'chat');
  assert.deepEqual([...names].sort(), ['Read', 'legacy', 'todo_write']);
});

test('nameGuard maps unique case, separator and gate aliases without guessing', () => {
  const check = nameGuard(new Set(['Bash', 'Read', 'todo_write', 'todo-write', 'unknown']));
  assert.equal(check('bash'), 'Bash');
  assert.equal(check('shell'), 'Bash');
  assert.equal(check('read'), 'Read');
  assert.equal(check('todowrite'), 'todo_write');
  assert.equal(check('todoWrite'), 'todo_write');
  assert.equal(check('something_else'), 'something_else');
});

test('non-streaming guards rename tool calls and preserve unknown names', () => {
  const chat = {
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'mystery', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
  };
  guardChatCompletion(chat, nameGuard(new Set(['Read'])));
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'Read');
  assert.equal(chat.choices[0].message.tool_calls[1].function.name, 'mystery');

  const responses = {
    id: 'resp',
    object: 'response',
    status: 'completed',
    output: [
      { type: 'function_call', name: 'shell', arguments: '{}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ],
  };
  guardResponsesResponse(responses, nameGuard(new Set(['Bash'])));
  assert.equal(responses.output[0].name, 'Bash');
});

test('chat stream guard buffers split tool calls and rewrites the finishing frame', () => {
  const guard = createChatStreamGuard(nameGuard(new Set(['Bash', 'Read'])));
  const first = {
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'zen',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'sh', arguments: '{"cmd":' } }] },
    }],
  };
  assert.equal(guard.apply(first), null);

  const second = {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { name: 'ell', arguments: '"pwd"}' } }] },
      finish_reason: 'tool_calls',
    }],
  };
  const out = guard.apply(second);
  assert.equal(out.choices[0].delta.tool_calls[0].function.name, 'Bash');
  assert.equal(out.choices[0].delta.tool_calls[0].function.arguments, '{"cmd":"pwd"}');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(guard.hasPendingTools, false);
});

test('chat stream guard can end a text-only cut-short stream cleanly', () => {
  const guard = createChatStreamGuard(nameGuard(new Set(['Read'])));
  const data = {
    id: 'chat-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'zen',
    choices: [{ index: 0, delta: { content: 'partial' } }],
  };
  assert.equal(guard.apply(data), data);
  assert.equal(guard.hasVisibleOutput, true);
  const ending = guard.cutShortEnding();
  assert.match(ending.choices[0].delta.content, /cut short/);
  assert.equal(ending.choices[0].finish_reason, 'stop');
  assert.equal(guard.cutShortEnding(), null);
});

test('chat stream guard flushes a pending call when the terminal marker arrives', () => {
  const guard = createChatStreamGuard(nameGuard(new Set(['Bash'])));
  guard.apply({
    id: 'chat-1',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'Ba', arguments: '{"cmd":' } }] },
    }],
  });
  guard.apply({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { name: 'sh', arguments: '"pwd"}' } }] },
    }],
  });
  const tail = guard.finish();
  assert.equal(tail.choices[0].delta.tool_calls[0].function.name, 'Bash');
  assert.equal(tail.choices[0].delta.tool_calls[0].function.arguments, '{"cmd":"pwd"}');
  assert.equal(guard.hasPendingTools, false);
});

test('Responses stream guard renames calls and replaces an unnamed call in place', () => {
  const guard = createResponsesStreamGuard(nameGuard(new Set(['Read'])));
  const renamed = guard.apply({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', id: 'call-a', name: 'read', arguments: '' },
  }, 'response.output_item.added');
  assert.equal(renamed.changed, true);
  assert.equal(renamed.data.item.name, 'Read');

  const dropped = guard.apply({
    type: 'response.output_item.added',
    output_index: 1,
    item: { type: 'function_call', id: 'call-b', name: '', arguments: '' },
  }, 'response.output_item.added');
  assert.equal(dropped.changed, true);
  assert.equal(dropped.data.item.type, 'message');
  assert.equal(dropped.extra.length, 4);
  assert.equal(
    guard.apply({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      delta: '{"path":',
    }, 'response.function_call_arguments.delta').data,
    null,
  );
});
