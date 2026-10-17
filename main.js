/**
 * OpenCode免费模型 — PI-Desktop plugin entry (plugin process).
 *
 * Architecture follows eric8bit/pi-commandcode-desktop: PI-Desktop reads a
 * plugin's `contributes.providers` from the manifest BEFORE it spawns this
 * process — there is no runtime provider registration, and the chat model
 * picker only enumerates that host provider list. So:
 *
 *   - the manifest declares one provider (`opencode-free`, chat_completions,
 *     authKind none) whose baseUrl points at a loopback endpoint;
 *   - onLoad registers the background service (`zen-proxy`) the host starts
 *     right after onLoad returns; it binds 127.0.0.1 on fixed candidate ports
 *     (the host already captured the baseUrl, so the port must come back the
 *     same) and proxies chat traffic to https://opencode.ai/zen with the
 *     opencode2dsh disguise header set, the canonical ses_ session shape and
 *     the free-lane body gate;
 *   - because authKind is "none" the host sends no Authorization — this
 *     process attaches `Bearer public` itself, so the anonymous lane works
 *     without any key stored in PI-Desktop;
 *   - the live free-model catalog (S1 ∩ models.dev) rewrites the manifest's
 *     provider declaration; a change is surfaced as "reload the plugin once".
 *
 * Upstream requests use this process's native fetch on purpose: the host's
 * `net.fetch` bridge buffers the whole response as text, which would kill the
 * SSE stream (same reasoning as commandcode).
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');

const zen = require('./lib/zen.js');

const SERVICE_ID = 'zen-proxy';
/** Catalog cache file name inside the plugin data directory. */
const CATALOG_CACHE_FILE = 'catalog-cache.json';
/**
 * Fixed candidate ports, in order. The host reads the provider's baseUrl from
 * the manifest before this process starts, so the endpoint must come back to
 * the same port; later candidates only cover the first being taken.
 */
const PORT_CANDIDATES = [41860, 41861, 41862];
const COMMANDS = {
  refresh: 'opencode.refresh',
  status: 'opencode.status',
};
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_HEADER_TIMEOUT_MS = 60_000;

/**
 * A live SSE stream is never silent: Zen emits `: keep-alive` comments while a
 * model is thinking. A gap this long therefore means the connection is dead,
 * and aborting beats letting the host wait forever on a stalled upstream.
 *
 * 真实的 SSE 流不会静默：模型思考期间 Zen 会持续发送 `: keep-alive` 注释行，
 * 因此出现这么长的空档就意味着连接已死；主动中止，好过让宿主无限等待一个卡住的
 * 上游。
 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

let pi;
let packageRoot = '';
/** Host per-plugin data dir (pi.plugin.getDataPath); packageRoot is fallback. */
let dataPath = '';
let log = () => {};
let catalog = null;
let server = null;
let serviceLog = () => {};

const state = {
  /** Model entries currently published into the manifest. */
  entries: [],
  /** Responses-lane (muse-spark) entries currently published. */
  responsesEntries: [],
  source: 'bootstrap',
  port: undefined,
  hostReloadRequired: false,
  started: false,
  lastSync: undefined,
  requests: 0,
  errors: 0,
  lastError: undefined,
};

// ---------------------------------------------------------------------------
// Manifest declaration
// ---------------------------------------------------------------------------

function readManifest() {
  const manifestPath = path.join(packageRoot, 'manifest.json');
  return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
}

/**
 * Write the current provider declaration into this plugin's own manifest.
 *
 * The host validates the manifest and only then spawns the plugin, so a
 * change here takes effect on the next plugin load, not immediately — callers
 * surface that as `hostReloadRequired`. A provider with zero models would
 * invalidate the whole manifest, so an empty list is never written.
 */
