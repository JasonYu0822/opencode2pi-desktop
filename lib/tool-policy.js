'use strict';

const MAX_PENDING_TOOL_BYTES = 32 * 1024 * 1024;
const SEPARATORS = /[\s_.-]/g;
const CALL_FINISH_REASONS = new Set(['tool_calls', 'function_call']);

class ToolPolicyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ToolPolicyError';
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function index(value, label = 'stream item') {
  const result = value ?? 0;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ToolPolicyError(`Invalid ${label} index`);
  }
  return result;
}

function toolName(tool, dialect) {
  if (!object(tool)) return undefined;
  return dialect === 'responses' ? tool.name : tool.function?.name;
}

function declaredToolNames(body, dialect) {
  const names = new Set();
  if (!object(body)) return names;
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = toolName(tool, dialect);
    if (typeof name === 'string' && name) names.add(name);
  }
  if (dialect === 'chat' && Array.isArray(body.functions)) {
    for (const tool of body.functions) {
      if (typeof tool?.name === 'string' && tool.name) names.add(tool.name);
    }
  }
  return names;
}

const GATE_ALIASES = new Map([
  ['shell', ['Bash', 'bash']],
  ['bash', ['Bash', 'shell']],
  ['read', ['Read']],
  ['edit', ['Edit']],
  ['glob', ['Glob']],
  ['grep', ['Grep']],
  ['todowrite', ['todo_write', 'TodoWrite']],
  ['todoread', ['todo_read', 'TodoRead']],
  ['webfetch', ['web_fetch', 'WebFetch']],
]);

function folded(declared, key) {
  const result = new Map();
  for (const name of declared) {
    const value = key(name);
    if (!value) continue;
    result.set(value, result.has(value) ? null : name);
  }
  return result;
}

function uniqueName(candidates) {
  const found = [...new Set(candidates)].filter(Boolean);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Map only unambiguous names. A genuinely unknown tool keeps the model's
 * spelling so the host can return its normal unknown-tool error.
 */
function nameGuard(declared) {
  const names = declared instanceof Set ? declared : new Set(declared || []);
  const lower = (value) => value.toLowerCase();
  const bare = (value) => value.toLowerCase().replace(SEPARATORS, '');
  const byCase = folded(names, lower);
  const byShape = folded(names, bare);

  return (name) => {
    if (typeof name !== 'string' || !name) return null;
    if (names.has(name)) return name;

    const caseKey = lower(name);
    const caseMatch = byCase.get(caseKey);
    if (caseMatch) return caseMatch;
    if (byCase.has(caseKey)) return name;

    const shapeKey = bare(name);
    const shapeMatch = byShape.get(shapeKey);
    if (shapeMatch) return shapeMatch;

    const aliases = GATE_ALIASES.get(caseKey);
    if (aliases) {
      const alias = uniqueName(aliases.filter((candidate) => names.has(candidate)));
      if (alias) return alias;
    }
    if (byShape.has(shapeKey)) return name;
    return name;
  };
}

function droppedNote(name) {
  return typeof name === 'string' && name
    ? `(The model called a tool this agent doesn't have: ${JSON.stringify(name.slice(0, 128))}. The call was left out.)`
    : '(The model called a tool without a name. The call was left out.)';
}

function appendNote(message, note) {
  if (typeof message.content === 'string' && message.content) {
    message.content = `${message.content}\n\n${note}`;
  } else if (Array.isArray(message.content)) {
    message.content.push({ type: 'text', text: note });
  } else {
    message.content = note;
  }
}

function mapChatMessage(message, checkName) {
  const result = { changed: false, notes: [] };
  if (!object(message)) return result;

  if (message.function_call != null) {
    if (!object(message.function_call)) {
      throw new ToolPolicyError('Invalid upstream function call');
    }
    const name = checkName(message.function_call.name);
    if (name == null) {
      result.notes.push(droppedNote(message.function_call.name));
      delete message.function_call;
      result.changed = true;
    } else if (name !== message.function_call.name) {
      message.function_call.name = name;
      result.changed = true;
    }
  }

  if (message.tool_calls != null) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ToolPolicyError('Invalid upstream tool call list');
    }
    const kept = [];
    for (const call of message.tool_calls) {
      if (!object(call) || (call.type != null && call.type !== 'function') || !object(call.function)) {
        throw new ToolPolicyError('Unsupported upstream tool call');
      }
      const name = checkName(call.function.name);
      if (name == null) {
        result.notes.push(droppedNote(call.function.name));
        result.changed = true;
        continue;
      }
      if (name !== call.function.name) {
        call.function.name = name;
        result.changed = true;
      }
      kept.push(call);
    }
    if (kept.length !== message.tool_calls.length) {
      if (kept.length) message.tool_calls = kept;
      else delete message.tool_calls;
    }
  }
  return result;
}

