/**
 * Proxy discovery + tunneling for the OpenCode free lane.
 *
 * Why this exists: PI-Desktop spawns plugins as Electron utility processes
 * with a *whitelisted* environment (its `pluginChildEnv` keeps only PATH,
 * SystemRoot, windir, TEMP, TMP, TMPDIR, LANG, HOME, USER, USERPROFILE), so
 * `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NODE_USE_ENV_PROXY` never
 * reach this process. The upstream connection therefore goes out directly:
 * Node's own resolver + no local proxy. On a machine where `opencode.ai` is
 * DNS-poisoned (or the whole domain is only reachable from outside mainland
 * China) every chat turn dies with `fetch failed` -> PI-Desktop shows 502
 * `upstream request failed: fetch failed`.
 *
 * This module answers "which local proxy should this plugin's upstream traffic
 * use?" without any host support, and provides the CONNECT/SOCKS5 tunnels the
 * transport needs:
 *
 *   explicit plugin setting  ->  env (OPENCODE_FREE_PROXY, HTTPS_PROXY, …)
 *     ->  Windows system proxy (WinINET registry)  ->  common local ports
 *     ->  direct (no proxy)
 *
 * Everything here is scoped to this plugin's own outbound requests: the
 * loopback endpoint stays direct and no host or system setting is touched.
 */

'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

/** Ports local proxy clients use by default, best known first. */
const COMMON_PROXY_PORTS = [
  7890, // Clash / Clash Verge / mihomo (classic)
  7897, // Clash Verge Rev
  7891, // Clash mixed-port fallback
  1080, // SOCKS default
  10809, // v2rayN http
  10808, // v2rayN socks
  2080, // Nekoray / v2rayN variants
  8889, // Surge / ClashX mixed
  9567, // SSRDOG-style clients
  20171, // SSR/SSRDOG variants
  1235, // older ClashX
  8118, // privoxy
];
/** Sentinels a user may write into the setting to mean "do not use a proxy". */
const DIRECT_SENTINELS = new Set(['off', 'none', 'direct', 'no', 'false', '0', 'disable', 'disabled']);
/** Sentinels meaning "figure it out yourself" (the default). */
const AUTO_SENTINELS = new Set(['', 'auto', 'system', 'default', 'on', 'true', '1', 'yes']);

const CONNECT_TIMEOUT_MS = 8000;
/**
 * A cold TLS handshake through a local proxy regularly takes 5-6s here, so the
 * original 8s produced spurious route failures — and those triggered the bad
 * direct fallback behind the muse-spark RegionError. 12s leaves room without
 * stalling for long when a proxy is really dead (three failures then put it on
 * a cooldown).
 */
const TUNNEL_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 800;
const REGISTRY_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/** Percent-decoding that never throws: a stray `%` in a password is not fatal. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accepts `http://host:port`, `https://host:port`, `socks5://host:port`,
 * `socks5h://host:port`, optional `user:pass@`, and a bare `host:port`
 * (assumed to be an HTTP proxy — what Clash's mixed port speaks).
 */
function parseProxyUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'the proxy address is empty' };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: `the proxy address is not a valid URL: ${raw}` };
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5' && protocol !== 'socks5h') {
    return { ok: false, error: `unsupported proxy protocol "${protocol}"; use http, https, socks5 or socks5h` };
  }
  const port = url.port ? Number(url.port) : (protocol === 'http' ? 80 : protocol === 'https' ? 443 : 1080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `the proxy port is invalid: ${url.port}` };
  }
  if (!url.hostname) return { ok: false, error: 'the proxy host is missing' };
  const auth = url.username
    ? { username: safeDecode(url.username), password: safeDecode(url.password) }
    : null;
  return {
    ok: true,
    value: {
      protocol,
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port,
      auth,
      // `socks5h` means "let the proxy resolve the name" — with SOCKS5 we
      // always send the hostname, so both spellings behave the same.
      url: `${protocol}://${url.hostname}:${port}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function envProxyUrl(env) {
  for (const key of ['OPENCODE_FREE_PROXY', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return { url: value.trim(), source: `env ${key}` };
  }
  return null;
}

/** Run a command with a hard timeout; resolves with stdout or throws. */
function runCommand(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let child;
    try {
      child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
        if (error) done(reject, error);
        else done(resolve, String(stdout ?? ''));
      });
    } catch (error) {
      done(reject, error);
      return;
    }
    child.on('error', (error) => done(reject, error));
  });
}

/**
 * The Windows system proxy (what Clash/SSRDOG/"使用系统代理" writes):
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings.
 * Read through reg.exe — Node has no registry API, and this is the only
 * permission-free way to see the same proxy Chromium and the host use.
 */
async function readWindowsSystemProxy(env, options = {}) {
  if (process.platform !== 'win32') return null;
  const run = options.runCommand ?? runCommand;
  const timeout = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  // One pass, three queries in parallel: the reads are independent and each
  // spawn has its own timeout, so serialising them only added first-request
  // latency.
  const query = (name) => run('reg.exe', ['query', key, '/v', name], timeout).catch(() => '');
  const [enableOut, serverOut, overrideOut] = await Promise.all([
    query('ProxyEnable'),
    query('ProxyServer'),
    query('ProxyOverride'),
  ]);
  if (!enableOut) return { error: 'could not read the Windows proxy setting (reg.exe produced nothing)' };
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableOut) || /ProxyEnable\s+REG_DWORD\s+1\b/i.test(enableOut);
  if (!enabled) return null;
  const server = (serverOut.match(/ProxyServer\s+REG_SZ\s+(.*)/i)?.[1] ?? '').trim();
  const bypass = (overrideOut.match(/ProxyOverride\s+REG_SZ\s+(.*)/i)?.[1] ?? '').trim();
  if (!server) return null;
  // "host:port" or "http=host:port;https=host:port;socks=host:port"
  if (server.includes('=')) {
    const parts = new Map(
      server.split(';').map((entry) => entry.split('=')).filter((pair) => pair.length === 2)
        .map(([scheme, address]) => [scheme.trim().toLowerCase(), address.trim()]),
    );
    const preferred = parts.get('https') ?? parts.get('http') ?? parts.get('socks') ?? parts.get('socks5');
    if (!preferred) return null;
    const scheme = parts.has('https') || parts.has('http') ? 'http' : 'socks5';
    return { url: `${scheme}://${preferred}`, source: 'windows system proxy', bypass };
  }
  return { url: `http://${server}`, source: 'windows system proxy', bypass };
}

