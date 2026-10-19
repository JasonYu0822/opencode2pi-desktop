'use strict';

const { framesFrom } = require('./sse.js');
const { guardChatCompletion, guardResponsesResponse } = require('./tool-policy.js');

class ProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function position(value, label = 'stream item') {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ProtocolError(`Invalid ${label} index`);
  }
  return result;
}

function sorted(map) {
  return [...map].sort(([a], [b]) => a - b).map(([, value]) => value);
}

function appendFunction(target, fragment) {
  if (!object(fragment)) throw new ProtocolError('Invalid upstream function delta');
  for (const key of ['name', 'arguments']) {
    if (typeof fragment[key] === 'string') {
      target[key] = (target[key] ?? '') + fragment[key];
    }
  }
}

function createChatAccumulator(options = {}) {
  const checkName = options.checkName;
  const body = { object: 'chat.completion', choices: [] };
  const choices = new Map();
  const tools = new Map();

  function apply(data) {
    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
      if (data[key] !== undefined) body[key] = data[key];
    }
    if (object(data.usage)) body.usage = { ...body.usage, ...data.usage };

    for (const part of Array.isArray(data.choices) ? data.choices : []) {
      if (!object(part)) throw new ProtocolError('Invalid upstream chat choice');
      const choiceIndex = position(part.index, 'choice');
      if (!choices.has(choiceIndex)) {
        choices.set(choiceIndex, {
          index: choiceIndex,
          message: { role: 'assistant', content: null },
          finish_reason: null,
        });
        tools.set(choiceIndex, new Map());
      }
      const choice = choices.get(choiceIndex);
      const message = choice.message;
      const delta = object(part.delta) ? part.delta : {};

      if (typeof delta.role === 'string' && delta.role) message.role = delta.role;
      for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
        if (typeof delta[key] === 'string') message[key] = (message[key] ?? '') + delta[key];
      }
      if (delta.function_call != null) {
        message.function_call ??= { name: '', arguments: '' };
        appendFunction(message.function_call, delta.function_call);
      }
      for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!object(fragment)) throw new ProtocolError('Invalid upstream tool call');
        const toolIndex = position(fragment.index, 'tool');
        const calls = tools.get(choiceIndex);
        if (!calls.has(toolIndex)) {
          calls.set(toolIndex, { type: 'function', function: { name: '', arguments: '' } });
        }
        const call = calls.get(toolIndex);
        for (const key of ['id', 'type']) {
          if (fragment[key] !== undefined) call[key] = fragment[key];
        }
        if (fragment.function != null) appendFunction(call.function, fragment.function);
      }

      if (part.message != null && object(part.message)) {
        const snapshot = part.message;
        if (typeof snapshot.role === 'string' && snapshot.role) message.role = snapshot.role;
        for (const key of ['content', 'reasoning_content', 'reasoning', 'refusal']) {
          if (typeof snapshot[key] === 'string') message[key] = snapshot[key];
        }
        if (object(snapshot.function_call)) message.function_call = { ...snapshot.function_call };
        if (Array.isArray(snapshot.tool_calls)) {
          const calls = tools.get(choiceIndex);
          for (const [toolIndex, call] of snapshot.tool_calls.entries()) {
            calls.set(toolIndex, call);
          }
        }
      }

      if (part.finish_reason != null) choice.finish_reason = part.finish_reason;
      if (object(part.logprobs)) {
        choice.logprobs ??= {};
        for (const [key, value] of Object.entries(part.logprobs)) {
          if (Array.isArray(value)) {
            choice.logprobs[key] = [...(choice.logprobs[key] ?? []), ...value];
          } else {
            choice.logprobs[key] = value;
          }
        }
      }
    }
  }

  function finish() {
    for (const [choiceIndex, choice] of choices) {
      const calls = tools.get(choiceIndex);
      if (calls.size) choice.message.tool_calls = sorted(calls);
    }
    body.choices = sorted(choices);
    body.id ??= 'chatcmpl-proxy';
    body.created ??= Math.floor(Date.now() / 1000);
    if (checkName) guardChatCompletion(body, checkName);
    return body;
  }

  return { apply, finish };
}