function guardChatCompletion(body, checkName) {
  let changed = false;
  if (!object(body) || !Array.isArray(body.choices)) return false;
  for (const choice of body.choices) {
    if (!object(choice) || !object(choice.message)) {
      throw new ToolPolicyError('Invalid upstream chat choice');
    }
    const checked = mapChatMessage(choice.message, checkName);
    changed = checked.changed || changed;
    if (checked.notes.length) {
      for (const note of checked.notes) appendNote(choice.message, note);
      const hasCalls = choice.message.function_call != null
        || (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0);
      if (!hasCalls && CALL_FINISH_REASONS.has(choice.finish_reason)) {
        choice.finish_reason = 'stop';
        changed = true;
      }
    }
  }
  return changed;
}

function replaceDroppedCall(call, note) {
  return {
    type: 'message',
    id: typeof call.id === 'string' && call.id ? call.id : `msg_${call.call_id ?? 'dropped'}`,
    role: 'assistant',
    status: call.status ?? 'completed',
    content: [{ type: 'output_text', text: note, annotations: [] }],
  };
}

function guardResponsesResponse(value, checkName) {
  let changed = false;
  const stack = [[value, null, null]];
  while (stack.length) {
    const [node, holder, key] = stack.pop();
    if (!object(node)) continue;

    if (node.type === 'function_call') {
      const name = checkName(node.name);
      if (name == null) {
        if (!holder) throw new ToolPolicyError(droppedNote(node.name));
        holder[key] = replaceDroppedCall(node, droppedNote(node.name));
        changed = true;
        continue;
      }
      if (name !== node.name) {
        node.name = name;
        changed = true;
      }
    }

    for (const name of ['output', 'content']) {
      if (!Array.isArray(node[name])) continue;
      for (let i = 0; i < node[name].length; i += 1) {
        stack.push([node[name][i], node[name], i]);
      }
    }
    for (const name of ['response', 'item', 'part', 'message']) {
      if (node[name] != null) stack.push([node[name], node, name]);
    }
  }
  return changed;
}

function appendFunction(target, fragment) {
  if (!object(fragment)) throw new ToolPolicyError('Invalid upstream function delta');
  for (const [key, value] of Object.entries(fragment)) {
    if (key === 'name' || key === 'arguments') {
      if (typeof value !== 'string') throw new ToolPolicyError('Invalid upstream function delta');
      target[key] = (target[key] ?? '') + value;
    } else {
      target[key] = value;
    }
  }
}

function metadataFor(data) {
  const metadata = {};
  for (const key of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (data[key] !== undefined) metadata[key] = data[key];
  }
  return metadata;
}

