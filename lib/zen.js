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
 * Free-lane blocklist (opencode2dsh 0.3.11 live matrix): models the anonymous
 * chat lane can never serve. The Zen catalog still lists them, so S1 alone
 * would expose dead ids — one exclusion reason per model:
 *   exo-free                             410 ModelDeprecated (upstream delisted)
 *   jev-1.13-free                        400 ModelProtocolUnsupported (SystemOne-only)
 *   ling-3.0-flash-fin-free              400 "Model is unavailable" (upstream-side)
 *   muse-spark-1.*-contributor-free      403 RegionError, chat and responses alike
 *
 * 免费通道黑名单（来自 opencode2dsh 0.3.11 实测矩阵）：匿名 chat 通道永远无法服务
 * 的模型。Zen 目录仍会列出它们，只靠 S1 就会把死 id 暴露出去——逐个给出排除原因：
 *   exo-free                             410 ModelDeprecated（上游已下架）
 *   jev-1.13-free                        400 ModelProtocolUnsupported（仅 SystemOne）
 *   ling-3.0-flash-fin-free              400 “Model is unavailable”（上游侧）
 *   muse-spark-1.*-contributor-free      403 RegionError，chat 与 responses 皆然
 */
const FREE_LANE_BLOCKLIST = new Set([
  'exo-free',
  'jev-1.13-free',
  'ling-3.0-flash-fin-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
]);

/**
 * S3: ids verified against the anonymous lane (live Zen catalog + models.dev,
 * refreshed 2026-10). Sorted (byte order) so a static fallback declaration is
 * identical to the manifest on disk — an offline start then rewrites nothing.
 * `jev-*` is deliberately absent: it is free, but only answerable on the
 * dedicated /systemone lane, which this plugin does not declare.
 *
 * S3：经匿名通道实测验证过的 id 列表（实时 Zen 目录 + models.dev，2026-10 刷新）。
 * 按字节序排序，使静态兜底声明与磁盘上的 manifest 完全一致——离线启动因此不会触发
 * 任何改写。`jev-*` 被有意排除：它虽然免费，但只能在专用的 /systemone 通道上应答，
 * 而本插件并未声明该通道。
 */
const staticFreeModels = [
  'beam-free',
  'big-pickle',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'll-alpha-free',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'space-bunny-free',
];

/**
 * models.dev fields this plugin knowingly overrides (opencode2dsh #56 metadata
 * note): the feed declares `mimo-v2.6-flash-free` with `limit.context:
 * 200000`, while the MiMo V2.6 Flash model card and the official OpenCode CLI
 * config use 1048576. Checked BEFORE the metadata in `catalogEntry`.
 *
 * 本插件有意覆盖的 models.dev 字段（参考 opencode2dsh #56 的元数据说明）：数据源
 * 把 `mimo-v2.6-flash-free` 的 `limit.context` 标为 200000，而 MiMo V2.6 Flash
 * 的模型卡与官方 OpenCode CLI 配置都是 1048576。该覆盖在 `catalogEntry` 中先于元
 * 数据生效。
 */
const LOCAL_MODEL_OVERRIDES = {
  'mimo-v2.6-flash-free': { contextWindow: 1048576 },
};

/**
 * Shallow per-field override: declared fields win, the rest pass through.
 * 浅层逐字段覆盖：以本插件声明的字段为准，其余字段原样透传。
 */
function applyLocalOverride(model, price) {
  const override = LOCAL_MODEL_OVERRIDES[model];
  if (override === undefined) return price;
  return { ...price, ...override };
}

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
// Reasoning ladders as declared by the live models.dev capability for each model.
// 各模型的推理档位，取自 models.dev 的实时能力声明。
const EXTENDED_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_EFFORT_THINKING_LEVELS = ['low', 'high', 'max'];