function isPortOpen(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/**
 * Ordered proxy candidates for this session.
 *
 * The plugin setting wins, then the environment, then the Windows system
 * proxy, then a scan of the usual local ports. A port that merely *is* open is
 * not enough to trust it: candidates from the port scan are validated by the
 * transport on first use (a failed CONNECT moves on to the next candidate).
 */
async function resolveProxyCandidates({ setting, env = process.env, log = () => {}, probePorts = true, options = {} } = {}) {
  const candidates = [];
  const notes = [];
  const push = (url, source) => {
    const parsed = parseProxyUrl(url);
    if (!parsed.ok) {
      notes.push(`${source}: ${parsed.error}`);
      return;
    }
    if (candidates.some((entry) => entry.proxy.url === parsed.value.url)) return;
    candidates.push({ proxy: parsed.value, source });
  };

  const settingValue = setting === undefined || setting === null ? '' : String(setting).trim();
  const settingLower = settingValue.toLowerCase();
  let allowAuto = true;
  if (DIRECT_SENTINELS.has(settingLower)) {
    allowAuto = false;
    notes.push(`proxy setting "${settingValue}" means direct`);
  } else if (!AUTO_SENTINELS.has(settingLower)) {
    push(settingValue, 'plugin setting');
  }

  if (allowAuto) {
    const fromEnv = envProxyUrl(env);
    if (fromEnv) push(fromEnv.url, fromEnv.source);

    let system = null;
    try {
      system = await readWindowsSystemProxy(env, options);
    } catch (error) {
      notes.push(`system proxy lookup failed: ${error?.message ?? error}`);
    }
    if (system?.error) notes.push(system.error);
    else if (system?.url) push(system.url, system.source);

    if (candidates.length === 0 && probePorts) {
      // Probe in parallel: a serial scan of a dozen ports would add a visible
      // first-request delay on a machine that has no proxy at all (and thus no
      // system-proxy answer to fall back on).
      const probed = await Promise.all(
        COMMON_PROXY_PORTS.map(async (port) => (await isPortOpen('127.0.0.1', port) ? port : null)),
      );
      const found = probed.filter((port) => port !== null);
      for (const port of found) push(`http://127.0.0.1:${port}`, `local port ${port}`);
      if (found.length === 0) notes.push('no local proxy port answered');
    }
  }

  const direct = { proxy: null, source: 'direct (no proxy)' };
  // `forcedDirect` tells the transport that the *setting* asked for a direct
  // dial, so it must not keep retrying a proxy candidate it remembered earlier.
  return { candidates: [...candidates, direct], notes, forcedDirect: !allowAuto };
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------

function rawConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const onError = (error) => { socket.destroy(); reject(error); };
    socket.once('error', onError);
    socket.setTimeout(timeoutMs, () => {
      socket.removeListener('error', onError);
      socket.destroy();
      const error = new Error(`connect to ${host}:${port} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    });
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

/**
 * Read exactly `length` bytes from a socket that is still in paused mode.
 * The socket's own buffer keeps whatever arrived beyond the requested field,
 * so a proxy that answers a handshake in one packet (the normal case) cannot
 * lose the bytes that follow the first field.
 */
function readBytes(socket, length, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(Object.assign(new Error(`the proxy did not answer within ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (error) reject(error);
      else resolve(value);
    };
    const onEnd = () => finish(Object.assign(new Error('the proxy closed the connection'), { code: 'EPROXY' }));
    const onError = (error) => finish(error);
    const onReadable = () => {
      const chunk = socket.read(length);
      if (chunk) finish(null, chunk);
    };
    socket.on('readable', onReadable);
    socket.on('error', onError);
    socket.on('end', onEnd);
    onReadable();
  });
}

/** Connect to the proxy itself (TLS first when the proxy scheme is https). */
function connectToProxy(proxy) {
  if (proxy.protocol !== 'https') return rawConnect(proxy.host, proxy.port, CONNECT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host }, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(Object.assign(new Error(`the TLS handshake with the proxy ${proxy.host}:${proxy.port} timed out`), { code: 'ETIMEDOUT' }));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

/** HTTP CONNECT tunnel (what Clash's mixed/http/https port speaks). */
async function httpConnectTunnel(proxy, target, timeoutMs = TUNNEL_TIMEOUT_MS) {
  const socket = await connectToProxy(proxy);
  try {
    const lines = [
      `CONNECT ${target.host}:${target.port} HTTP/1.1`,
      `Host: ${target.host}:${target.port}`,
      'Proxy-Connection: keep-alive',
    ];
    if (proxy.auth) {
      const token = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64');
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);

    const status = await new Promise((resolve, reject) => {
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (buffer.length > 8192) {
            reject(Object.assign(new Error('the proxy sent an oversized CONNECT response'), { code: 'EPROXY' }));
          }
          return;
        }
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('timeout', onTimeout);
        socket.removeListener('close', onClose);
        const rest = buffer.slice(end + 4);
        if (rest) socket.unshift(Buffer.from(rest, 'latin1'));
        const first = buffer.slice(0, buffer.indexOf('\r\n'));
        resolve(Number((first.match(/^HTTP\/1\.[01]\s+(\d+)/) ?? [])[1] ?? 0));
      };
      const onError = (error) => { socket.removeListener('data', onData); reject(error); };
      const onTimeout = () => {
        socket.removeListener('data', onData);
        reject(Object.assign(new Error('the proxy CONNECT timed out'), { code: 'ETIMEDOUT' }));
      };
      // A proxy that drops the connection without answering (a flapping local
      // client) must fail this dial right away, not after the tunnel timeout.
      const onClose = () => {
        socket.removeListener('data', onData);
        reject(Object.assign(new Error('the proxy closed the connection before answering CONNECT'), { code: 'ECONNRESET' }));
      };
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.setTimeout(timeoutMs, onTimeout);
    });
    socket.setTimeout(0);
    if (status !== 200) {
      throw Object.assign(
        new Error(`the proxy refused CONNECT for ${target.host}:${target.port} (HTTP ${status})`),
        { code: 'EPROXY' },
      );
    }
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** SOCKS5 tunnel with optional username/password (RFC 1928 / 1929). */
async function socks5Tunnel(proxy, target, timeoutMs = TUNNEL_TIMEOUT_MS) {
  const socket = await connectToProxy(proxy);
  try {
    // Stay in paused mode and read with `readBytes`, so one packet carrying the
    // whole handshake reply is not truncated at the first field.
    socket.pause();
    const read = (length) => readBytes(socket, length, timeoutMs);
    socket.write(Buffer.from(proxy.auth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const greeting = await read(2);
    if (greeting[0] !== 0x05) {
      throw Object.assign(new Error('the SOCKS5 proxy replied with an unknown version'), { code: 'EPROXY' });
    }
    const method = greeting[1];
    if (method === 0x02) {
      if (!proxy.auth) {
        throw Object.assign(new Error('the SOCKS5 proxy demands authentication'), { code: 'EPROXY' });
      }
      const user = Buffer.from(proxy.auth.username, 'utf8');
      const pass = Buffer.from(proxy.auth.password, 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const authReply = await read(2);
      if (authReply[1] !== 0x00) {
        throw Object.assign(new Error('the SOCKS5 proxy rejected the credentials'), { code: 'EPROXY' });
      }
    } else if (method !== 0x00) {
      throw Object.assign(
        new Error(`the SOCKS5 proxy chose an unsupported auth method (0x${method.toString(16)})`),
        { code: 'EPROXY' },
      );
    }

    // The hostname travels as a domain name, so the proxy resolves it — this is
    // what makes a poisoned local DNS answer irrelevant.
    const host = Buffer.from(target.host, 'utf8');
    const port = Buffer.alloc(2);
    port.writeUInt16BE(target.port);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
    const reply = await read(4);
    if (reply[1] !== 0x00) {
      throw Object.assign(
        new Error(`the SOCKS5 proxy refused the connection (code 0x${reply[1].toString(16)})`),
        { code: 'EPROXY' },
      );
    }
    const addressType = reply[3];
    let skip;
    if (addressType === 0x01) skip = 4;
    else if (addressType === 0x04) skip = 16;
    else if (addressType === 0x03) skip = (await read(1))[0];
    else {
      throw Object.assign(
        new Error(`the SOCKS5 proxy answered with an unknown address type (0x${addressType.toString(16)})`),
        { code: 'EPROXY' },
      );
    }
    if (skip > 0) await read(skip);
    await read(2); // bound port
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * A connected socket to `target`, either straight through (candidate.proxy ===
 * null) or through the proxy, TLS-wrapped for https targets.
 */
async function openTunnel(candidate, target, { servername, timeoutMs = TUNNEL_TIMEOUT_MS } = {}) {
  try {
    const useTls = target.port === 443 || target.tls !== false;
    if (!candidate.proxy) {
      const socket = await rawConnect(target.host, target.port, timeoutMs);
      if (!useTls) return socket;
      return await wrapTls(socket, servername ?? target.host, timeoutMs);
    }
    const socket = candidate.proxy.protocol === 'socks5' || candidate.proxy.protocol === 'socks5h'
      ? await socks5Tunnel(candidate.proxy, target, timeoutMs)
      : await httpConnectTunnel(candidate.proxy, target, timeoutMs);
    if (!useTls) return socket;
    return await wrapTls(socket, servername ?? target.host, timeoutMs);
  } catch (error) {
    // Everything thrown here is a *route* problem (DNS, TCP, TLS, proxy
    // protocol), never an answer from the server — mark it so the transport
    // moves on to the next candidate instead of surfacing an internal error.
    if (error && typeof error === 'object' && error.tunnel !== true) error.tunnel = true;
    throw error;
  }
}
function wrapTls(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername }, () => {
      tlsSocket.setTimeout(0);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error) => { tlsSocket.destroy(); reject(error); });
    tlsSocket.setTimeout(timeoutMs, () => {
      tlsSocket.destroy();
      const error = new Error(`the TLS handshake with ${servername} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    });
  });
}

/**
 * Probe a candidate without sending any API traffic: open the tunnel to the
 * target and complete the TLS handshake. Used by the `/proxy` diagnostic
 * endpoint and by tests, not on the hot path.
 */
async function checkCandidate(candidate, target = { host: 'opencode.ai', port: 443 }, timeoutMs = TUNNEL_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const socket = await openTunnel(candidate, target, { timeoutMs });
    socket.destroy();
    return { ok: true, ms: Date.now() - started, source: candidate.source, url: candidate.proxy?.url ?? null };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      source: candidate.source,
      url: candidate.proxy?.url ?? null,
      error: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`,
    };
  }
}

module.exports = {
  COMMON_PROXY_PORTS,
  DIRECT_SENTINELS,
  AUTO_SENTINELS,
  parseProxyUrl,
  resolveProxyCandidates,
  readWindowsSystemProxy,
  isPortOpen,
  openTunnel,
  httpConnectTunnel,
  socks5Tunnel,
  checkCandidate,
  runCommand,
};