function writeDeclaration(declarations) {
  if (!packageRoot) return { ok: false, error: 'the plugin package path is unknown' };
  if (!Array.isArray(declarations) || declarations.length === 0
    || !Array.isArray(declarations[0].models) || declarations[0].models.length === 0) {
    return { ok: false, error: 'refusing to write an empty provider declaration' };
  }

  let manifestPath
  let manifest
  try {
    ({ manifestPath, manifest } = readManifest());
  } catch (error) {
    return { ok: false, error: `manifest.json could not be read: ${error.message}` };
  }

  const previous = JSON.stringify(manifest.contributes?.providers ?? []);
  const next = JSON.stringify(declarations);
  if (previous === next) return { ok: true, changed: false, path: manifestPath };

  manifest.contributes = manifest.contributes ?? {};
  manifest.contributes.providers = declarations;
  const temporary = `${manifestPath}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, manifestPath);
  } catch (error) {
    return { ok: false, error: `manifest.json could not be written: ${error.message}` };
  }
  return { ok: true, changed: true, path: manifestPath };
}

/**
 * Seed state from the manifest exactly as it is on disk.
 *
 * The development-plugin file watcher reloads the plugin on every
 * manifest.json change. A service start that unconditionally re-declared a
 * different list (resetting to the bootstrap five while the live catalog had
 * written seven, or vice versa) therefore oscillated forever: write ->
 * watcher reload -> reset -> write …, with the endpoint restarting and the
 * "Reloaded" toast reappearing each cycle. Seeding from disk makes the
 * startup sync a no-op; the manifest is rewritten only on a genuine change.
 */
function readDeclaredState() {
  try {
    const { manifest } = readManifest();
    const providers = manifest.contributes?.providers ?? [];
    const chat = providers.find((p) => p && p.id === zen.PROVIDER_ID) ?? providers[0];
    const responses = providers.find((p) => p && p.id === zen.RESPONSES_PROVIDER_ID);
    if (chat && Array.isArray(chat.models) && chat.models.length > 0) {
      const match = /127\.0\.0\.1:(\d+)/.exec(String(chat.baseUrl ?? ''));
      return {
        entries: chat.models,
        responsesEntries: responses && Array.isArray(responses.models) ? responses.models : [],
        port: match ? Number(match[1]) : undefined,
      };
    }
  } catch { /* unreadable manifest: fall back to the static lists */ }
  return {
    entries: zen.bootstrapModelEntries(),
    responsesEntries: zen.bootstrapResponsesEntries(),
    port: undefined,
  };
}

/**
 * Publish { port, chat entries, responses entries } into the manifest. A
 * write happens ONLY when the declaration actually differs; the dev-plugin
 * watcher turns every write into one plugin reload, so this must stay a
 * no-op while nothing changed (see readDeclaredState).
 */
function syncDeclaration(port, entries, responsesEntries) {
  const list = entries && entries.length > 0 ? entries : state.entries;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, changed: false };
  const responses = responsesEntries ?? state.responsesEntries;
  const result = writeDeclaration(zen.buildDeclaration(port, list, responses));
  if (result.ok) {
    state.port = port;
    state.entries = list;
    state.responsesEntries = Array.isArray(responses) ? responses : [];
    state.lastSync = new Date().toISOString();
    if (result.changed) {
      state.hostReloadRequired = true;
      log('the model list changed; reload the plugin once so the host re-reads the manifest');
    }
  } else if (result.error) {
    log(`could not publish the provider declaration: ${result.error}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function applyCatalog(port) {
  if (!catalog) return;
  const entries = zen.catalogModelEntries(catalog);
  if (entries.length === 0) return;
  const responsesEntries = zen.responsesModelEntries(catalog);
  state.source = catalog.snapshot().status;
  syncDeclaration(port, entries, responsesEntries);
}

// ---------------------------------------------------------------------------
// Loopback endpoint
// ---------------------------------------------------------------------------

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isLoopbackOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...(extraHeaders || {}) });
  res.end(JSON.stringify(payload));
}

function currentModelIds() {
  if (state.entries.length > 0) return state.entries.map((entry) => entry.id);
  return zen.bootstrapModelEntries().map((entry) => entry.id);
}

/** The loopback server: what PI-Desktop talks to, and what talks to Zen. */
function handleRequest(req, res) {
  if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: { message: 'loopback requests only' } });
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    sendJson(res, 200, {
      ok: true,
      port: state.port,
      models: currentModelIds().length,
      responsesModels: state.responsesEntries.length,
      source: state.source,
      hostReloadRequired: state.hostReloadRequired,
      catalog: catalog ? catalog.snapshot() : { status: 'pending' },
      requests: state.requests,
      errors: state.errors,
      lastError: state.lastError,
    });
    return;
  }

  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: currentModelIds().map((id) => ({ id, object: 'model', name: id })),
    });
    return;
  }

  const isResponses = req.method === 'POST' && pathname.endsWith('/responses');
  const isChat = req.method === 'POST' && pathname.endsWith('/chat/completions');
  if (!isResponses && !isChat) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  void handleUpstream(req, res, isResponses
    ? '/v1/responses'
    : '/v1/chat/completions');
}

