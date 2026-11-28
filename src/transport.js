const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Create an optional SOCKS proxy agent and patch global fetch for sub-libraries.
 * @param {string} [rawProxy]
 * @returns {{ proxyUrl: string|null, agent: SocksProxyAgent|null }}
 */
function createProxyAgent(rawProxy) {
  if (!rawProxy) {
    return { proxyUrl: null, agent: null };
  }
  const proxyUrl = rawProxy.startsWith('http://')
    ? rawProxy.replace(/^http:\/\//, 'socks5h://')
    : rawProxy;
  const agent = new SocksProxyAgent(proxyUrl);

  globalThis.fetch = function (url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const reqOpts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
        agent
      };
      const req = https.request(reqOpts, (res) => {
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
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
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
    const err = new Error(`${actionName} failed with status ${res.statusCode}: ${res.body}`);
    err.statusCode = res.statusCode;
    err.headers = res.headers || {};
    throw err;
  }
  const data = JSON.parse(res.body);
  if (data.errors && data.errors.length > 0) {
    throw new Error(`${actionName} GraphQL error: ${data.errors.map((e) => e.message).join(' | ')}`);
  }
  return data;
}

module.exports = {
  createProxyAgent,
  sanitizeProxyUrl,
  httpRequest,
  parseGraphQLResponse
};
