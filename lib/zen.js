/**
 * OpenCode Zen anonymous free lane core for PI-Desktop.
 *
 * Core port of https://github.com/FishBottle7/opencode2dsh (MIT, © FishBottle7),
 * which itself derives the disguise details from jasonxu114514/opencode2api.
 * Ported pieces: adapter/ids.ts (correlation ids + headers), adapter/catalog.ts
 * (S1/S2/S3 fallback chain) and adapter/messages.ts (free-lane body gate).
 *
 * Architecture (v0.4, following eric8bit/pi-commandcode-desktop):
 *
 * PI-Desktop cannot register a provider at runtime — the host reads
 * `contributes.providers` from the manifest BEFORE it spawns the plugin
 * process, and the model picker only enumerates that host provider list.
 * So this plugin declares its provider statically in the manifest (permission
 * `provider.register`) and points it at a loopback HTTP endpoint (permission
 * `background.service`) served by main.js. This module owns everything that
 * goes on the wire to Zen: the CLI disguise header set, the canonical ses_
 * session shape, the free-lane body gate, reasoning_effort normalization and
 * the S1∩S2 free-model catalog used to rewrite the manifest's model list.
 *
 * Not ported on purpose: the IP pool / proxy rotation subsystem (quota
 * evasion) and the legacy Go sidecar. The on-disk catalog cache IS ported:
 * ModelCatalog seeds S1 (Zen ids) + S2 (models.dev prices) from
 * `catalog-cache.json` in the host data dir (`pi.plugin.getDataPath()`,
 * package dir as fallback) before the first network call, so an
 * offline start keeps the real model list (and its metadata) instead of
 * collapsing to the static bootstrap and rewriting the manifest down.
 */

'use strict';

const fs = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');

const ZEN_BASE_URL = 'https://opencode.ai/zen';
const METADATA_URL = 'https://models.dev/api.json';
const CATALOG_TIMEOUT_MS = 30_000;
/** On-disk catalog cache: live data older than this is ignored on seed. */
const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ANONYMOUS_KEY = 'public';

// ---------------------------------------------------------------------------
// Provider identity (mirrored into manifest.json contributes.providers)
// ---------------------------------------------------------------------------

const PROVIDER_ID = 'opencode-free';
const PROVIDER_NAME = 'OpenCode免费模型';
const PROVIDER_VENDOR_KEY = 'opencode';
const PROVIDER_API_STYLE = 'chat_completions';

/**
 * S3: ids verified against the anonymous lane (live Zen catalog + models.dev,
 * refreshed 2026-09). Sorted (byte order) so a static fallback declaration is
 * identical to the manifest on disk — an offline start then rewrites nothing.
 * `jev-*` is deliberately absent: it is free, but only answerable on the
 * dedicated /systemone lane, which this plugin does not declare.
 */
const staticFreeModels = [
  'big-pickle',
  'ling-3.0-flash-fin-free',
  'longcat-2.5-preview-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'space-bunny-free',
];

/**
 * First-load bootstrap: the real free catalog as it stands (models.dev limits,
 * input modalities and reasoning effort ladders, fetched 2026-09), so the
 * manifest is valid before any network call — and so an offline start with an
 * empty cache produces exactly the declaration already on disk (no rewrite,
 * no development-plugin watcher reload).
 *
 * Two lanes, mirroring commandcode's one-wire-protocol-per-provider rule:
 * chat models speak chat_completions; muse-spark-* answers ONLY on Zen's
 * /v1/responses (OpenAI Responses wire), so it gets its own provider
 * declaration pointing at the same loopback endpoint.
 */
const CHAT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const SPACE_BUNNY_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MUSE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

const BOOTSTRAP_MODELS = [
  { id: 'big-pickle', contextWindow: 200000, maxTokens: 32000, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'ling-3.0-flash-fin-free', contextWindow: 262144, maxTokens: 32768, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'longcat-2.5-preview-free', contextWindow: 1000000, maxTokens: 131072, supportsImages: true, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'mimo-v2.5-free', contextWindow: 200000, maxTokens: 32000, supportsImages: true, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'mimo-v2.6-flash-free', contextWindow: 200000, maxTokens: 32000, supportsImages: true, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'nemotron-3-ultra-free', contextWindow: 1000000, maxTokens: 128000, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'nemotron-3.5-lightning-free', contextWindow: 262144, maxTokens: 262144, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'space-bunny-free', contextWindow: 1048576, maxTokens: 524288, supportsImages: true, thinkingLevels: SPACE_BUNNY_THINKING_LEVELS },
];