// Bootstrap entries mirror staticFreeModels one-to-one (same ids, same limits),
// so an offline cold start reproduces the on-disk manifest byte-for-byte.
// 引导条目与 staticFreeModels 一一对应（id 与上限完全一致），使离线冷启动能逐字节
// 复现磁盘上的 manifest。
const BOOTSTRAP_MODELS = [
  { id: 'beam-free', contextWindow: 1048576, maxTokens: 131072, supportsImages: false, thinkingLevels: EXTENDED_THINKING_LEVELS },
  { id: 'big-pickle', contextWindow: 200000, maxTokens: 32000, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'deepseek-v4.1-flash-free', contextWindow: 200000, maxTokens: 32000, supportsImages: true, thinkingLevels: NO_EFFORT_THINKING_LEVELS },
  { id: 'glm-5.3-flash-free', contextWindow: 200000, maxTokens: 32000, supportsImages: true, thinkingLevels: NO_EFFORT_THINKING_LEVELS },
  { id: 'll-alpha-free', contextWindow: 262144, maxTokens: 65536, supportsImages: false, thinkingLevels: EXTENDED_THINKING_LEVELS },
  { id: 'longcat-2.5-preview-free', contextWindow: 1000000, maxTokens: 131072, supportsImages: true, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'mimo-v2.6-flash-free', contextWindow: 1048576, maxTokens: 32000, supportsImages: true, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'nemotron-3.5-lightning-free', contextWindow: 262144, maxTokens: 262144, supportsImages: false, thinkingLevels: CHAT_THINKING_LEVELS },
  { id: 'nemotron-3.5-super-vl-free', contextWindow: 1048576, maxTokens: 131072, supportsImages: true, thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
  { id: 'space-bunny-free', contextWindow: 1048576, maxTokens: 524288, supportsImages: true, thinkingLevels: SPACE_BUNNY_THINKING_LEVELS },
];

/**
 * muse-spark-* is served by Zen's own /v1/responses endpoint, but the live
 * lane answers 403 RegionError for both the contributor-free ids (2026-10,
 * opencode2dsh #56 blocklist), so no Responses-lane provider is declared
 * until a live probe of that lane answers 200 again.
 *
 * muse-spark-* 由 Zen 自己的 /v1/responses 端点提供，但实测该通道对两个
 * contributor-free id 都返回 403 RegionError（2026-10，opencode2dsh #56 黑名单），
 * 因此在对该通道的实测重新返回 200 之前，不再声明任何 Responses 通道的 provider。
 */
const BOOTSTRAP_RESPONSES_MODELS = [];

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
 * The 12 hex characters a genuine OpenCode client emits (upstream
 * identifier generator): the millisecond clock, a per-millisecond sequence
 * in the low 12 bits, then a bitwise inversion (`~x`) so ids sort newest
 * first. Since 2026-09-16 the free tier decodes those low 12 bits back as a
 * counter and rejects anything outside [0, 63] (opencode2dsh #62), so a
 * digest-derived time segment 403s almost always even when it matches the
 * shape regex. We always mint counter 1: this plugin is the only writer of
 * its own sessions.
 *
 * 真实 OpenCode 客户端发出的 12 个十六进制字符（上游 id 生成器）：毫秒时间戳，
 * 低 12 位存放“同毫秒内序号”，再按位取反（`~x`），使 id 按新→旧排序。自
 * 2026-09-16 起，免费层会把低 12 位当作计数器解码，凡超出 [0, 63] 一律拒绝
 * （opencode2dsh #62）；因此由摘要派生的时间片段即使形状合规，也几乎必然 403。
 * 我们固定使用序号 1：本插件是其自身会话的唯一写入方。
 */
function invertedTimestampHex(now = Date.now()) {
  const current = BigInt(now) * 0x1000n + 1n;
  const inverted = ~current & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, '0');
}

/**
 * A synthesized session, memoized per conversation signal: the clock half is
 * minted ONCE per conversation so a retry or any later turn reuses the same
 * `ses_` id (upstream groups free-tier quota and prompt cache by session).
 * Capped at 1024 entries, FIFO-evicted.
 *
 * 合成的会话 id，按“会话信号”记忆化：时间戳部分每个会话只生成一次，使重试或后续
 * 轮次复用同一个 `ses_` id（上游按会话归组免费额度与提示缓存）。上限 1024 条，
 * 按 FIFO 淘汰。
 */
const SESSION_MEMO_LIMIT = 1024;
const sessionMemo = new Map();

/**
 * Zen's free tier only accepts OpenCode's canonical session shape
 * ("ses_" + 12 hex + 14 base62). Since 2026-10-13 the 12 hex characters must
 * be a REAL inverted clock (see invertedTimestampHex) or the request 403s
 * (opencode2dsh #62). Anything else — the conversation seed in this host —
 * is expanded into a canonical id whose Base62 tail carries the
 * conversation identity, so distinct conversations never collide.
 *
 * Zen 免费层只接受 OpenCode 的规范会话形状（"ses_" + 12 位十六进制 + 14 位
 * base62）。自 2026-10-13 起，这 12 位十六进制必须是真实的“取反时钟”（见
 * invertedTimestampHex），否则请求直接 403（opencode2dsh #62）。其余输入——例如
 * 本宿主提供的会话种子——会被扩展成规范 id，其 base62 尾部承载会话身份，因此不同
 * 会话不会互相碰撞。
 */
function canonicalSessionID(signal) {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
  const memoized = sessionMemo.get(signal);
  if (memoized !== undefined) return memoized;
  const sum = createHash('sha256').update('ses\x00' + signal).digest();
  const timePart = invertedTimestampHex();
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14);
  const session = `ses_${timePart}${randomPart}`;
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next();
    if (!oldest.done) sessionMemo.delete(oldest.value);
  }
  sessionMemo.set(signal, session);
  return session;
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
 * declares per model) and writes reasoning_effort only when the user picks a
 * level. The Zen gateway validates the field against
 * minimal|low|medium|high|xhigh|max|none (anything else is a hard 400, and
 * each model only honors its own ladder — big-pickle rejects `none`, so the
 * old "always send none" default 400'd on the most common no-selection
 * request). So:
 *   - no value from the host -> omit the field entirely (vendor default);
 *   - an explicit off/none -> wire "none" (the only spelling that stops
 *     always-think free models that support it);
 *   - a ladder level the gateway accepts is passed through;
 *   - anything unrecognized injects nothing rather than risk the 400.
 *
 * 回环代理写入上游请求体时的取值规则。
 *
 * 推理菜单由宿主掌控（它读取本插件为每个模型声明的 thinkingLevels），并且只在用户
 * 明确选择档位时才写 reasoning_effort。Zen 网关只接受
 * minimal|low|medium|high|xhigh|max|none，其余值一律硬 400；且每个模型只认自己的
 * 档位——big-pickle 拒绝 `none`，因此旧的“始终发送 none”默认值会让最常见的“未选择
 * 档位”请求直接 400。于是：
 *   - 宿主未给值 -> 完全省略该字段（走厂商默认）；
 *   - 显式 off/none -> 线上写 "none"（对支持它的 always-think 免费模型而言，这是
 *     唯一能真正停止思考的写法）；
 *   - 网关接受的档位 -> 原样透传；
 *   - 无法识别的值 -> 什么都不注入，以免触发 400。
 */
