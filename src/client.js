const { parseHTML } = require('linkedom');
const { ClientTransaction } = require('x-client-transaction-id');
const { BEARER_TOKEN, DEFAULT_USER_AGENT, DEFAULT_QUERY_IDS } = require('./constants');
const { resolveCredentials, loadSavedConfig } = require('./auth');
const { createProxyAgent, httpRequest, parseGraphQLResponse } = require('./transport');
const tweetsOps = require('./operations/tweets');
const usersOps = require('./operations/users');

/**
 * Browserless X (Twitter) GraphQL client designed for AI agents and CLI workflows.
 */
class XUseClient {
  /**
   * @param {Object} [options]
   * @param {string} [options.cookiesPath] - Path to exported browser cookies JSON array.
   * @param {Array<Object>} [options.cookies] - In-memory cookie array.
   * @param {string} [options.authToken] - Direct X `auth_token` cookie value.
   * @param {string} [options.ct0] - Direct X `ct0` CSRF token value.
   * @param {string} [options.proxyUrl] - Optional SOCKS5/HTTP proxy URL.
   * @param {string} [options.userAgent] - Custom User-Agent header.
   * @param {Object} [options.queryIds] - GraphQL queryId overrides.
   */
  constructor(options = {}) {
    const saved = loadSavedConfig();
    const rawProxy =
      options.proxyUrl ||
      process.env.X_PROXY_URL ||
      process.env.SOCKS_PROXY ||
      process.env.HTTPS_PROXY ||
      saved.proxyUrl ||
      '';

    const { proxyUrl, agent } = createProxyAgent(rawProxy);
    this.proxyUrl = proxyUrl;
    this.agent = agent;

    this.cookiesPath = options.cookiesPath || process.env.X_COOKIES_PATH || null;
    this.cookiesInput = options.cookies || null;
    this.authToken = options.authToken || process.env.X_AUTH_TOKEN || '';
    this.ct0 = options.ct0 || process.env.X_CT0 || '';
    this.cookieHeader = '';

    this.bearerToken = BEARER_TOKEN;
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT;
    this.queryIds = { ...DEFAULT_QUERY_IDS, ...options.queryIds };

    this.transaction = null;
    this._transactionInitFailed = false;
  }

  _ensureAuth() {
    if (this.cookieHeader && this.ct0) return;
    const creds = resolveCredentials({
      cookiesPath: this.cookiesPath,
      cookiesInput: this.cookiesInput,
      authToken: this.authToken,
      ct0: this.ct0
    });
    this.cookieHeader = creds.cookieHeader;
    this.ct0 = creds.ct0;
    this.authToken = creds.authToken;
  }

  _httpRequest(options, postData = null) {
    return httpRequest(options, postData, this.agent);
  }

  _getGraphQL(fullPath, headers) {
    return this._httpRequest({
      hostname: 'x.com',
      path: fullPath,
      method: 'GET',
      headers
    });
  }

  _postGraphQL(apiPath, headers, payload) {
    return this._httpRequest(
      {
        hostname: 'x.com',
        path: apiPath,
        method: 'POST',
        headers: {
          ...headers,
          'content-length': Buffer.byteLength(payload)
        }
      },
      payload
    );
  }

  _parseGraphQL(res, actionName) {
    return parseGraphQLResponse(res, actionName);
  }

  /**
   * Initialize session shell and optional x-client-transaction-id generator.
   */
  async init() {
    this._ensureAuth();

    let resHome = await this._httpRequest({
      hostname: 'x.com',
      path: '/home',
      method: 'GET',
      headers: {
        cookie: this.cookieHeader,
        'user-agent': this.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (resHome.statusCode >= 300 && resHome.statusCode < 400 && resHome.headers?.location) {
      const loc = resHome.headers.location.startsWith('http')
        ? new URL(resHome.headers.location).pathname
        : resHome.headers.location;
      resHome = await this._httpRequest({
        hostname: 'x.com',
        path: loc,
        method: 'GET',
        headers: {
          cookie: this.cookieHeader,
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
    }

    if (resHome.statusCode !== 200) {
      throw new Error(`Failed to load x.com shell: status ${resHome.statusCode}`);
    }

    try {
      const { document } = parseHTML(resHome.body);
      const tx = new ClientTransaction(document);
      await tx.initialize();
      this.transaction = tx;
    } catch (_) {
      this.transaction = null;
      this._transactionInitFailed = true;
    }
  }

  async _getHeaders(method, apiPath) {
    if (!this.transaction && !this._transactionInitFailed) {
      await this.init();
    } else {
      this._ensureAuth();
    }
    const headers = {
      authorization: this.bearerToken,
      'x-csrf-token': this.ct0,
      cookie: this.cookieHeader,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'user-agent': this.userAgent,
      'content-type': 'application/json',
      accept: '*/*'
    };
    if (this.transaction) {
      headers['x-client-transaction-id'] = await this.transaction.generateTransactionId(method, apiPath);
    }
    return headers;
  }

  getProfile(screenName) {
    return usersOps.getProfile(this, screenName);
  }

  getUserTweets(screenNameOrUserId, count = 20) {
    return usersOps.getUserTweets(this, screenNameOrUserId, count);
  }

  searchTweets(query, count = 20, product = 'Latest') {
    return usersOps.searchTweets(this, query, count, product);
  }

  createTweet(text, options = {}) {
    return tweetsOps.createTweet(this, text, options);
  }

  replyTweet(tweetId, text, options = {}) {
    return tweetsOps.replyTweet(this, tweetId, text, options);
  }

  postThread(tweets, delayMs = 1200) {
    return tweetsOps.postThread(this, tweets, delayMs);
  }

  deleteTweet(tweetId) {
    return tweetsOps.deleteTweet(this, tweetId);
  }

  favoriteTweet(tweetId) {
    return tweetsOps.favoriteTweet(this, tweetId);
  }

  retweet(tweetId) {
    return tweetsOps.retweet(this, tweetId);
  }
}

module.exports = XUseClient;
