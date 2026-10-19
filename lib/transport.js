/**
 * Upstream transport for the OpenCode free lane.
 *
 * The plugin used `globalThis.fetch` (undici) for two reasons: streaming and
 * "no host bridge". Both are kept, but the connection is now ours:
 *
 *   - a proxy candidate (see lib/proxy.js) is dialed with CONNECT / SOCKS5 and
 *     the TLS session is layered inside the tunnel, so the exit node resolves
 *     `opencode.ai` remotely and a poisoned local DNS answer stops mattering;
 *   - as soon as *any* proxy candidate exists, direct dialing is off the table
 *     for that request: a flapping proxy is waited out and re-dialed, never
 *     skipped, because a direct dial leaves from the local egress — and the
 *     country-gated models answer that with `403 RegionError`;
 *   - only with no proxy candidate at all is the direct route dialed, and a
 *     connect/TLS failure there is retried once against an address resolved
 *     through public DNS servers (the trick that survives a poisoned answer);
 *   - responses are streamed chunk by chunk: `body` is a plain node Readable
 *     that the loopback server pipes straight to the host, so SSE survives.
 *
 * The returned object mirrors just the slice of the fetch API this plugin
 * uses (`ok`, `status`, `headers.get`, `text`, `json`, `body`), which keeps
 * lib/zen.js and main.js untouched in shape.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { Readable } = require('node:stream');
const { openTunnel } = require('./proxy.js');

const DEFAULT_PUBLIC_DNS = ['8.8.8.8', '9.9.9.9'];
const REQUEST_TIMEOUT_MS = 60_000;
const DNS_LOOKUP_TIMEOUT_MS = 5000;

/** Errors that mean "this route is dead" rather than "the server said no". */
const ROUTE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EPROXY', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_SSL_WRONG_VERSION_NUMBER',
  'UND_ERR_CONNECT_TIMEOUT', 'EACCES', 'EHOSTDOWN',
]);

function routeFailure(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  // Everything lib/proxy.js throws is a route problem, and it tags those errors
  // so even a proxy protocol error (bad CONNECT, unknown SOCKS reply) moves on
  // to the next candidate instead of failing the whole turn.
  if (error.tunnel === true) return true;
  if (error.code && ROUTE_ERROR_CODES.has(error.code)) return true;
  // A TLS failure surfaces as a plain Error with a message but no code.
  const message = String(error.message ?? '');
  return /socket hang up|timed? ?out|certificate|handshake|premature close/i.test(message);
}

/** A proxy that fails this many dials in a row is walked last for a while. */
const PROXY_STRIKE_LIMIT = 3;
const PROXY_COOLDOWN_MS = 60_000;
/** Zen's country gate: only the egress country can fix it, not the body. */
const REGION_BLOCK_PATTERN = /RegionError|not available in your country/i;
/**
 * How many times a single proxy candidate is dialed in one walk. A local proxy
 * client with a flapping node (TLS handshake failing every other attempt)
 * recovers inside these dials; giving up after one would mean "falling back",
 * and the next candidate may be the direct route out of the local egress.
 */
const PROXY_DIAL_ATTEMPTS = 3;
/** Pause before re-dialing the same proxy: 400ms, then 900ms. */
const PROXY_RETRY_DELAY_MS = 400;
const PROXY_RETRY_DELAY_STEP_MS = 500;
/**
 * How long one walk may spend on failed dials and the pauses between them.
 * main.js aborts a request at UPSTREAM_HEADER_TIMEOUT_MS and passes a smaller
 * budget than that, so the caller receives this transport's diagnosis instead of
 * a bare abort.
 */
const DEFAULT_WAIT_BUDGET_MS = 35_000;

/**
 * A response rebuilt from an already-consumed body: the country-gate check has
 * to read a 403 to recognise it, and if no other candidate does better the
 * caller must still receive that same refusal.
 */
function syntheticResponse(status, contentType, text) {
  return {
    ok: false,
    status,
    statusText: '',
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null),
      raw: { 'content-type': contentType },
    },
    body: Readable.from([Buffer.from(text, 'utf8')]),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** `fetch failed` in disguise: keep the code and the message of the cause. */