function upstreamEffort(hostValue) {
  return reasoningEffortWire(hostValue);
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
 *
 * 为匿名通道整理宿主发来的 OpenAI chat 请求体：强制开启流式、规范化
 * reasoning_effort，然后套用 bash/read 工具门。宿主发来的其余内容（messages、
 * tools、tool_choice、max_tokens、temperature……）原样转发——这些语义由宿主负责。
 */
function buildUpstreamBody(hostBody) {
  const source = hostBody && typeof hostBody === 'object' ? hostBody : {};
  const body = { ...source, stream: true };
  // Omit the field entirely when the host expressed no preference: a stray
  // "none" is a hard 400 on models whose ladder lacks it (e.g. big-pickle).
  // 宿主未表达偏好时完全省略该字段：在档位不含 "none" 的模型（如 big-pickle）上，
  // 多余的 "none" 会直接触发 400。
  const effort = upstreamEffort(source.reasoning_effort);
  if (effort !== undefined) body.reasoning_effort = effort;
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
    // The live chat lane can never serve a blocklisted id (410 delisted / 400
    // unavailable / 403 region) — deny before any metadata or S3 vouch, so a
    // stale cache or the bootstrap list cannot resurrect it.
    // 实时 chat 通道永远无法服务黑名单中的 id（410 已下架 / 400 不可用 / 403 区域
    // 受限）——在查元数据或走 S3 背书之前就拒绝，使过期缓存或引导列表都无法把它复活。
    if (FREE_LANE_BLOCKLIST.has(model)) return { allowed: false, source: 'local_blocklist', known: true };
    const metadata = decide(model, this.#prices, this.#pricesReady);
    // S3 vouch: compile-time verified ids stay exposed when metadata is
    // pending/missing, and even when stale metadata claims deprecation.
    if (!metadata.allowed && (!metadata.known || metadata.source === 'metadata_deprecated')
      && staticFreeModels.includes(model)) {
      return { allowed: true, source: 'static_verified', known: false };
    }
    return metadata;
  }

  /**
   * Exposed ids: S1 ∩ allowed, or the verified static list while S1 is pending.
   * 对外暴露的 id：S1 ∩ 允许集合；S1 尚未就绪时退化为经校验的静态列表（同样过滤
   * 免费通道黑名单）。
   */
  list() {
    if (this.#zen.size === 0) return staticFreeModels.filter((model) => !FREE_LANE_BLOCKLIST.has(model)).sort();
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
    // Declared overrides (LOCAL_MODEL_OVERRIDES) win over the live models.dev
    // data.
    // 本插件声明的覆盖值（LOCAL_MODEL_OVERRIDES）优先于 models.dev 的实时数据。
    return applyLocalOverride(model, this.#prices.get(model));
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
    // Same free-lane blocklist as the chat lane: a delisted or region-blocked
    // id must not resurrect through the Responses provider either.
    // 与 chat 通道共用同一份免费通道黑名单：已下架或区域受限的 id 也不能经由
    // Responses provider 复活。
    if (FREE_LANE_BLOCKLIST.has(id)) continue;
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
  FREE_LANE_BLOCKLIST,
  LOCAL_MODEL_OVERRIDES,
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