function createResponsesAccumulator(options = {}) {
  const checkName = options.checkName;
  let body = { object: 'response', output: [] };
  let final;
  const output = new Map();

  function item(data, type = 'message') {
    let outputIndex = data.output_index;
    if (outputIndex === undefined && data.item_id) {
      outputIndex = [...output].find(([, value]) => value.id === data.item_id)?.[0];
    }
    outputIndex = position(outputIndex);
    if (!output.has(outputIndex)) {
      const value = { type };
      if (data.item_id) value.id = data.item_id;
      if (type === 'message') Object.assign(value, { role: 'assistant', content: [] });
      if (type === 'function_call') value.arguments = '';
      if (type === 'reasoning') value.summary = [];
      output.set(outputIndex, value);
    }
    return output.get(outputIndex);
  }

  function apply(data, type) {
    if (type === 'response.created' || type === 'response.in_progress') {
      if (object(data.response)) {
        body = { ...body, ...data.response };
        for (const [outputIndex, value] of (data.response.output ?? []).entries()) {
          output.set(outputIndex, value);
        }
      }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (object(data.item)) output.set(position(data.output_index), data.item);
    } else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
      const value = item(data);
      value.content ??= [];
      value.content[position(data.content_index, 'content')] = data.part;
    } else if (
      type === 'response.output_text.delta'
      || type === 'response.output_text.done'
      || type === 'response.refusal.delta'
      || type === 'response.refusal.done'
    ) {
      const value = item(data);
      value.content ??= [];
      const refusal = type.startsWith('response.refusal.');
      const field = refusal ? 'refusal' : 'text';
      const part = (value.content[position(data.content_index, 'content')] ??= refusal
        ? { type: 'refusal', refusal: '' }
        : { type: 'output_text', text: '', annotations: [] });
      if (type.endsWith('.delta')) {
        part[field] = (part[field] ?? '') + (data.delta ?? '');
      } else if (data[field] !== undefined) {
        part[field] = data[field];
      }
    } else if (
      type === 'response.function_call_arguments.delta'
      || type === 'response.function_call_arguments.done'
    ) {
      const value = item(data, 'function_call');
      if (type.endsWith('.delta')) {
        value.arguments = (value.arguments ?? '') + (data.delta ?? '');
      } else if (data.arguments !== undefined) {
        value.arguments = data.arguments;
      }
    } else if (
      type === 'response.reasoning_summary_part.added'
      || type === 'response.reasoning_summary_part.done'
    ) {
      const value = item(data, 'reasoning');
      value.summary ??= [];
      value.summary[position(data.summary_index, 'summary')] = data.part;
    } else if (/^response\.reasoning_(summary_)?text\.(delta|done)$/.test(type)) {
      const value = item(data, 'reasoning');
      const summary = type.includes('summary');
      const field = summary ? 'summary' : 'content';
      value[field] ??= [];
      const partIndex = position(summary ? data.summary_index : data.content_index);
      const part = (value[field][partIndex] ??= {
        type: summary ? 'summary_text' : 'reasoning_text',
        text: '',
      });
      if (type.endsWith('.delta')) part.text += data.delta ?? '';
      else if (data.text !== undefined) part.text = data.text;
    } else if (type === 'response.reasoning_content.delta') {
      body.reasoning_content = (body.reasoning_content ?? '') + (data.delta ?? '');
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      if (object(data.response)) final = data.response;
      body.status = type === 'response.completed' ? 'completed' : 'incomplete';
      for (const key of ['incomplete_details', 'finish_reason']) {
        if (data[key] !== undefined) body[key] = data[key];
      }
    }
    if (object(data.usage)) body.usage = { ...body.usage, ...data.usage };
  }

  function finish(defaultModel) {
    if (final) {
      if (checkName) guardResponsesResponse(final, checkName);
      return final;
    }
    body.output = sorted(output);
    body.id ??= `resp_proxy_${Math.floor(Date.now() / 1000)}`;
    body.created_at ??= Math.floor(Date.now() / 1000);
    if (body.model === undefined && defaultModel) body.model = defaultModel;
    if (checkName) guardResponsesResponse(body, checkName);
    return body;
  }

  return { apply, finish };
}

function errorMessage(value, fallback = 'Upstream stream failed') {
  if (typeof value === 'string' && value) return value;
  return value?.message || value?.error?.message || value?.response?.error?.message || fallback;
}

function terminalFor(type, protocol) {
  if (protocol === 'responses') {
    if (type === 'response.completed') return 'completed';
    if (type === 'response.incomplete') return 'incomplete';
  }
  return null;
}

function analyzeFrame(frame, protocol) {
  const text = frame.text.trim();
  if (!text) return { kind: 'empty' };
  if (frame.name === 'error') {
    let value = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* An SSE error event may contain plain text. */
    }
    throw new ProtocolError(errorMessage(value));
  }
  if (text === '[DONE]') {
    if (protocol !== 'chat') throw new ProtocolError('Unexpected upstream completion marker');
    return { kind: 'done' };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ProtocolError('Invalid JSON in upstream SSE event', { cause: error });
  }
  if (!object(data)) throw new ProtocolError('Invalid JSON object in upstream SSE event');

  const type = typeof data.type === 'string' ? data.type : frame.name;
  if (
    data.error
    || type === 'error'
    || type === 'response.failed'
    || data.response?.status === 'failed'
  ) {
    throw new ProtocolError(errorMessage(data.error ?? data.response?.error ?? data));
  }
  return {
    kind: 'event',
    data,
    type,
    terminal: terminalFor(type, protocol),
  };
}

async function collectSse(source, protocol, options = {}) {
  if (!['chat', 'responses'].includes(protocol)) {
    throw new TypeError(`Unsupported protocol: ${protocol}`);
  }
  const checkName = options.checkName;
  const accumulator = protocol === 'chat'
    ? createChatAccumulator({ checkName })
    : createResponsesAccumulator({ checkName });
  let terminal = null;

  for await (const frame of framesFrom(source, {
    maxEventBytes: options.maxEventBytes,
    maxTotalBytes: options.maxTotalBytes,
    readTimeoutMs: options.readTimeoutMs,
  })) {
    const event = analyzeFrame(frame, protocol);
    if (event.kind === 'empty') continue;
    if (event.kind === 'done') {
      terminal = 'done';
      break;
    }
    accumulator.apply(event.data, event.type);
    if (event.terminal) {
      terminal = event.terminal;
      break;
    }
  }

  if (!terminal) {
    throw new ProtocolError('Upstream SSE ended without a completion marker');
  }
  return protocol === 'responses'
    ? accumulator.finish(options.defaultModel)
    : accumulator.finish();
}

module.exports = {
  ProtocolError,
  analyzeFrame,
  collectSse,
  createChatAccumulator,
  createResponsesAccumulator,
  errorMessage,
};
