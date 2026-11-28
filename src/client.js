const { parseHTML } = require('linkedom');
const { ClientTransaction } = require('x-client-transaction-id');
const { BEARER_TOKEN, API_X_HOST, DEFAULT_USER_AGENT, DEFAULT_QUERY_IDS } = require('./constants');
const { resolveCredentials, loadSavedConfig } = require('./auth');
const { CircuitBreaker } = require('./circuit_breaker');
const { RateLimiter } = require('./rate_limiter');
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
      options.proxyUrl !== undefined
        ? options.proxyUrl || ''
        : process.env.X_PROXY_URL ||
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
    this.circuitBreaker = new CircuitBreaker({
      filePath: options.breakerPath,
      maxErrors: options.maxErrors
    });
    this.rateLimiter = new RateLimiter({
      filePath: options.rateLimitPath,
      maxReads: options.maxReads,
      maxWrites: options.maxWrites,
      strict: options.strictRateLimit,
      ...options.rateLimitOptions
    });
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

  async _httpRequest(options, postData = null) {
    this.circuitBreaker.assertReady();
    const opName = options.operationName || String(options.path || '').split('/').pop().split('?')[0] || options.method || 'GET';
    this.lastEvent = await this.rateLimiter.acquire(options.method || 'GET', opName, {
      isInit: Boolean(options.isInit),
      bypassPacing: Boolean(options.bypassPacing),
      ...(options.strict !== undefined ? { strict: options.strict } : {})
    });
    // Re-check circuit breaker immediately before network dispatch in case another request
    // or process tripped the breaker while we waited in rateLimiter.acquire().
    this.circuitBreaker.assertReady();

    const isWriteMethod = String(options.method || 'GET').toUpperCase() !== 'GET';
    try {
      return await httpRequest(options, postData, this.agent);
    } catch (err) {
      if (isWriteMethod) {
        const writeErr = new Error(
          `Write request interrupted before complete response (${err.message}). Status is unknown — STOP and verify manually on X before repeating.`
        );
        writeErr.code = 'AMBIGUOUS_WRITE_RESULT';
        writeErr.halt = true;
        writeErr.ambiguousWrite = true;
        await this._recordFailureWithStatus(writeErr, null, null);
      }
      await this._recordFailureWithStatus(err, null, null);
    }
  }

  _getGraphQL(fullPath, headers, operationName = '') {
    return this._httpRequest({
      hostname: 'x.com',
      path: fullPath,
      method: 'GET',
      operationName,
      headers
    });
  }

  _getApiGraphQL(fullPath, headers, operationName = '') {
    return this._httpRequest({
      hostname: API_X_HOST,
      path: fullPath,
      method: 'GET',
      operationName,
      headers
    });
  }

  async _postGraphQL(apiPath, headers, payload, operationName = '', reqOpts = {}) {
    const res = await this._httpRequest(
      {
        hostname: 'x.com',
        path: apiPath,
        method: 'POST',
        operationName,
        ...(reqOpts.strict !== undefined ? { strict: reqOpts.strict } : {}),
        headers: {
          ...headers,
          'content-length': Buffer.byteLength(payload)
        }
      },
      payload
    );
    if (res && typeof res === 'object') {
      res.isWrite = true;
    }
    return res;
  }

  _isSensitiveGraphQLError(err) {
    if (!Array.isArray(err?.graphqlErrors)) return false;
    const sensitiveCodes = new Set([32, 64, 88, 141, 326]);
    return err.graphqlErrors.some(
      (e) =>
        sensitiveCodes.has(Number(e?.code)) ||
        /suspended|locked|temporarily restricted|rate limit|could not authenticate/i.test(String(e?.message || ''))
    );
  }

  async _recordFailureWithStatus(err, status, headers) {
    const isImmediate =
      status === 401 || status === 403 || status === 429 || this._isSensitiveGraphQLError(err);
    const state = this.circuitBreaker.recordFailure(err.message, { immediate: isImmediate });
    if (status === 429 && headers) {
      const retryAfter = Number(headers['retry-after']);
      const resetAt = Number(headers['x-rate-limit-reset']);
      let cooldownSec = 60;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        cooldownSec = retryAfter;
      } else if (Number.isFinite(resetAt) && resetAt > 0) {
        cooldownSec = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
      }
      await this.rateLimiter.recordCooldown(cooldownSec);
    }
    if (err.code === 'AMBIGUOUS_WRITE_RESULT') {
      err.halt = true;
      err.ambiguousWrite = true;
      if (state.tripped) err.circuitBreakerTripped = true;
      throw err;
    }
    if (state.tripped) {
      const trippedErr = new Error(
        `${err.message} | SAFETY CIRCUIT BREAKER TRIPPED (${state.consecutiveErrors} consecutive errors). STOP and notify the user.`
      );
      trippedErr.code = 'CIRCUIT_BREAKER_TRIPPED';
      trippedErr.halt = true;
      trippedErr.lastError = err.message;
      throw trippedErr;
    }
    throw err;
  }

  async _parseGraphQL(res, actionName) {
    try {
      const parsed = parseGraphQLResponse(res, actionName);
      this.circuitBreaker.recordSuccess();
      return parsed;
    } catch (err) {
      let failureErr = err;
      if (res?.isWrite && (err instanceof SyntaxError || Number(res.statusCode) >= 500)) {
        failureErr = new Error(
          `Write response incomplete or ambiguous (${err.message}). Status is unknown — STOP and verify manually on X before repeating.`
        );
        failureErr.code = 'AMBIGUOUS_WRITE_RESULT';
        failureErr.halt = true;
        failureErr.ambiguousWrite = true;
      }
      await this._recordFailureWithStatus(failureErr, res?.statusCode, res?.headers);
    }
  }

  /**
   * Return the current 2-error safety circuit breaker state.
   * @returns {{ consecutiveErrors: number, tripped: boolean, lastError: string|null, lastErrorAt: string|null, lastSuccessAt: string|null }}
   */
  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }

  /**
   * Reset the safety circuit breaker after inspecting and fixing the cause of errors.
   * @humanOnly Intended strictly for manual human recovery — never call autonomously from AI agents.
   */
  resetCircuitBreaker() {
    return this.circuitBreaker.reset();
  }

  /**
   * Return persistent rate-limit ledger status with exact eventId and ISO timestamp.
   */
  getRateLimitStatus() {
    return this.rateLimiter.getStatus();
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
      operationName: 'InitHome',
      isInit: true,
      bypassPacing: true,
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
        operationName: 'InitHomeRedirect',
        isInit: true,
        bypassPacing: true,
        headers: {
          cookie: this.cookieHeader,
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
    }

    if (resHome.statusCode !== 200) {
      const initErr = new Error(`Failed to load x.com shell: status ${resHome.statusCode}`);
      await this._recordFailureWithStatus(initErr, resHome.statusCode, resHome.headers);
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

  async _getHeaders(method, apiPath, skipInit = false) {
    if (skipInit) {
      this._ensureAuth();
    } else if (!this.transaction && !this._transactionInitFailed) {
      await this.init();
    } else {
      this._ensureAuth();
    }
    const headers = {
      authorization: this.bearerToken,
      'x-csrf-token': this.ct0,
      cookie: this.cookieHeader,
      origin: 'https://x.com',
      referer: 'https://x.com/',
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

  /**
   * Fetch public profile metadata for an X handle (without @).
   * Safe read operation; guarded by the 2-error circuit breaker.
   * @param {string} screenName - Target username without '@'.
   * @returns {Promise<{id:string, name:string, screenName:string, bio:string, followersCount:number, followingCount:number, tweetsCount:number, isBlueVerified:boolean}>}
   */
  getProfile(screenName) {
    return usersOps.getProfile(this, screenName);
  }

  /**
   * Fetch original tweets authored by a user via api.x.com UserOriginalsTimeline.
   * @param {string} screenName - Username without '@'.
   * @param {number} [count=20] - Number of tweets to request.
   * @param {string|null} [cursor=null] - Pagination cursor.
   * @returns {Promise<Array<{id:string, text:string, author:string, screenName:string, createdAt:string, likes:number, retweets:number, replies:number, views:string, links:string[], url:string}>>}
   */
  getUserTweets(screenName, count = 20, cursor = null) {
    return usersOps.getUserTweets(this, screenName, count, cursor);
  }

  /**
   * Fetch reposts/retweets made by a user via api.x.com UserRepostsTimeline.
   * @param {string} screenName - Username without '@'.
   * @param {number} [count=20]
   * @param {string|null} [cursor=null]
   */
  getUserReposts(screenName, count = 20, cursor = null) {
    return usersOps.getUserReposts(this, screenName, count, cursor);
  }

  /**
   * Search X posts via api.x.com SearchByRawQuery.
   * @param {string} query - Search query string.
   * @param {number} [count=20]
   * @param {'Latest'|'Top'|'People'|'Photos'|'Videos'} [product='Latest']
   * @param {string|null} [cursor=null]
   */
  searchTweets(query, count = 20, product = 'Latest', cursor = null) {
    return usersOps.searchTweets(this, query, count, product, cursor);
  }

  /**
   * Fetch the authenticated account's Home timeline (TL).
   * @param {number} [count=20]
   * @param {string|null} [cursor=null]
   */
  getHomeTimeline(count = 20, cursor = null) {
    return usersOps.getHomeTimeline(this, count, cursor);
  }

  /**
   * Fetch X Explore feed via genericTimelineQuery.
   * @param {number} [count=20]
   * @param {string|null} [cursor=null]
   * @param {string|null} [timelineId=null] - Optional custom Explore timeline ID.
   */
  getExplore(count = 20, cursor = null, timelineId = null) {
    return usersOps.getExplore(this, count, cursor, timelineId);
  }

  /**
   * Fetch a single tweet by full URL (https://x.com/.../status/ID) or numeric ID.
   * @param {string} tweetIdOrUrl - Tweet URL or numeric rest_id.
   */
  getTweet(tweetIdOrUrl) {
    return usersOps.getTweet(this, tweetIdOrUrl);
  }

  /**
   * Fetch account notifications (mentions, replies, likes, follows).
   * Prefer calling getBadgeCounts() first so you only query notifications when unread > 0.
   * @param {number} [count=40]
   * @param {'All'|'Verified'|'Mentions'} [timelineType='All']
   * @param {string|null} [cursor=null]
   */
  getNotifications(count = 40, timelineType = 'All', cursor = null) {
    return usersOps.getNotifications(this, count, timelineType, cursor);
  }

  /**
   * Fetch autocomplete search suggestions (queries and matching user accounts).
   * @param {string} query
   */
  searchTypeahead(query) {
    return usersOps.searchTypeahead(this, query);
  }

  /**
   * Lightweight (~100B) unread counter check via /2/badge_count/badge_count.json.
   * Use before getNotifications() to avoid unnecessary GraphQL traffic.
   * @returns {Promise<{ntab_unread_count:number, dm_unread_count:number, total_unread_count:number, xchat_unread_count:number}>}
   */
  getBadgeCounts() {
    return usersOps.getBadgeCounts(this);
  }

  /**
   * Publish a single tweet. Never auto-retried on failure to prevent duplicate posts.
   * @param {string} text - Tweet body.
   * @param {Object} [options]
   */
  createTweet(text, options = {}) {
    return tweetsOps.createTweet(this, text, options);
  }

  /**
   * Reply to an existing tweet by numeric ID. Never auto-retried on failure.
   * @param {string} tweetId
   * @param {string} text
   * @param {Object} [options]
   */
  replyTweet(tweetId, text, options = {}) {
    return tweetsOps.replyTweet(this, tweetId, text, options);
  }

  /**
   * Publish a sequential thread from an array of strings with a delay between posts.
   * @param {string[]} tweets
   * @param {number} [delayMs=1200]
   */
  postThread(tweets, delayMs = 1200) {
    return tweetsOps.postThread(this, tweets, delayMs);
  }

  /**
   * Delete one of your own tweets by ID.
   * @param {string} tweetId
   */
  deleteTweet(tweetId) {
    return tweetsOps.deleteTweet(this, tweetId);
  }

  /**
   * Like/favorite a tweet by ID.
   * @param {string} tweetId
   */
  favoriteTweet(tweetId) {
    return tweetsOps.favoriteTweet(this, tweetId);
  }

  retweet(tweetId) {
    return tweetsOps.retweet(this, tweetId);
  }
}

module.exports = XUseClient;