function describeError(error) {
  if (!error) return 'unknown error';
  const parts = [];
  if (error.code) parts.push(error.code);
  if (error.message) parts.push(error.message);
  const cause = error.cause;
  if (cause && cause !== error) {
    const inner = [];
    if (cause.code) inner.push(cause.code);
    if (cause.message) inner.push(cause.message);
    if (inner.length > 0) parts.push(`(${inner.join(': ')})`);
  }
  return parts.length > 0 ? parts.join(' - ') : String(error);
}
/** The error a client-side abort produces, wherever in a request it happens. */
function abortError() {
  const error = new Error('the request was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

/** A pause the caller can still abandon through its AbortSignal (it never hangs). */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (timer.unref) timer.unref();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** An https.Agent that dials through a tunnel instead of straight out. */
class TunnelAgent extends https.Agent {
  constructor(tunnel, options) {
    super({ keepAlive: false, maxSockets: 1, ...options });
    this.tunnel = tunnel;
  }

  createConnection(options, callback) {
    Promise.resolve()
      .then(() => this.tunnel(options))
      .then((socket) => callback(null, socket), (error) => callback(error));
  }
}

/** Plain-http twin of TunnelAgent (a proxy may be asked for a http target). */
class PlainTunnelAgent extends http.Agent {
  constructor(tunnel, options) {
    super({ keepAlive: false, maxSockets: 1, ...options });
    this.tunnel = tunnel;
  }

  createConnection(options, callback) {
    Promise.resolve()
      .then(() => this.tunnel(options))
      .then((socket) => callback(null, socket), (error) => callback(error));
  }
}

function publicDnsLookup(host, servers) {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    try {
      resolver.setServers(servers);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error(`DNS lookup for ${host} timed out`), { code: 'ETIMEDOUT' }));
    }, DNS_LOOKUP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    resolver.resolve4(host, (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || !addresses || addresses.length === 0) {
        reject(error ?? Object.assign(new Error(`no A record for ${host}`), { code: 'ENOTFOUND' }));
        return;
      }
      resolve(addresses);
    });
  });
}

function buildResponse(res, requestUrl) {
  const headers = {
    get(name) {
      const value = res.headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : value ?? null;
    },
    raw: res.headers,
  };
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage,
    url: requestUrl,
    headers,
    body: res,
    text() {
      return new Promise((resolve, reject) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
    },
    async json() {
      const text = await this.text();
      return JSON.parse(text);
    },
  };
}

function defaultPortFor(protocol) {
  return protocol === 'https:' ? 443 : 80;
}