const BOOTSTRAP_RESPONSES_MODELS = [
  { id: 'muse-spark-1.2-contributor-free', contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: MUSE_THINKING_LEVELS },
  { id: 'muse-spark-1.3-contributor-free', contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: MUSE_THINKING_LEVELS },
];

// ---------------------------------------------------------------------------
// Correlation ids + disguise headers (port of adapter/ids.ts)
// ---------------------------------------------------------------------------

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Fixed(value, width) {
  const base = 62n;
  let n = value;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base));
    n /= base;
  }
  return out.join('');
}

/** sha256("prefix\0value") truncated to 12 bytes — stable, non-reversible. */
function stableID(prefix, value) {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest();
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`;
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`;
}

/** The conversation signal: JSON of the first user turn (stable per chat). */
function conversationSeed(messages) {
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue;
    const encoded = JSON.stringify(message.content ?? null);
    if (encoded !== 'null' && encoded.length > 0) return encoded;
  }
  return '';
}

/**
 * Zen's free tier only accepts OpenCode's canonical session shape
 * ("ses_" + 12 hex + 14 base62); anything else deterministically hashes into
 * it, so one conversation keeps one stable upstream session.
 */
function canonicalSessionID(signal) {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
  const sum = createHash('sha256').update('ses\x00' + signal).digest();
  const timePart = sum.subarray(0, 6).toString('hex');
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14);
  return `ses_${timePart}${randomPart}`;
}

function deriveRequestIDs(messages) {
  let signal = conversationSeed(messages);
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16);
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2dsh:default-project'),
  };
}

/** CLI-identical user agent (ids.ts opencodeUserAgent). */
function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}

/** The full disguise header set sent with every upstream request. */
function disguiseHeaders(ids) {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  };
}

// ---------------------------------------------------------------------------
// Free-lane body gate (port of adapter/messages.ts)
// ---------------------------------------------------------------------------

/**
 * Live-probed 2026-09-18: the anonymous lane 403s (FreeTierError) any chat
 * body that does not stream AND carry function tools named "bash" AND "read".
 * Descriptions and parameters go uninspected.
 */
const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'];

function freeLaneGateTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  };
}

/**
 * Append the gate tools an OpenAI-form body is missing. Returns the same
 * object when the gate is already satisfied. When the context carried no
 * tools at all, tool_choice "none" keeps the model from ever calling the
 * injected stubs; client-provided tool choices are preserved untouched.
 */
function ensureFreeLaneShape(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = new Set(tools.map((tool) => (tool && tool.function && tool.function.name) || undefined));
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name));
  if (missing.length === 0) return body;
  const next = { ...body };
  next.tools = [...tools, ...missing.map(freeLaneGateTool)];
  if (tools.length === 0) next.tool_choice = 'none';
  return next;
}

// ---------------------------------------------------------------------------
// Reasoning effort (port of zen-adapter.ts reasoningEffortWire)
// ---------------------------------------------------------------------------

/** Effort ids the Zen gateway accepts on reasoning_effort (off -> "none"). */
const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high'];

function reasoningEffortWire(id) {
  if (id === undefined || id === null || id === '') return undefined;
  if (id === 'none') return 'none';
  if (id === 'off') return 'none';
  return REASONING_EFFORT_LADDER.includes(id) ? id : undefined;
}

/**
 * What the loopback proxy writes into the upstream body.
 *
 * The host owns the reasoning menu (it reads the thinkingLevels this plugin
 * declares per model) and writes reasoning_effort itself. Zen 400s any value
 * outside its ladder, and omits mean "vendor default" (= keep thinking), so:
 *   - a level the ladder accepts is passed through;
 *   - off / missing / anything unrecognized becomes "none" — the only
 *     spelling that stops always-think free models, and a safe default when
 *     the host simply did not express a preference.
 */
function upstreamEffort(hostValue) {
  return reasoningEffortWire(hostValue) ?? 'none';
}

