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
 * Upstream requests go out through lib/transport.js on purpose: the host's
 * `net.fetch` bridge buffers the whole response as text, which would kill the
 * SSE stream (same reasoning as commandcode). That transport keeps streaming
 * and adds the piece a plugin process otherwise cannot have: a proxy route.
 * PI-Desktop spawns plugin processes with a whitelisted environment, so
 * HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NODE_USE_ENV_PROXY never arrive here,
 * and `globalThis.fetch` therefore went straight out over the system resolver.
 * On a machine where `opencode.ai` is DNS-poisoned (mainland China without a
 * tunnel) every turn died as `fetch failed` -> 502. The transport resolves its
 * own route (plugin setting -> env -> Windows system proxy -> common local
 * ports -> direct) and dials it with CONNECT/SOCKS5, so only this plugin's
 * upstream traffic takes the proxy — no host change, no TUN, no system DNS
 * change.
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const zen = require('./lib/zen.js');
const proxyLib = require('./lib/proxy.js');
const { createUpstreamTransport, describeError } = require('./lib/transport.js');

const SERVICE_ID = 'zen-proxy';
/** Plugin setting that decides the upstream route (see lib/proxy.js). */
const PROXY_SETTING_KEY = 'proxyUrl';
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
 * How long the transport may spend waiting out failed proxy dials before it
 * reports `ENOROUTE`. Deliberately below the header timeout above, so the chat
 * error carries the transport's own explanation instead of a bare abort.
 */
const UPSTREAM_WAIT_BUDGET_MS = 35_000;

let pi;
let packageRoot = '';
/** Host per-plugin data dir (pi.plugin.getDataPath); packageRoot is fallback. */
let dataPath = '';
let log = () => {};
let catalog = null;
let server = null;
let serviceLog = () => {};
/** Upstream transport (proxy-aware): created by startService. */
let transport = null;

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
  /** Plugin settings (pi.plugin.getSettings) — the proxy route lives here. */
  settings: {},
  /** Last resolved upstream route, for /healthz and the status command. */
  route: undefined,
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

// ---------------------------------------------------------------------------
// Upstream route (proxy resolution)
// ---------------------------------------------------------------------------

/**
 * The plugin setting decides the route; an empty value means "auto"
 * (env -> Windows system proxy -> common local ports -> direct).
 */
function proxySettingValue() {
  const value = state.settings?.[PROXY_SETTING_KEY];
  return typeof value === 'string' ? value : '';
}

function proxyMode() {
  const value = proxySettingValue().trim().toLowerCase();
  if (proxyLib.DIRECT_SENTINELS.has(value)) return 'direct';
  if (proxyLib.AUTO_SENTINELS.has(value)) return 'auto';
  return 'manual';
}

function createTransport() {
  return createUpstreamTransport({
    resolveCandidates: () => proxyLib.resolveProxyCandidates({
      setting: proxySettingValue(),
      env: process.env,
      log,
    }),
    // Once a proxy candidate exists the transport never dials directly (see
    // dialList); this is only the ceiling for waiting on failed dials.
    waitBudgetMs: UPSTREAM_WAIT_BUDGET_MS,
    log,
  });
}

/** What the transport/`/healthz` report about the current route. */
async function routeSnapshot() {
  if (!transport) return { status: 'stopped', setting: proxySettingValue(), mode: proxyMode() };
  const info = await transport.state();
  state.route = info.active ?? state.route;
  return { status: 'ready', setting: proxySettingValue(), mode: proxyMode(), ...info };
}

/**
 * Persist a proxy choice: a URL, or one of the `auto` / `off` sentinels.
 * The value goes back to the host through `pi.plugin.setSettings` so it
 * survives a reload, and the transport re-resolves immediately.
 */
async function setProxySetting(value) {
  const next = value === undefined || value === null ? '' : String(value).trim();
  const lower = next.toLowerCase();
  if (next && !proxyLib.AUTO_SENTINELS.has(lower) && !proxyLib.DIRECT_SENTINELS.has(lower)) {
    const parsed = proxyLib.parseProxyUrl(next);
    if (!parsed.ok) return { ok: false, error: parsed.error };
  }
  state.settings = { ...state.settings, [PROXY_SETTING_KEY]: next };
  let persisted = false;
  let warning;
  try {
    if (pi && pi.plugin && typeof pi.plugin.setSettings === 'function') {
      await pi.plugin.setSettings({ [PROXY_SETTING_KEY]: next });
      persisted = true;
    } else {
      warning = 'the host plugin API does not expose setSettings: the choice lives in this session only';
    }
  } catch (error) {
    warning = `the choice could not be stored in the plugin settings (${describeError(error)}): it lives in this session only`;
    log(warning);
  }
  if (transport) await transport.refresh();
  log(`proxy setting is now ${next === '' ? 'auto' : next}`);
  return { ok: true, setting: next, persisted, warning };
}