function createChatStreamGuard(checkName, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_PENDING_TOOL_BYTES;
  const pending = new Map();
  const wrote = new Set();
  const open = new Set();
  const finished = new Set();
  let bytes = 0;
  let said = false;
  let metadata = {};
  let ended = false;

  function charge(state, value) {
    const size = Buffer.byteLength(JSON.stringify(value));
    bytes += size;
    state.bytes += size;
    if (bytes > maxBytes) {
      throw new ToolPolicyError('Pending upstream tool calls exceed the buffer limit');
    }
  }

  function stateFor(position, data) {
    let state = pending.get(position);
    if (!state) {
      metadata = { ...metadata, ...metadataFor(data) };
      state = { calls: new Map(), legacy: null, bytes: 0 };
      pending.set(position, state);
      charge(state, metadataFor(data));
    }
    return state;
  }

  function complete(state, position) {
    const delta = {};
    if (state.calls.size) {
      delta.tool_calls = [...state.calls]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
    }
    if (state.legacy) delta.function_call = state.legacy;

    const notes = [];
    if (delta.function_call) {
      const name = checkName(delta.function_call.name);
      if (name == null) {
        notes.push(droppedNote(delta.function_call.name));
        delete delta.function_call;
      } else {
        delta.function_call.name = name;
      }
    }
    if (delta.tool_calls) {
      const kept = [];
      for (const call of delta.tool_calls) {
        const name = checkName(call.function?.name);
        if (name == null) {
          notes.push(droppedNote(call.function?.name));
          continue;
        }
        call.function.name = name;
        kept.push(call);
      }
      if (kept.length) {
        kept.forEach((call, toolIndex) => {
          call.index = toolIndex;
        });
        delta.tool_calls = kept;
      } else {
        delete delta.tool_calls;
      }
    }
    if (notes.length) {
      delta.content = (wrote.has(position) ? '\n\n' : '') + notes.join('\n\n');
    }
    return delta;
  }

  function remove(position) {
    const state = pending.get(position);
    if (state) bytes -= state.bytes;
    pending.delete(position);
  }

  function apply(data) {
    if (!object(data)) return null;
    metadata = { ...metadata, ...metadataFor(data) };
    const choices = Array.isArray(data.choices) ? data.choices : [];
    let changed = false;

    for (const choice of choices) {
      if (!object(choice)) throw new ToolPolicyError('Invalid upstream chat choice');
      const position = index(choice.index, 'choice');
      const delta = object(choice.delta) ? choice.delta : {};
      if (!finished.has(position)) open.add(position);

      for (const key of ['content', 'reasoning', 'reasoning_content']) {
        if (typeof delta[key] === 'string' && delta[key]) said = true;
      }
      if (typeof delta.content === 'string' && delta.content) wrote.add(position);

      if (delta.tool_calls != null || delta.function_call != null) {
        const state = stateFor(position, data);
        if (delta.tool_calls != null) {
          if (!Array.isArray(delta.tool_calls)) throw new ToolPolicyError('Invalid upstream tool delta list');
          for (const fragment of delta.tool_calls) {
            if (!object(fragment) || (fragment.type != null && fragment.type !== 'function')) {
              throw new ToolPolicyError('Unsupported upstream tool delta');
            }
            charge(state, fragment);
            const toolIndex = index(fragment.index, 'tool');
            const previous = state.calls.get(toolIndex) ?? { index: toolIndex, function: {} };
            const call = { ...previous, ...fragment, index: toolIndex, function: previous.function };
            if (fragment.function != null) appendFunction(call.function, fragment.function);
            state.calls.set(toolIndex, call);
          }
          delete delta.tool_calls;
        }
        if (delta.function_call != null) {
          charge(state, delta.function_call);
          state.legacy ??= { name: '', arguments: '' };
          appendFunction(state.legacy, delta.function_call);
          delete delta.function_call;
        }
        changed = true;
      }

      if (choice.finish_reason != null) {
        finished.add(position);
        open.delete(position);
        const state = pending.get(position);
        if (state) {
          const aggregate = complete(state, position);
          if (aggregate.tool_calls) delta.tool_calls = aggregate.tool_calls;
          if (aggregate.function_call) delta.function_call = aggregate.function_call;
          if (aggregate.content) {
            delta.content = typeof delta.content === 'string' && delta.content
              ? delta.content + aggregate.content
              : aggregate.content;
          }
          remove(position);
          changed = true;
        }
        if (CALL_FINISH_REASONS.has(choice.finish_reason)
          && !delta.function_call
          && !(Array.isArray(delta.tool_calls) && delta.tool_calls.length)) {
          choice.finish_reason = 'stop';
          changed = true;
        }
      }
    }

    if (!changed) return data;
    data.choices = choices.filter((choice) => (
      choice.finish_reason != null
      || Object.keys(choice.delta ?? {}).length > 0
      || Object.keys(choice).some((key) => !['index', 'delta', 'finish_reason'].includes(key))
    ));
    if (data.choices.length === 0 && data.usage == null) return null;
    return data;
  }

  function finish() {
    if (pending.size === 0) return null;
    const choices = [...pending]
      .sort(([a], [b]) => a - b)
      .map(([position, state]) => ({
        index: position,
        delta: complete(state, position),
        finish_reason: null,
      }));
    pending.clear();
    bytes = 0;
    return {
      ...metadata,
      object: 'chat.completion.chunk',
      choices,
    };
  }

  function cutShortEnding() {
    if (ended || !said || pending.size > 0) return null;
    ended = true;
    if (open.size === 0) return null;
    return {
      ...metadata,
      object: 'chat.completion.chunk',
      choices: [...open].sort((a, b) => a - b).map((position) => ({
        index: position,
        delta: {
          content: `${wrote.has(position) ? '\n\n' : ''}(The reply was cut short because the upstream stream ended before completion. Ask again to continue.)`,
        },
        finish_reason: 'stop',
      })),
    };
  }

  return {
    apply,
    cutShortEnding,
    finish,
    get hasPendingTools() {
      return pending.size > 0;
    },
    get hasVisibleOutput() {
      return said;
    },
  };
}

