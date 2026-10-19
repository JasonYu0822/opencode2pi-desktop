'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const zen = require('../lib/zen.js');

test('chat upstream body requests usage and preserves declared host tools', () => {
  const host = {
    model: 'beam-free',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    tools: [{ type: 'function', function: { name: 'Bash', description: 'host', parameters: { type: 'object' } } }],
  };
  const declared = zen.declaredToolNames(host, 'chat');
  assert.deepEqual([...declared], ['Bash']);
  const body = zen.buildUpstreamBody(host);
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.ok(body.tools.some((tool) => tool.function?.name === 'shell'));
  assert.ok(body.tools.some((tool) => tool.function?.name === 'Bash'));
});

test('protocol parsing follows the documentation table', () => {
  const docs = [
    '| Beam Free | beam-free | `https://opencode.ai/inference/openai/v1/chat/completions` | `@ai-sdk/openai-compatible` |',
    '| Muse | muse-spark-1.3 | `https://opencode.ai/inference/openai/v1/responses` | `@ai-sdk/openai` |',
    '| Claude | claude-opus-5 | `https://opencode.ai/inference/anthropic/v1/messages` | `@ai-sdk/anthropic` |',
    '| Jev | jev-1.13-free | `https://opencode.ai/inference/systemone/v1/systemone` | - |',
  ].join('\n');
  assert.deepEqual(zen.parseProtocolDocs(docs), {
    'beam-free': 'chat',
    'muse-spark-1.3': 'responses',
    'claude-opus-5': 'anthropic',
    'jev-1.13-free': 'systemone',
  });
});

test('catalog protocols override prefix guesses and unsupported lanes stay out', () => {
  const protocols = new Map([
    ['future-chat-free', 'chat'],
    ['future-responses-free', 'responses'],
    ['future-system-free', 'systemone'],
  ]);
  assert.equal(zen.modelProtocol('future-chat-free', protocols), 'chat');
  assert.equal(zen.modelProtocol('future-responses-free', protocols), 'responses');
  assert.equal(zen.modelProtocol('future-system-free', protocols), 'systemone');
  assert.equal(zen.modelProtocol('muse-spark-unknown', protocols), 'responses');
});

test('provider declarations split only on the discovered wire protocol', () => {
  const catalog = {
    list: () => ['chat-model', 'response-model', 'system-model'],
    protocol: (id) => ({
      'chat-model': 'chat',
      'response-model': 'responses',
      'system-model': 'systemone',
    })[id],
    metadata: () => undefined,
    reasoningCapability: () => undefined,
  };
  assert.deepEqual(zen.catalogModelEntries(catalog).map((entry) => entry.id), ['chat-model']);
  assert.deepEqual(zen.responsesModelEntries(catalog).map((entry) => entry.id), ['response-model']);
});