async function sendHealthz(res) {
  sendJson(res, 200, {
    ok: true,
    port: state.port,
    models: currentModelIds().length,
    responsesModels: state.responsesEntries.length,
    source: state.source,
    hostReloadRequired: state.hostReloadRequired,
    catalog: catalog ? catalog.snapshot() : { status: 'pending' },
    route: await routeSnapshot(),
    requests: state.requests,
    errors: state.errors,
    lastError: state.lastError,
  });
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
    void sendHealthz(res).catch((error) => {
      sendJson(res, 500, { error: { message: describeError(error) } });
    });
    return;
  }

  // Route diagnostics: what the plugin would dial right now, plus a live
  // handshake against every candidate. GET is a report, POST sets the route.
  if (pathname === '/proxy' && req.method === 'GET') {
    void (async () => {
      const candidates = await proxyLib.resolveProxyCandidates({
        setting: proxySettingValue(),
        env: process.env,
      });
      const checks = [];
      for (const entry of candidates.candidates) {
        checks.push(await proxyLib.checkCandidate(entry));
      }
      sendJson(res, 200, {
        ok: true,
        route: await routeSnapshot(),
        candidates: candidates.candidates.map((entry) => ({ source: entry.source, url: entry.proxy?.url ?? null })),
        notes: candidates.notes,
        checks,
      });
    })().catch((error) => sendJson(res, 500, { error: { message: describeError(error) } }));
    return;
  }

  if (pathname === '/proxy' && req.method === 'POST') {
    void (async () => {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { error: { message: `request body is not valid JSON: ${describeError(error)}` } });
        return;
      }
      const requested = payload?.url ?? payload?.setting ?? payload?.proxyUrl;
      const result = await setProxySetting(requested);
      if (!result.ok) {
        sendJson(res, 400, { error: { message: result.error } });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        persisted: result.persisted,
        warning: result.warning,
        route: await routeSnapshot(),
      });
    })().catch((error) => sendJson(res, 500, { error: { message: describeError(error) } }));
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

  // Lane shaping — both lanes force streaming and satisfy the free-lane body
  // gate (function tools named bash AND read; re-probed on /v1/responses
  // 2026-10-08, where the same FreeTierError appeared until the gate tools were
  // present):
  //   chat      -> buildUpstreamBody (stream, reasoning_effort, gate tools)
  //   responses -> the gate tools in the flat Responses shape, and no
  //                tool_choice override: that provider only accepts "auto"
  const isResponsesLane = upstreamPath.endsWith('/responses');
  const body = isResponsesLane
    ? zen.ensureFreeLaneShape({ ...hostBody, stream: true }, { dialect: 'responses' })
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
  const upstreamFetch = transport ? transport.fetch : null;
  if (!upstreamFetch) {
    clearTimeout(headerTimer);
    state.errors += 1;
    state.lastError = 'the upstream transport is not running';
    sendJson(res, 503, { error: { message: state.lastError } });
    return;
  }
  try {
    // The free lanes live on the anonymous endpoint since 2026-10-14; /zen is
    // the keyed path now and answers 403 FreeTierError for keyless requests.
    const response = await upstreamFetch(`${zen.ANONYMOUS_BASE_URL}${upstreamPath}`, {
      method: 'POST',
      headers: {
        ...zen.disguiseHeaders(ids),
        authorization: `Bearer ${zen.ANONYMOUS_KEY}`,
        'content-type': 'application/json',
        // The client's own Accept spelling — the anonymous lane is strict about
        // the request shape it fingerprints (see lib/zen.js ANONYMOUS_BASE_URL).
        accept: 'application/json, text/event-stream',
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

    const upstream = response.body;
    if (!upstream) {
      res.end();
      return;
    }

    // The anonymous lane forces the upstream request to stream, but the host
    // decides the response. A client that sent `stream: false` expects one JSON
    // object; piping SSE fragments at it makes it fail to parse (issue #3).
    if (hostBody.stream !== true) {
      const text = await streamToString(upstream);
      const payload = isResponsesLane
        ? reassembleResponsesSse(text, hostBody.model)
        : reassembleChatSse(text);
      sendJson(res, 200, payload);
      return;
    }

    // The host asked for a stream: pass it through chunk by chunk. Both ends
    // speak the same dialect, so nothing is re-encoded.
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    upstream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => upstream.destroy());
    upstream.pipe(res);
  } catch (error) {
    clearTimeout(headerTimer);
    // Keep the underlying cause: a bare `fetch failed` is undiagnosable (it is
    // how a poisoned DNS answer or a dead proxy used to reach the chat window).
    state.errors += 1;
    state.lastError = describeError(error);
    log(`proxy error: ${state.lastError}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `upstream request failed: ${state.lastError}` } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/**
 * Fold an upstream chat SSE stream back into one non-streaming chat.completion.
 * The anonymous lane requires the request to stream, but a client that did not
 * ask for a stream expects a single JSON object.
 */
function reassembleChatSse(raw) {
  let id = '';
  let created = 0;
  let model = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage;
  for (const line of raw.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (!id) {
      id = chunk.id || '';
      created = chunk.created || 0;
      model = chunk.model || '';
    }
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (delta) {
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    }
    const reason = chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason;
    if (reason) finishReason = reason;
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
  }
  // Some models put the whole answer in `reasoning` and leave `content` empty.
  if (!content && reasoning) content = reasoning;
  const message = { role: 'assistant', content };
  if (reasoning && content) message.reasoning_content = reasoning;
  const out = {
    id: id || 'chatcmpl-proxy',
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
  };
  if (usage) out.usage = usage;
  return out;
}

/** Fold an upstream responses SSE stream back into one response object. */
function reassembleResponsesSse(raw, model) {
  let text = '';
  let completed;
  for (const line of raw.split('\n')) {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    } else if (event.type === 'response.completed' && event.response) {
      completed = event.response;
    }
  }
  if (completed) {
    const output = Array.isArray(completed.output) ? completed.output : [];
    const hasText = output.some((item) => Array.isArray(item && item.content)
      && item.content.some((part) => part && part.type === 'output_text'));
    if (!hasText) {
      output.push({
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text }],
      });
      completed.output = output;
    }
    return completed;
  }
  return {
    id: `resp_proxy_${Math.floor(Date.now() / 1000)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || '',
    output: [{
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
  };
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

  // The upstream transport must exist before the endpoint accepts anything:
  // every request (chat lanes and the catalog) goes through it.
  transport = createTransport();
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
  catalog = zen.createCatalog((url, init) => transport.fetch(url, init), () => {
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
  transport = null;
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

/** One-line route summary for the status toast. */
async function routeSummary() {
  const snapshot = await routeSnapshot();
  if (snapshot.status !== 'ready') return '上游 未就绪';
  // `planned` is where the *next* request goes; `active` is only whatever
  // answered last, so it is stale right after a setting change.
  const route = snapshot.planned ?? snapshot.active;
  if (!route) return `上游 未就绪（${snapshot.mode}）`;
  if (!route.url) return `上游 直连（${snapshot.mode}）`;
  const last = snapshot.active;
  const stale = last && (last.url ?? null) !== route.url ? `，上次走 ${last.url ?? '直连'}` : '';
  return `上游 ${route.url}（${route.source}）${stale}`;
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
      await transport?.refresh();
      await catalog.refreshOnce();
      applyCatalog(state.port ?? PORT_CANDIDATES[0]);
      const ids = currentModelIds();
      const note = state.hostReloadRequired ? ' 模型列表已变化，请在插件页重载一次插件生效。' : '';
      await toast(`OpenCode免费模型: ${ids.length} 个免费模型（${state.source}）· ${await routeSummary()}.${note}`,
        state.source === 'ready' ? 'info' : 'warning');
    },
  });

  pi.commands.register({
    id: COMMANDS.status,
    title: 'OpenCode免费模型: 显示状态',
    category: 'AI',
    keywords: ['opencode', 'zen', '状态', '诊断', 'proxy', '代理', 'status'],
    run: async () => {
      const snapshot = catalog ? catalog.snapshot() : { status: 'pending' };
      await toast(
        `OpenCode免费模型: 端口 ${state.port ?? '未启动'} · ${currentModelIds().length} 个模型 · `
        + `目录 ${snapshot.status}${state.hostReloadRequired ? ' · 需重载插件' : ''}\n`
        + `${await routeSummary()}`
        + `${state.lastError ? ` · 错误: ${state.lastError.slice(0, 120)}` : ''}`,
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
    // Plugin settings carry the upstream route: an empty value means "auto".
    // `getSettings` is the host-owned store, so the choice survives a reload
    // and can also be edited from the plugin's settings page.
    try {
      if (pi.plugin && typeof pi.plugin.getSettings === 'function') {
        const settings = await pi.plugin.getSettings();
        state.settings = settings && typeof settings === 'object' ? settings : {};
      }
    } catch (error) {
      state.settings = {};
      log(`plugin settings are unavailable: ${describeError(error)}`);
    }
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
    proxySettingValue,
    setProxySetting,
    routeSnapshot,
    createTransport,
    sendHealthz,
    handleRequest,
    handleUpstream,
    startService,
    stopService,
    setTransport: (value) => { transport = value; },
  },
};
