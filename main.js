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
 *   chat      -> stream, reasoning_effort normalized, bash/read gate
 *   responses -> stream, bash/read gate (flat tool shape, no tool_choice)
 *
 * Both wires go through the gate: the anonymous lane checks the REQUEST BODY,
 * not the endpoint, so /v1/responses is subject to it too. Getting this wrong
 * 403s every Responses request. See issue #1.
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

  // Lane shaping — both wires force streaming and inject the bash/read gate
  // tools; only the chat wire normalizes reasoning_effort, and the responses
  // wire uses flat tool definitions with no tool_choice. Everything else the
  // host sent is forwarded untouched.
  const isResponsesLane = upstreamPath.endsWith('/responses');
  const body = zen.buildUpstreamBody(
    hostBody,
    isResponsesLane ? zen.LANE.RESPONSES : zen.LANE.CHAT,
  );
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
    // completions, so no re-encoding is needed and streaming is preserved.
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (!response.body) {
      res.end();
      return;
    }
    const upstream = Readable.fromWeb(response.body);
    upstream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => upstream.destroy());
    upstream.pipe(res);
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