/** UI effort ladder for a model from its models.dev capability. */
function effortsFor(capability) {
  if (!capability || !capability.reasoning) return [];
  const declared = [];
  for (const value of capability.effortValues || []) {
    const level = value === 'none' ? 'off' : value;
    if (REASONING_EFFORT_LADDER.includes(level) && !declared.includes(level)) declared.push(level);
  }
  if (declared.length === 0) return DEFAULT_EFFORT_LADDER.slice();
  return declared.sort((a, b) => REASONING_EFFORT_LADDER.indexOf(a) - REASONING_EFFORT_LADDER.indexOf(b));
}

/**
 * Prepare the host's OpenAI chat body for the anonymous lane: force streaming,
 * normalize reasoning_effort, then apply the bash/read gate. Everything else
 * the host sent (messages, tools, tool_choice, max_tokens, temperature…) is
 * forwarded untouched — the host owns those semantics.
 */
function buildUpstreamBody(hostBody) {
  const source = hostBody && typeof hostBody === 'object' ? hostBody : {};
  const body = { ...source, stream: true };
  body.reasoning_effort = upstreamEffort(source.reasoning_effort);
  return ensureFreeLaneShape(body);
}

// ---------------------------------------------------------------------------
// Model catalog (port of adapter/catalog.ts, memory-only)
// ---------------------------------------------------------------------------

function isFreeModel(model) {
  return String(model).toLowerCase().includes('free');
}

/** metadata-first free decision (catalog.ts decide, deprecation-first). */
function decide(model, prices, ready) {
  const nameFree = isFreeModel(model);
  const fallback = (source) => (nameFree
    ? { allowed: true, source: 'name_free', known: false }
    : { allowed: false, source, known: false });
  if (!ready || prices.size === 0) return fallback('metadata_pending');
  const price = prices.get(model);
  if (!price) return fallback('metadata_model_missing');
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true };
  if (price.input === 0 && price.output === 0) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true };
  }
  if (price.input === undefined || price.output === undefined) {
    return { allowed: false, source: 'metadata_cost_unknown', known: false };
  }
  return { allowed: false, source: 'metadata_paid', known: true };
}

function metadataDeprecated(model) {
  if (model.deprecated === true) return true;
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase();
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true;
  return model.deprecated_at != null || model.retirement_date != null;
}

function decodeEffortValues(raw) {
  if (!Array.isArray(raw)) return { effortValues: [] };
  const values = [];
  for (const option of raw) {
    if (!option || typeof option !== 'object') continue;
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value);
    }
  }
  return { effortValues: values };
}

