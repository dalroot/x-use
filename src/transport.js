const http = require('http');
const https = require('https');
const tls = require('tls');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SOCKS_PROTOCOLS = new Set(['socks4:', 'socks4a:', 'socks5:', 'socks5h:']);

class HttpConnectAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, cb) {
    const targetPort = Number(options.port) || 443;
    const authority = `${options.host}:${targetPort}`;
    const headers = { Host: authority };
    if (this.proxy.username || this.proxy.password) {
      const creds = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }

    const req = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || 8080,
      method: 'CONNECT',
      path: authority,
      headers
    });

    req.once('connect', (res, socket) => {
      req.setTimeout(0);
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error(`HTTP proxy CONNECT failed with status ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || options.host
      });
      cb(null, tlsSocket);
    });

    req.once('error', (err) => cb(err));
    req.setTimeout(35000, () => req.destroy(new Error('HTTP proxy CONNECT timeout')));
    req.end();
    return undefined;
  }
}

/**
 * Create an optional SOCKS or HTTP CONNECT proxy agent and patch global fetch for sub-libraries.
 * @param {string} [rawProxy]
 * @returns {{ proxyUrl: string|null, agent: https.Agent|SocksProxyAgent|null }}
 */
function createProxyAgent(rawProxy) {
  if (!rawProxy) {
    return { proxyUrl: null, agent: null };
  }
  let parsed;
  try {
    parsed = new URL(rawProxy);
  } catch (_) {
    throw new Error(`Invalid proxy URL: ${sanitizeProxyUrl(rawProxy)}`);
  }

  let agent;
  if (SOCKS_PROTOCOLS.has(parsed.protocol)) {
    agent = new SocksProxyAgent(rawProxy);
  } else if (parsed.protocol === 'http:') {
    agent = new HttpConnectAgent(rawProxy);
  } else {
    throw new Error(
      `Unsupported proxy protocol "${parsed.protocol}". Use socks5h://, socks5://, socks4://, or http://.`
    );
  }
  const proxyUrl = rawProxy;

  globalThis.fetch = function (url, opts = {}) {
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        return reject(new Error('The operation was aborted.'));
      }
      const u = new URL(url);
      const isHttp = u.protocol === 'http:';
      const transportMod = isHttp && !agent ? http : https;
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        agent
      };
      const req = transportMod.request(reqOpts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            headers: { get: (name) => res.headers[name.toLowerCase()] }
          });
        });
      });
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => req.destroy(new Error('The operation was aborted.')), {
          once: true
        });
      }
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  };

  return { proxyUrl, agent };
}

/**
 * Redact embedded credentials (user:pass@) from a proxy URL before logging or printing.
 * @param {string|null|undefined} proxyUrl
 * @returns {string|null}
 */
function sanitizeProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '***';
    }
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return String(proxyUrl).replace(/\/\/[^/@]+@/, '//***:***@');
  }
}

/**
 * Perform a single raw HTTPS request over Node's built-in https module.
 * Never retries automatically to avoid duplicate writes or triggering anti-automation limits.
 * HTTP error statuses resolve normally so the caller can trip the safety circuit breaker.
 */
function httpRequest(options, postData = null, agent = null) {
  return new Promise((resolve, reject) => {
    const reqOpts = {
      ...options,
      ...(agent ? { agent } : {})
    };
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      let ended = false;
      res.on('data', (c) => chunks.push(c));
      res.on('aborted', () => {
        if (!ended) reject(new Error('Response aborted before completion'));
      });
      res.on('close', () => {
        if (!ended && res.complete === false) {
          reject(new Error('Response closed prematurely before completion'));
        }
      });
      res.on('end', () => {
        ended = true;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Socket closed')));
    req.setTimeout(35000);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Validate HTTP status and GraphQL `errors` array in an X API response.
 */
function parseGraphQLResponse(res, actionName) {
  if (res.statusCode !== 200) {
    const rawBody = String(res.body || '');
    const preview = rawBody.length > 500 ? `${rawBody.slice(0, 500)}...[truncated]` : rawBody;
    const err = new Error(`${actionName} failed with status ${res.statusCode}: ${preview}`);
    err.statusCode = res.statusCode;
    err.headers = res.headers || {};
    throw err;
  }
  const data = JSON.parse(res.body);
  if (data.errors && data.errors.length > 0) {
    const err = new Error(`${actionName} GraphQL error: ${data.errors.map((e) => e.message).join(' | ')}`);
    err.graphqlErrors = data.errors;
    throw err;
  }
  return data;
}

module.exports = {
  createProxyAgent,
  sanitizeProxyUrl,
  httpRequest,
  parseGraphQLResponse
};