/**
 * Guard Responses events without buffering text or arguments. A dropped call
 * is replaced by a text item at the same output index, and its argument
 * deltas are suppressed so the host never receives a partial tool call.
 */
function createResponsesStreamGuard(checkName) {
  const droppedIndexes = new Set();
  const droppedIDs = new Set();

  function isDropped(data) {
    return (data.output_index != null && droppedIndexes.has(data.output_index))
      || (typeof data.item_id === 'string' && droppedIDs.has(data.item_id));
  }

  function rememberDropped(data, item, replacement) {
    if (data.output_index != null) droppedIndexes.add(data.output_index);
    for (const id of [data.item_id, item.id, replacement.id]) {
      if (typeof id === 'string' && id) droppedIDs.add(id);
    }
  }

  function apply(data, type) {
    if (!object(data)) throw new ToolPolicyError('Invalid upstream Responses event');
    let changed = false;
    let extra = [];

    if (
      (type === 'response.output_item.added' || type === 'response.output_item.done')
      && object(data.item)
      && data.item.type === 'function_call'
    ) {
      if (isDropped(data)) return { data: null, changed: true, extra };
      const name = checkName(data.item.name);
      if (name == null) {
        const note = droppedNote(data.item.name);
        const replacement = replaceDroppedCall(data.item, note);
        rememberDropped(data, data.item, replacement);
        data.item = { ...replacement, status: 'in_progress', content: [] };
        changed = true;
        if (type === 'response.output_item.added') {
          const part = { type: 'output_text', text: '', annotations: [] };
          const where = {
            item_id: replacement.id,
            output_index: data.output_index,
            content_index: 0,
          };
          extra = [
            { type: 'response.content_part.added', ...where, part },
            { type: 'response.output_text.delta', ...where, delta: note },
            { type: 'response.output_text.done', ...where, text: note },
            { type: 'response.content_part.done', ...where, part: { ...part, text: note } },
          ];
        }
      } else if (name !== data.item.name) {
        data.item.name = name;
        changed = true;
      }
    } else if (
      typeof type === 'string'
      && type.startsWith('response.function_call_arguments.')
      && isDropped(data)
    ) {
      return { data: null, changed: true, extra };
    }

    if (
      (type === 'response.completed' || type === 'response.incomplete')
      && object(data.response)
      && guardResponsesResponse(data.response, checkName)
    ) {
      changed = true;
    }
    return { data, changed, extra };
  }

  return { apply };
}

module.exports = {
  ToolPolicyError,
  createChatStreamGuard,
  createResponsesStreamGuard,
  declaredToolNames,
  droppedNote,
  guardChatCompletion,
  guardResponsesResponse,
  nameGuard,
};