/**
 * Proxy one chat or Responses turn to Zen. Both dialects pass through
 * chunk by chunk — the shaping differs only in the body:
 *   chat      -> buildUpstreamBody (stream, reasoning_effort, bash/read gate)
 *   responses -> stream forced on, everything else untouched (muse-spark is
 *                served natively by Zen's own /v1/responses endpoint)
 */
async function handleUpstream(req, res, upstreamPath) {
  let hostBody;
  try {
    hostBody = JSON.parse(await readBody(req));
  } catch (error) {
    state.errors += 1;
    state.lastError = error.message;
    sendJson(res, 400, { error: { message: `request body is not valid JSON: ${error.message}` } });
    return;
  }

  // Lane shaping — chat: force streaming, normalize reasoning_effort, inject
  // the bash/read gate tools; responses: force streaming only (muse-spark is
  // served natively by Zen's own /v1/responses). Everything else the host
  // sent is forwarded untouched.
  const isResponsesLane = upstreamPath.endsWith('/responses');
  const body = isResponsesLane
    ? { ...hostBody, stream: true }
    : zen.buildUpstreamBody(hostBody);
  const ids = zen.deriveRequestIDsFromWire(body);

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', onClose);
  res.on('close', onClose);
  const headerTimer = setTimeout(() => {
    if (!res.headersSent) controller.abort();
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  state.requests += 1;
  try {
    const response = await fetch(`${zen.ZEN_BASE_URL}${upstreamPath}`, {
      method: 'POST',
      headers: {
        ...zen.disguiseHeaders(ids),
        authorization: `Bearer ${zen.ANONYMOUS_KEY}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(headerTimer);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      state.errors += 1;
      state.lastError = zen.extractErrorMessage(bodyText, response.status);
      log(`upstream ${response.status}: ${state.lastError.slice(0, 200)}`);
      if (!res.headersSent) {
        res.writeHead(response.status, {
          'Content-Type': response.headers.get('content-type') || 'application/json',
        });
      }
      res.end(bodyText);
      return;
    }

    // SSE pass-through, chunk by chunk: both ends speak openai chat
    // completions, so no re-encoding is needed. The relay only *inspects* the
    // bytes, so it can guarantee a terminal frame: a stream that ends without
    // `[DONE]` (or with an error) otherwise leaves the host guessing, which on
    // the compaction lane surfaces as an unexplained failure instead of a
    // retryable error.
    // 逐块透传 SSE：两端都讲 openai chat completions，因此无需重新编码。中继只
    // “检视”字节，从而能保证一个终止帧：若流在缺少 `[DONE]`（或带错误）的情况下
    // 结束，宿主只能靠猜；这在压缩（compaction）路径上会表现为一次没有任何解释的
    // 失败，而不是一个可重试的错误。
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (!response.body) {
      res.end();
      return;
    }

    // Relay state: whether the client has left, which terminal markers upstream
    // actually sent, and a rolling tail so a marker split across chunks still
    // matches. `finish()` is the single exit point and always ends the response.
    // 中继状态：客户端是否已断开、上游究竟发出了哪些终止标记，以及一个滚动尾巴，
    // 使被拆到相邻分块的标记也能匹配。`finish()` 是唯一出口，且总会结束响应。
    const upstream = Readable.fromWeb(response.body);
    let clientGone = false;
    let sawDone = false;
    let sawFinish = false;
    let tailProbe = '';
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!clientGone) {
          state.lastError = `upstream was silent for ${UPSTREAM_IDLE_TIMEOUT_MS}ms`;
          log(state.lastError);
          controller.abort();
        }
      }, UPSTREAM_IDLE_TIMEOUT_MS);
    };
    const finish = (errorMessage) => {
      clearTimeout(idleTimer);
      if (clientGone || res.writableEnded) return;
      // Neither `[DONE]` nor `finish_reason` means the upstream never completed
      // the turn (dead connection, or an edge that simply stops talking). Report
      // that as a retryable error instead of a silent, content-free success.
      // 既没有 `[DONE]` 也没有 `finish_reason`，说明上游从未真正完成本轮（连接已
      // 死，或某个边缘节点干脆不再说话）。把它作为可重试的错误上报，而不是当成一次
      // 静默且无内容的“成功”。
      if (!sawDone && !sawFinish) {
        const message = errorMessage ?? 'upstream closed the stream before completing';
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
      }
      if (!sawDone) res.write('data: [DONE]\n\n');
      res.end();
    };

    res.on('close', () => {
      clientGone = true;
      clearTimeout(idleTimer);
      upstream.destroy();
    });

    armIdle();
    try {
      for await (const chunk of upstream) {
        armIdle();
        const text = chunk.toString('utf8');
        // Rolling tail: markers split across chunk boundaries still match.
        // 滚动尾巴：即使标记被拆到相邻分块之间也能匹配。
        tailProbe = (tailProbe + text).slice(-160);
        if (tailProbe.includes('[DONE]')) sawDone = true;
        if (/"finish_reason"\s*:\s*"[a-z_]+"/.test(text)) sawFinish = true;
        if (!res.write(chunk) && !clientGone) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      finish(null);
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      state.errors += 1;
      state.lastError = `upstream stream interrupted: ${reason}`;
      log(state.lastError);
      finish(`upstream stream interrupted: ${reason}`);
    }
  } catch (error) {
    clearTimeout(headerTimer);
    state.errors += 1;
    state.lastError = error && error.message ? error.message : String(error);
    log(`proxy error: ${state.lastError}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `upstream request failed: ${state.lastError}` } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/** Bind 127.0.0.1, preferring the fixed candidates so the manifest stays valid. */
function listen(candidates) {
  return new Promise((resolve, reject) => {
    const ports = [...new Set(candidates.filter((p) => Number.isInteger(p) && p >= 0))];
    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('no candidate port could be bound'));
        return;
      }
      const onError = (error) => {
        if (error.code === 'EADDRINUSE') {
          server.removeListener('listening', onListening);
          tryPort(index + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(ports[index], '127.0.0.1');
    };
    tryPort(0);
  });
}

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

async function startService({ log: providedLog } = {}) {
  if (providedLog) serviceLog = providedLog;
  log = (message) => {
    serviceLog(message);
    try { console.log(`[opencode-free] ${message}`); } catch { /* console may be unavailable */ }
  };

  server = http.createServer(handleRequest);
  const port = await listen(state.declaredPort ? [state.declaredPort, ...PORT_CANDIDATES] : PORT_CANDIDATES);
  state.started = true;
  log(`provider endpoint listening on 127.0.0.1:${port}`);

  // Re-declare only when something actually differs (normally a no-op because
  // entries were seeded from disk). A genuine rewrite triggers exactly one
  // watcher reload; after it, the seed equals the manifest and the cycle stops.
  syncDeclaration(port, state.entries, state.responsesEntries);

  // Live catalog in the background: S1 (Zen /v1/models, disguised) ∩ S2
  // (models.dev cost 0/0, deprecation-first), 5-minute refresh. Seeded from
  // the on-disk cache first, so an offline start keeps the real list and
  // metadata instead of rewriting manifest.json down to the bootstrap.
  catalog = zen.createCatalog((url, init) => globalThis.fetch(url, init), () => {
    // Fires on every real catalog change (5-minute refresh included), so the
    // manifest tracks the live free list without anyone running a command.
    applyCatalog(state.port ?? port);
  }, { cachePath: path.join(dataPath || packageRoot, CATALOG_CACHE_FILE) });
  void catalog
    .start()
    .then(() => applyCatalog(port))
    .catch((error) => log(`catalog refresh failed: ${error && error.message}`));

  return { port };
}

function stopService() {
  if (catalog) {
    catalog.stop();
    catalog = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  state.started = false;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function toast(message, kind) {
  try {
    if (pi && pi.ui && typeof pi.ui.showToast === 'function') {
      await pi.ui.showToast(message, kind || 'info');
      return;
    }
  } catch { /* fall through to the log */ }
  log(message);
}

function registerCommands() {
  pi.commands.register({
    id: COMMANDS.refresh,
    title: 'OpenCode免费模型: 刷新模型目录',
    category: 'AI',
    keywords: ['opencode', 'zen', '刷新模型', 'refresh'],
    run: async () => {
      if (!catalog) {
        await toast('OpenCode免费模型: 服务尚未启动', 'warning');
        return;
      }
      await catalog.refreshOnce();
      applyCatalog(state.port ?? PORT_CANDIDATES[0]);
      const ids = currentModelIds();
      const note = state.hostReloadRequired ? ' 模型列表已变化，请在插件页重载一次插件生效。' : '';
      await toast(`OpenCode免费模型: ${ids.length} 个免费模型（${state.source}）.${note}`,
        state.source === 'ready' ? 'info' : 'warning');
    },
  });

  pi.commands.register({
    id: COMMANDS.status,
    title: 'OpenCode免费模型: 显示状态',
    category: 'AI',
    keywords: ['opencode', 'zen', '状态', '诊断', 'status'],
    run: async () => {
      const snapshot = catalog ? catalog.snapshot() : { status: 'pending' };
      await toast(
        `OpenCode免费模型: 端口 ${state.port ?? '未启动'} · ${currentModelIds().length} 个模型 · `
        + `目录 ${snapshot.status}${state.hostReloadRequired ? ' · 需重载插件' : ''}`
        + `${state.lastError ? ` · 错误: ${state.lastError.slice(0, 80)}` : ''}`,
        state.hostReloadRequired || snapshot.status === 'pending' ? 'warning' : 'info',
      );
    },
  });
}

function unregisterCommands() {
  for (const id of Object.values(COMMANDS)) {
    try {
      pi.commands.unregister(id);
    } catch {
      // The host may already have dropped the command.
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * The host calls `onLoad()` with NO arguments and exposes the plugin API as
   * the global `pi` (plugin-host-process: `globalThis.pi = buildApi()` then
   * `onLoad()`). Read it from there, not from a parameter.
   */
  async onLoad() {
    pi = globalThis.pi;
    if (!pi) {
      throw new Error(
        'the host plugin API is unavailable: expected a global `pi` object before onLoad',
      );
    }
    log = (message) => {
      try { console.log(`[opencode-free] ${message}`); } catch { /* console may be unavailable */ }
    };
    packageRoot = __dirname;
    // Keep the catalog cache in the host's per-plugin data directory (the same
    // place pi-commandcode-desktop keeps its model cache), not in the package
    // dir the development-plugin file watcher monitors: a cache write must
    // never look like a plugin change to the host.
    try {
      if (pi.plugin && typeof pi.plugin.getDataPath === 'function') {
        dataPath = await pi.plugin.getDataPath();
        if (dataPath) fs.mkdirSync(dataPath, { recursive: true });
      }
    } catch { dataPath = ''; }
    if (!dataPath) dataPath = packageRoot;
    // Seed from the manifest exactly as it is ON DISK. The development-plugin
    // file watcher reloads the plugin on every manifest.json write, so
    // re-declaring a different list at each startup (static five vs live
    // catalog) made write -> watcher reload -> reset -> write oscillate
    // forever, visible as the endpoint restarting and the "Reloaded" toast
    // reappearing in a loop. Disk-seeded entries make the startup sync a
    // no-op; the manifest is only rewritten on a genuine catalog change.
    const declared = readDeclaredState();
    state.entries = declared.entries;
    state.responsesEntries = declared.responsesEntries;
    state.declaredPort = declared.port;

    // Register the endpoint first: the host starts declared services right
    // after onLoad returns.
    pi.services.register({
      id: SERVICE_ID,
      start: (context) => startService(context),
      stop: () => stopService(),
    });

    registerCommands();
    log('loaded; provider declaration bootstrapped with the verified static list');
  },

  async onUnload() {
    try { unregisterCommands(); } catch { /* pi may already be gone */ }
    stopService();
  },

  /** Test seam: the internals unit tests need. Not part of the host contract. */
  _internals: {
    syncDeclaration,
    writeDeclaration,
    readDeclaredState,
    state,
    PORT_CANDIDATES,
  },
};