function singleRequest({ url, method, headers, body, signal, plan, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = url;
    const secure = target.protocol === 'https:';
    // `new URL(...).port` is '' whenever the scheme's default port is implied.
    const port = target.port ? Number(target.port) : defaultPortFor(target.protocol);
    const tunnel = async () => {
      if (plan.kind === 'proxy') {
        return openTunnel(plan.candidate, { host: target.hostname, port, tls: secure });
      }
      // Direct: optionally prefer an address resolved through public DNS.
      if (plan.pinnedAddress) {
        return openTunnel(
          { proxy: null },
          { host: plan.pinnedAddress, port, tls: secure },
          { servername: target.hostname },
        );
      }
      return openTunnel({ proxy: null }, { host: target.hostname, port, tls: secure });
    };

    const agent = secure ? new TunnelAgent(tunnel, {}) : new PlainTunnelAgent(tunnel, {});

    const options = {
      host: target.hostname,
      port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent,
    };

    // The timer only guards connect + response headers; a stream that keeps
    // flowing must not be killed by it. Abort (client gone) still destroys the
    // request at any point.
    let timer = null;
    let settled = false;
    const request = (secure ? https : http).request(options, (res) => {
      settled = true;
      clearTimeout(timer);
      resolve(buildResponse(res, target.href));
    });
    const abort = () => request.destroy(abortError());

    // Register the error handler *before* anything can destroy the request:
    // an AbortSignal that fired while the candidates were still resolving used
    // to leave this promise unsettled and the destroyed request without an
    // 'error' listener, which Node reports as an uncaught exception.
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      reject(error);
    };
    request.on('error', settle);

    if (signal) {
      if (signal.aborted) {
        request.destroy();
        settle(abortError());
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) return;
      request.destroy(Object.assign(new Error(`upstream request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs ?? REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

/**
 * Keep the proxies that resolved earlier, appended after the freshly resolved
 * ones (the direct entry stays last). A proxy client that is restarting for a
 * moment during a re-resolution then cannot silently turn a proxy session into a
 * direct one: the request waits for the proxy instead.
 */
function mergeHeldProxies(resolved, held) {
  const direct = resolved.find((entry) => !entry.proxy) ?? { proxy: null, source: 'direct (no proxy)' };
  const proxies = resolved.filter((entry) => entry.proxy);
  const urls = new Set(proxies.map((entry) => entry.proxy.url));
  for (const entry of held) {
    if (urls.has(entry.proxy.url)) continue;
    urls.add(entry.proxy.url);
    proxies.push({ proxy: entry.proxy, source: `remembered ${entry.source}` });
  }
  return [...proxies, direct];
}
/**
 * Build the transport used for both the chat/Responses lanes and the catalog
 * fetches. `resolveCandidates()` returns the ordered candidates for this
 * session (see lib/proxy.js); the list is re-resolved when it goes stale or
 * when every candidate has failed.
 */
function createUpstreamTransport({
  resolveCandidates,
  log = () => {},
  dnsFallback = true,
  publicDns = DEFAULT_PUBLIC_DNS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  waitBudgetMs = DEFAULT_WAIT_BUDGET_MS,
  /** Re-resolve after this long, so a proxy that appears (or dies) later is
   * picked up without a plugin reload. */
  candidateTtlMs = 300_000,
} = {}) {
  let candidates = [];
  let resolvedAt = 0;
  let notes = [];
  /**
   * Proxies that resolved at least once in this process. A re-resolution that
   * lands while the local proxy client is restarting must not empty the pool: an
   * empty pool means the next request leaves through the local egress, which is
   * what the country-gated models answer with 403.
   */
  let heldProxies = [];
  /**
   * The route that last worked. Only a *proxy* candidate becomes sticky: the
   * direct entry is never dialed while a proxy candidate exists (see dialList),
   * so a session cannot drift onto the local egress by accident.
   */
  let stickyIndex = -1;
  let lastRoute = null;
  let lastError = null;
  const failures = new Map();
  /** A proxy that keeps failing its dial is walked last for a while. */
  const proxyStrikes = new Map();
  const proxyCooldownUntil = new Map();
  const states = { requests: 0, retries: 0, waits: 0, dnsRetries: 0, resolutions: 0, regionRetries: 0 };

  async function ensureCandidates(force = false) {
    const stale = Date.now() - resolvedAt > candidateTtlMs;
    if (!force && candidates.length > 0 && !stale) return candidates;
    const result = await resolveCandidates();
    const resolved = result?.candidates ?? [{ proxy: null, source: 'direct (no proxy)' }];
    notes = result?.notes ?? [];
    if (result?.forcedDirect) {
      // The setting explicitly asked for a direct dial: drop the remembered
      // proxies so nothing brings them back.
      heldProxies = [];
    } else {
      const fresh = resolved.filter((entry) => entry.proxy);
      if (fresh.length > 0) heldProxies = fresh;
    }
    candidates = mergeHeldProxies(resolved, heldProxies);
    resolvedAt = Date.now();
    states.resolutions += 1;
    stickyIndex = -1;
    return candidates;
  }

  function hasProxy(list) {
    return list.some((entry) => entry.proxy);
  }

  function plansFor(candidate) {
    const plans = [{ kind: 'proxy', candidate }];
    if (!candidate.proxy && dnsFallback && publicDns.length > 0) {
      plans.push({ kind: 'direct-public-dns', candidate, needsLookup: true });
    }
    return plans;
  }

  /**
   * The candidates actually dialed. With a proxy candidate in the pool the
   * direct entry is dropped: the local egress is what the country-gated models
   * refuse, so "the proxy was slow, flapping or briefly down" must never turn
   * into a direct request. Direct is dialed only when the pool holds no proxy at
   * all (the setting asked for it, or nothing was detected).
   */
  function dialList(pool) {
    return hasProxy(pool) ? pool.filter((entry) => entry.proxy) : pool;
  }

  /**
   * Flatten the list into the exact sequence of dials one walk makes: every plan
   * of every candidate, with each proxy candidate dialed PROXY_DIAL_ATTEMPTS
   * times (the walk takes the pauses between those dials).
   */
  function dialPlan(list) {
    const steps = [];
    for (const { index, candidate } of orderCandidates(list)) {
      const attempts = candidate.proxy ? PROXY_DIAL_ATTEMPTS : 1;
      for (const basePlan of plansFor(candidate)) {
        for (let dial = 1; dial <= attempts; dial += 1) {
          steps.push({ index, candidate, basePlan, dial, attempts });
        }
      }
    }
    return steps;
  }

  /** How a dial is described in /healthz and the log. */
  function routeVia(step) {
    if (step.candidate.proxy) {
      return step.dial > 1 ? `proxy (dial ${step.dial}/${step.attempts})` : 'proxy';
    }
    return step.basePlan.kind === 'direct-public-dns' ? 'direct + public DNS' : 'direct';
  }

  async function requestWithPlan(urlObject, plan, { method, headers, body, signal }) {
    // A pinned-address plan resolves the name through public DNS first; the
    // TLS session still carries the real hostname (SNI + certificate host).
    if (plan.needsLookup) {
      const addresses = await publicDnsLookup(urlObject.hostname, publicDns);
      plan = { ...plan, kind: 'direct', pinnedAddress: addresses[0] };
    }
    return singleRequest({ url: urlObject, method, headers, body, signal, plan, timeoutMs });
  }

  /**
   * Ordered candidate walk: the sticky one first, then the rest, with proxies
   * that just failed a few dials pushed to the back so a dead local proxy does
   * not add its timeout to every request. They come back after the cooldown and
   * are still tried when nothing else works.
   */
  function orderCandidates(list) {
    if (list.length === 0) return [];
    const start = stickyIndex >= 0 && stickyIndex < list.length ? stickyIndex : 0;
    const ordered = [];
    for (let offset = 0; offset < list.length; offset += 1) {
      const index = (start + offset) % list.length;
      ordered.push({ index, candidate: list[index] });
    }
    const now = Date.now();
    const cooling = (entry) => Boolean(entry.candidate.proxy) && (proxyCooldownUntil.get(entry.candidate.source) ?? 0) > now;
    return [...ordered.filter((entry) => !cooling(entry)), ...ordered.filter(cooling)];
  }

  function noteProxyFailure(candidate) {
    if (!candidate.proxy) return;
    const strikes = (proxyStrikes.get(candidate.source) ?? 0) + 1;
    proxyStrikes.set(candidate.source, strikes);
    if (strikes >= PROXY_STRIKE_LIMIT) {
      proxyStrikes.set(candidate.source, 0);
      proxyCooldownUntil.set(candidate.source, Date.now() + PROXY_COOLDOWN_MS);
      log(`proxy ${candidate.proxy.url} failed ${PROXY_STRIKE_LIMIT} times in a row; trying it last for ${Math.round(PROXY_COOLDOWN_MS / 1000)}s`);
    }
  }

  function noteProxySuccess(candidate) {
    if (!candidate.proxy) return;
    proxyStrikes.delete(candidate.source);
    proxyCooldownUntil.delete(candidate.source);
  }

  /**
   * Walk the dials in priority order. Resolves to `{ response }` for the first
   * dial that produced an HTTP response, or `{ attempts }` when every dial
   * failed at connect level. A country-gated 403 is remembered, and the walk
   * tries another candidate before that refusal is handed back.
   */
  async function walk({ urlObject, method, headers, body, signal, deadline = Infinity }, list) {
    const attempts = [];
    const steps = dialPlan(list);
    const soleCandidate = new Set(steps.map((step) => step.candidate)).size === 1;
    const refused = [];
    let refusal = null;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (refused.includes(step.candidate)) continue;
      // Dials that already failed cost real time: stop before the caller's own
      // timeout fires, so it gets this explanation instead of a bare abort.
      if (attempts.length > 0 && Date.now() >= deadline) {
        attempts.push('the walk budget was spent before every route could be tried');
        break;
      }
      states.requests += 1;
      try {
        const response = await requestWithPlan(urlObject, step.basePlan, { method, headers, body, signal });
        if (!response.ok && !soleCandidate) {
          const contentType = response.headers.get('content-type') || 'application/json';
          const text = await response.text().catch(() => '');
          if (response.status === 403 && REGION_BLOCK_PATTERN.test(text)) {
            // The egress country is the problem, not the body: this candidate
            // cannot do better, but another candidate might.
            states.regionRetries += 1;
            refused.push(step.candidate);
            refusal = refusal ?? { status: response.status, contentType, text };
            attempts.push(`[${step.candidate.source}] ${response.status} country-gated`);
            log(`upstream route ${step.candidate.source} is country-gated; trying the next route`);
            continue;
          }
          // Anything else the upstream said is an answer, not a routing problem.
          return {
            response: syntheticResponse(response.status, contentType, text),
            candidate: step.candidate,
            via: routeVia(step),
          };
        }
        noteProxySuccess(step.candidate);
        // Only a real proxy becomes the session route: the direct entry is a
        // last resort for one request, never a session decision.
        stickyIndex = step.candidate.proxy ? step.index : -1;
        lastRoute = {
          source: step.candidate.source,
          url: step.candidate.proxy?.url ?? null,
          via: routeVia(step),
          dial: step.dial,
        };
        lastError = null;
        failures.delete(step.candidate.source);
        return { response, candidate: step.candidate, via: lastRoute.via };
      } catch (error) {
        const how = `${step.basePlan.kind === 'direct-public-dns' ? ' + public DNS' : ''}${step.dial > 1 ? ` dial ${step.dial}/${step.attempts}` : ''}`;
        const description = describeError(error);
        attempts.push(`[${step.candidate.source}${how}] ${description}`);
        if (!routeFailure(error)) {
          // Not a routing problem (aborted, bad response): hand it to the caller.
          lastError = description;
          throw error;
        }
        if (step.basePlan.kind === 'direct-public-dns') states.dnsRetries += 1;
        else states.retries += 1;
        failures.set(step.candidate.source, (failures.get(step.candidate.source) ?? 0) + 1);
        noteProxyFailure(step.candidate);
        log(`upstream route failed: ${step.candidate.source} -> ${description}`);
        if (signal?.aborted) throw error;
      }
      // The dial failed. While this proxy still has dials left, wait and re-dial
      // the *same* proxy: handing the request to the next candidate right away is
      // what used to move a session onto the local egress (and 403 the
      // country-gated models) over a proxy that only flapped.
      const next = steps[i + 1];
      if (step.candidate.proxy && next && next.candidate === step.candidate && next.basePlan === step.basePlan) {
        const delayMs = PROXY_RETRY_DELAY_MS + (step.dial - 1) * PROXY_RETRY_DELAY_STEP_MS;
        states.waits += 1;
        log(`proxy ${step.candidate.proxy.url} failed; waiting ${delayMs}ms before dial ${next.dial}/${step.attempts}`);
        await pause(delayMs, signal);
      }
    }
    if (refusal) {
      // Every candidate was country-gated: hand back the refusal itself.
      return {
        response: syntheticResponse(refusal.status, refusal.contentType, refusal.text),
        candidate: null,
        via: 'country-gated',
      };
    }
    return { attempts };
  }

  async function fetchUpstream(url, init = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body;
    const signal = init.signal;
    const headers = { ...(init.headers ?? {}) };
    const urlObject = new URL(url);
    const pool = await ensureCandidates();
    const list = dialList(pool);
    const deadline = Date.now() + waitBudgetMs;

    const first = await walk({ urlObject, method, headers, body, signal, deadline }, list);
    if (first.response) return first.response;
    // Every route failed at connect level. A pool that contains a proxy is kept
    // as it is (the next request retries it) instead of being re-resolved at the
    // worst possible moment: a re-resolution while the local proxy client
    // restarts would drop the proxy and send the next request out of the local
    // egress.
    if (!hasProxy(pool)) {
      await ensureCandidates(true);
      stickyIndex = -1;
    }
    lastError = first.attempts.join(' | ') || 'no route could be established';
    const proxyOnly = hasProxy(pool);
    const error = new Error(proxyOnly
      ? `${lastError} — no proxy route could be established, and direct dialing stays disabled while a proxy candidate exists `
        + '(set the plugin setting proxyUrl to "off" to dial directly)'
      : lastError);
    error.code = 'ENOROUTE';
    error.proxyOnly = proxyOnly;
    throw error;
  }

  return {
    fetch: fetchUpstream,
    async state() {
      const pool = await ensureCandidates();
      const next = orderCandidates(dialList(pool))[0]?.candidate ?? null;
      return {
        candidates: pool.map((entry) => ({ source: entry.source, url: entry.proxy?.url ?? null })),
        proxiesOnly: hasProxy(pool),
        // What the *next* request will dial (sticky route first). `active` is
        // only the route that last answered, so after a setting change with no
        // traffic in between it is stale — display this one.
        planned: next ? { source: next.source, url: next.proxy?.url ?? null, via: next.proxy ? 'proxy' : 'direct' } : null,
        active: lastRoute,
        notes,
        resolvedAt: new Date(resolvedAt).toISOString(),
        failures: Object.fromEntries(failures),
        lastError,
        counters: { ...states },
      };
    },
    async refresh() {
      await ensureCandidates(true);
      stickyIndex = -1;
    },
    invalidate() {
      stickyIndex = -1;
    },
    describeError,
    routeFailure,
  };
}

module.exports = {
  createUpstreamTransport,
  describeError,
  routeFailure,
  publicDnsLookup,
  ROUTE_ERROR_CODES,
  DEFAULT_PUBLIC_DNS,
};
