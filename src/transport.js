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
 * Perform a raw HTTPS request over Node's built-in https module.
 * Retries transient network failures (e.g. flaky tunnel dropping the
 * socket with "Socket closed") up to 5 times before giving up,
 * matching the Python side's 5-attempt retry on the same tunnel.
 * Only network errors are retried; HTTP error statuses resolve normally.
 */
function httpRequest(options, postData = null, agent = null, attempt = 1) {
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
    req.on('error', (err) => {
      if (attempt < 5) {
        setTimeout(() => {
          httpRequest(options, postData, agent, attempt + 1).then(resolve, reject);
        }, 2000 * attempt);
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => req.destroy(new Error('Socket closed')));
    req.setTimeout(60000);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Validate HTTP status and GraphQL `errors` array in an X API response.
 */
function parseGraphQLResponse(res, actionName) {
  if (res.statusCode !== 200) {
    throw new Error(`${actionName} failed with status ${res.statusCode}: ${res.body}`);
  }
  const data = JSON.parse(res.body);
  if (data.errors && data.errors.length > 0) {
    throw new Error(`${actionName} GraphQL error: ${data.errors.map((e) => e.message).join(' | ')}`);
  }
  return data;
}

module.exports = {
  createProxyAgent,
  httpRequest,
  parseGraphQLResponse
};