/** models.dev OpenCode section -> Map(modelId -> metadata). */
function decodeModelsDev(data) {
  const result = new Map();
  if (!data || typeof data !== 'object') return result;
  const providers = data;
  const rank = (key) => {
    const lower = key.toLowerCase();
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
    if (lower.includes('opencode')) return 1;
    return 2;
  };
  const keys = Object.keys(providers).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const key of keys) {
    if (rank(key) > 1) continue;
    const provider = providers[key];
    if (!provider || typeof provider !== 'object') continue;
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim();
      if (!identity.includes('opencode')) continue;
    }
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue;
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey;
      const cost = raw.cost ?? {};
      const limit = raw.limit ?? {};
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        contextWindow: num(limit && limit.context) ?? 262144,
        maxTokens: num(limit && limit.output) ?? 32768,
        modalitiesInput: Array.isArray(raw.modalities && raw.modalities.input)
          ? raw.modalities.input.map(String)
          : [],
        ...decodeEffortValues(raw.reasoning_options),
      });
    }
    if (result.size > 0) return result;
  }
  return result;
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** S1: the live Zen catalog with the CLI disguise headers. */
async function fetchZenModels(fetchImpl, userAgent) {
  const response = await withTimeout(
    fetchImpl(`${ZEN_BASE_URL}/v1/models`, {
      headers: {
        authorization: `Bearer ${ANONYMOUS_KEY}`,
        'user-agent': userAgent,
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }),
    CATALOG_TIMEOUT_MS,
    'models catalog fetch',
  );
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const models = [];
  for (const item of payload && payload.data ? payload.data : []) {
    if (item && typeof item.id === 'string' && item.id.length > 0) models.push(item.id);
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list');
  return models;
}

class ModelCatalog {
  constructor(fetchImpl, onChange, options = {}) {
    this.#fetchImpl = fetchImpl;
    this.#onChange = typeof onChange === 'function' ? onChange : null;
    this.#cachePath = typeof options.cachePath === 'string' && options.cachePath.length > 0
      ? options.cachePath
      : null;
  }

  #fetchImpl = null;
  #onChange = null;
  #cachePath = null;
  /** { updatedAt, fingerprint } of the last cache file we read or wrote. */
  #cacheState = null;
  #cacheSeeded = false;
  /** Time of the last successful live fetch (either source), 0 = never. */
  #liveAt = 0;
  #changeKey = '';
  #zen = new Set();
  #updatedAt = 0;
  #prices = new Map();
  #pricesReady = false;
  #lastError = '';
  #timer = null;
  #stopped = false;
  #refreshing = false;

  /**
   * Seed S1 (Zen ids) and S2 (models.dev prices) from disk BEFORE the first
   * network call. Without this an offline start falls back to the static
   * bootstrap, re-declares a smaller provider and rewrites manifest.json —
   * which the development-plugin watcher turns into a reload, i.e. model list
   * shrinks (and the thinking menus go with it) plus a spurious reload.
   * Runs once; a missing/corrupt/expired cache simply keeps the bootstrap.
   */
  #seedFromCache() {
    if (this.#cacheSeeded) return;
    this.#cacheSeeded = true;
    if (!this.#cachePath) return;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.#cachePath, 'utf8'));
    } catch {
      return; // absent or unreadable cache: the static bootstrap is the fallback
    }
    if (!raw || raw.version !== 1) return;
    if (!Number.isFinite(raw.updatedAt) || Date.now() - raw.updatedAt > CATALOG_CACHE_TTL_MS) return;
    const ids = Array.isArray(raw.zen)
      ? raw.zen.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    const prices = Array.isArray(raw.prices) ? new Map(raw.prices) : new Map();
    if (ids.length === 0 && prices.size === 0) return;
    if (ids.length > 0) {
      this.#zen = new Set(ids);
      this.#updatedAt = raw.updatedAt;
    }
    if (prices.size > 0) {
      this.#prices = prices;
      this.#pricesReady = true;
    }
    this.#cacheState = { updatedAt: raw.updatedAt, fingerprint: this.#cacheFingerprint() };
  }

  #cachePayload() {
    const sortPairs = (pairs) => [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return {
      zen: [...this.#zen].sort(),
      prices: sortPairs(this.#prices.entries()),
    };
  }

  #cacheFingerprint() {
    const payload = this.#cachePayload();
    return JSON.stringify([payload.zen, payload.prices]);
  }

  /**
   * Persist the catalog only when the data really changed. Writing on every
   * 5-minute refresh would make the dev-plugin watcher (manifest/package
   * files) reload the plugin all day for no reason.
   */
  #saveCache() {
    if (!this.#cachePath) return;
    if (this.#zen.size === 0 && this.#prices.size === 0) return;
    const fingerprint = this.#cacheFingerprint();
    if (this.#cacheState && this.#cacheState.fingerprint === fingerprint) return;
    try {
      const payload = { version: 1, updatedAt: Date.now(), ...this.#cachePayload() };
      const temporary = `${this.#cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, this.#cachePath);
      this.#cacheState = { updatedAt: payload.updatedAt, fingerprint };
    } catch {
      // An unwritable cache is not fatal: the live catalog still works.
    }
  }

  async start() {
    this.#stopped = false;
    await this.refreshOnce();
    let attempts = 0;
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (this.#stopped) return;
      await this.refreshOnce();
    }
    if (this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.refreshOnce();
    }, 300_000);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async refreshOnce() {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      // Disk first: an offline start must keep last known state, not collapse.
      this.#seedFromCache();
      await Promise.allSettled([this.#refreshZen(), this.#refreshMetadata()]);
      this.#saveCache();
      // Fire the change hook when the exposed list actually changed, so the
      // owner can re-publish without polling. Fires once per real change;
      // identical refreshes stay silent.
      const key = this.list().join('|');
      if (key !== this.#changeKey) {
        const first = this.#changeKey === '';
        this.#changeKey = key;
        if (!first && this.#onChange) {
          try { this.#onChange(); } catch { /* hook must never break refresh */ }
        }
      }
    } finally {
      this.#refreshing = false;
    }
  }

  async #refreshZen() {
    try {
      const ids = await fetchZenModels(this.#fetchImpl, opencodeUserAgent());
      this.#zen = new Set(ids);
      this.#updatedAt = Date.now();
      this.#liveAt = this.#updatedAt;
      this.#lastError = '';
    } catch (err) {
      this.#lastError = err && err.message ? err.message : String(err);
    }
  }

  async #refreshMetadata() {
    try {
      const response = await withTimeout(
        this.#fetchImpl(METADATA_URL, { headers: { accept: 'application/json' } }),
        CATALOG_TIMEOUT_MS,
        'models.dev fetch',
      );
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const data = await response.json();
      const prices = decodeModelsDev(data);
      if (prices.size === 0) throw new Error('models.dev contains no OpenCode model metadata');
      this.#prices = prices;
      this.#pricesReady = true;
      this.#liveAt = Date.now();
    } catch (err) {
      if (!this.#pricesReady) this.#lastError = err && err.message ? err.message : String(err);
    }
  }

  decision(model) {
    const metadata = decide(model, this.#prices, this.#pricesReady);
    // S3 vouch: compile-time verified ids stay exposed when metadata is
    // pending/missing, and even when stale metadata claims deprecation.
    if (!metadata.allowed && (!metadata.known || metadata.source === 'metadata_deprecated')
      && staticFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false };
    }
    return metadata;
  }

  /** Exposed ids: S1 ∩ allowed, or the verified static list while S1 is pending. */
  list() {
    if (this.#zen.size === 0) return staticFreeModels.slice().sort();
    const out = [];
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model);
    }
    return out.sort();
  }

  reasoningCapability(model) {
    const price = this.#prices.get(model);
    if (!price) return undefined;
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] };
  }

  metadata(model) {
    return this.#prices.get(model);
  }

  snapshot() {
    const age = this.#updatedAt === 0 ? Infinity : Date.now() - this.#updatedAt;
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000;
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      // live = a real fetch succeeded this session; cache/static = seeded only
      source: this.#liveAt !== 0 ? 'live' : this.#updatedAt !== 0 ? 'cache' : 'static',
      total: this.#zen.size,
      exposed: this.list().length,
      lastError: this.#lastError,
    };
  }
}

function createCatalog(fetchImpl, onChange, options) {
  return new ModelCatalog(fetchImpl, onChange, options);
}

// ---------------------------------------------------------------------------
// Provider declaration (manifest contribute)
// ---------------------------------------------------------------------------

/**
 * muse-spark-* answers only on /v1/responses and jev-* on /systemone; a
 * chat_completions provider must not advertise them.
 */
function isChatLaneModel(id) {
  const value = String(id ?? '').toLowerCase();
  return value.length > 0 && !value.startsWith('muse-spark') && !value.startsWith('jev');
}

function modelEntry({ id, contextWindow, maxTokens, supportsImages, thinkingLevels, defaultThinkingLevel }) {
  const entry = {
    id,
    name: id,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : 262144,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 32768,
    supportsImages: supportsImages === true,
  };
  if (Array.isArray(thinkingLevels) && thinkingLevels.length > 0) {
    entry.thinkingLevels = thinkingLevels;
    entry.defaultThinkingLevel = thinkingLevels.includes('medium') ? 'medium' : thinkingLevels[0];
  }
  return entry;
}

/** First-load list: verified static chat models, with real limits. */
function bootstrapModelEntries() {
  return BOOTSTRAP_MODELS.filter((m) => isChatLaneModel(m.id)).map((m) => ({ ...m }));
}

/** First-load Responses-lane list: the verified muse-spark statics. */
function bootstrapResponsesEntries() {
  return BOOTSTRAP_RESPONSES_MODELS.map((m) => ({ ...m }));
}

/**
 * models.dev metadata -> declaration entry fields (image support, levels).
 * When metadata is missing (offline start without a usable cache) the shipped
 * bootstrap entry speaks instead, so the declaration never degrades to bare
 * defaults (262144/32768, no images, no thinking menu) and manifest.json is
 * left alone.
 */
function catalogEntry(id, catalog) {
  const meta = catalog.metadata(id);
  if (!meta) {
    const fallback = [...BOOTSTRAP_MODELS, ...BOOTSTRAP_RESPONSES_MODELS].find((m) => m.id === id);
    if (fallback) return { ...fallback };
    return { id, contextWindow: undefined, maxTokens: undefined, supportsImages: false, thinkingLevels: [] };
  }
  const capability = catalog.reasoningCapability(id);
  return {
    id,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    supportsImages: Array.isArray(meta.modalitiesInput)
      ? meta.modalitiesInput.includes('image')
      : false,
    thinkingLevels: effortsFor(capability),
  };
}

/** Live chat-lane list: limits, image support and levels from models.dev. */
function catalogModelEntries(catalog) {
  const out = [];
  for (const id of catalog.list()) {
    if (!isChatLaneModel(id)) continue;
    out.push(modelEntry(catalogEntry(id, catalog)));
  }
  return out;
}

/** Live Responses-lane list: muse-spark-* only (they answer only on /v1/responses). */
function responsesModelEntries(catalog) {
  const out = [];
  for (const id of catalog.list()) {
    if (!String(id).toLowerCase().startsWith('muse-spark')) continue;
    out.push(modelEntry(catalogEntry(id, catalog)));
  }
  return out;
}

const RESPONSES_PROVIDER_ID = 'opencode-free-responses';
const RESPONSES_PROVIDER_NAME = 'OpenCode免费模型 · Responses';

/**
 * The whole `contributes.providers` value for a given loopback port.
 * PI-Desktop binds exactly one wire protocol per provider, so the catalog
 * splits across two declarations pointing at the SAME loopback endpoint
 * (commandcode's pattern): chat_completions for Zen /v1/chat/completions,
 * responses for muse-spark-* on Zen /v1/responses.
 */
function buildDeclaration(port, entries, responsesEntries) {
  const out = [{
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    vendorKey: PROVIDER_VENDOR_KEY,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiStyle: PROVIDER_API_STYLE,
    authKind: 'none',
    models: entries.map(modelEntry),
  }];
  if (Array.isArray(responsesEntries) && responsesEntries.length > 0) {
    out.push({
      id: RESPONSES_PROVIDER_ID,
      name: RESPONSES_PROVIDER_NAME,
      vendorKey: PROVIDER_VENDOR_KEY,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiStyle: 'responses',
      authKind: 'none',
      models: responsesEntries.map(modelEntry),
    });
  }
  return out;
}

/**
 * Correlation ids for either wire dialect: OpenAI chat (`messages`) and
 * OpenAI Responses (`input`, string or item array). The session id must stay
 * stable per conversation on both lanes.
 */
function deriveRequestIDsFromWire(body) {
  if (body && Array.isArray(body.messages)) return deriveRequestIDs(body.messages);
  const input = body && body.input;
  if (typeof input === 'string') {
    return deriveRequestIDs([{ role: 'user', content: input }]);
  }
  if (Array.isArray(input)) {
    const messages = input.map((item) => {
      if (typeof item === 'string') return { role: 'user', content: item };
      if (item && typeof item === 'object') {
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const content = typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
            : (typeof item.text === 'string' ? item.text : '');
        return { role, content };
      }
      return null;
    }).filter(Boolean);
    return deriveRequestIDs(messages);
  }
  return deriveRequestIDs([]);
}
function extractErrorMessage(bodyText, status) {
  let snippet = String(bodyText || '').slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText);
    snippet = (parsed && (parsed.message || (parsed.error && (parsed.error.message || parsed.error.code)))) || snippet;
  } catch { /* keep raw snippet */ }
  if (status === 403) return `upstream 403 (free-lane gate or region block): ${snippet}`;
  if (status === 429) return `upstream 429 rate limited (anonymous lane quota is per IP): ${snippet}`;
  return `upstream ${status}: ${snippet}`;
}

module.exports = {
  ZEN_BASE_URL,
  ANONYMOUS_KEY,
  PROVIDER_ID,
  PROVIDER_NAME,
  RESPONSES_PROVIDER_ID,
  RESPONSES_PROVIDER_NAME,
  staticFreeModels,
  bootstrapModelEntries,
  bootstrapResponsesEntries,
  catalogModelEntries,
  responsesModelEntries,
  buildDeclaration,
  deriveRequestIDsFromWire,
  buildUpstreamBody,
  isChatLaneModel,
  REASONING_EFFORT_LADDER,
  createCatalog,
  deriveRequestIDs,
  disguiseHeaders,
  opencodeUserAgent,
  effortsFor,
  reasoningEffortWire,
  upstreamEffort,
  ensureFreeLaneShape,
  extractErrorMessage,
};
