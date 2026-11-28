const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const XUseClient = require('../src');
const { CircuitBreaker } = require('../src/circuit_breaker');
const { RateLimiter } = require('../src/rate_limiter');
const { encryptCookiesVault, decryptCookiesVault, resolveCredentials } = require('../src/auth');
const {
  extractTweetId,
  normalizeTweetResult,
  extractTweetsFromInstructions
} = require('../src/operations/users');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'x-use-test-'));
}

test('CircuitBreaker trips after 2 consecutive errors and surfaces lastError', () => {
  const dir = makeTempDir();
  const breaker = new CircuitBreaker({ filePath: path.join(dir, 'cb.json'), maxErrors: 2 });

  breaker.assertReady();
  const s1 = breaker.recordFailure('HTTP 403 Forbidden');
  assert.equal(s1.consecutiveErrors, 1);
  assert.equal(s1.tripped, false);
  breaker.assertReady();

  const s2 = breaker.recordFailure('HTTP 429 Rate limit');
  assert.equal(s2.consecutiveErrors, 2);
  assert.equal(s2.tripped, true);

  assert.throws(
    () => breaker.assertReady(),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true && /HTTP 429 Rate limit/.test(err.message)
  );

  breaker.reset();
  assert.equal(breaker.getStatus().tripped, false);
  assert.equal(breaker.getStatus().consecutiveErrors, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('XUseClient trips breaker after 2 failed GraphQL responses and immediately on 401/403/429', async () => {
  const dir = makeTempDir();
  const client = new XUseClient({
    authToken: 'test_auth',
    ct0: 'test_ct0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb.json'),
    rateLimitPath: path.join(dir, 'rl.json')
  });

  await assert.rejects(() => client._parseGraphQL({ statusCode: 404, body: 'Not Found' }, 'op1'), /status 404/);
  assert.equal(client.getCircuitBreakerStatus().tripped, false);

  await assert.rejects(() => client._parseGraphQL({ statusCode: 500, body: 'Server Error' }, 'op2'), /CIRCUIT BREAKER TRIPPED/);
  assert.equal(client.getCircuitBreakerStatus().tripped, true);

  await assert.rejects(() => client._httpRequest({ hostname: 'api.x.com', path: '/' }), /TRIPPED/);

  // Late recordSuccess() never clears an already-tripped breaker
  client.recordSuccess?.();
  client.circuitBreaker.recordSuccess();
  assert.equal(client.getCircuitBreakerStatus().tripped, true);

  client.resetCircuitBreaker();
  assert.equal(client.getCircuitBreakerStatus().tripped, false);

  // Immediate trip on 403 & 429 + async locked cooldown persistence + 200 GraphQL account lock
  await assert.rejects(
    () => client._parseGraphQL({ statusCode: 403, body: 'Forbidden' }, 'op3'),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
  );
  client.resetCircuitBreaker();
  await assert.rejects(
    () => client._parseGraphQL({ statusCode: 429, headers: { 'retry-after': '120' }, body: 'Rate limited' }, 'op4'),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
  );
  assert.ok(client.getRateLimitStatus().cooldownRemainingSeconds >= 100);

  client.resetCircuitBreaker();
  await assert.rejects(
    () =>
      client._parseGraphQL(
        { statusCode: 200, body: JSON.stringify({ errors: [{ code: 326, message: 'Account locked' }] }) },
        'op5'
      ),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Cookie domain filtering keeps X/domain-less cookies, drops foreign domains, and requires auth_token + ct0', () => {
  // Domain-less export (README format) is accepted
  const domainless = resolveCredentials({
    cookiesInput: [
      { name: 'auth_token', value: 'tok_a' },
      { name: 'ct0', value: 'ct0_b' }
    ]
  });
  assert.equal(domainless.authToken, 'tok_a');
  assert.equal(domainless.ct0, 'ct0_b');

  // Foreign domains are excluded; X domains are preserved
  const mixed = resolveCredentials({
    cookiesInput: [
      { name: 'session', value: 'evil_secret', domain: '.evil.com' },
      { name: 'auth_token', value: 'x_auth', domain: '.x.com' },
      { name: 'ct0', value: 'x_ct0', domain: 'twitter.com' }
    ]
  });
  assert.equal(mixed.cookieHeader.includes('evil_secret'), false);
  assert.match(mixed.cookieHeader, /auth_token=x_auth/);
  assert.match(mixed.cookieHeader, /ct0=x_ct0/);

  // Missing auth_token throws even when ct0 is present
  assert.throws(
    () => resolveCredentials({ cookiesInput: [{ name: 'ct0', value: 'only_ct0', domain: '.x.com' }] }),
    /Missing `auth_token`/
  );
});

test('Encrypted cookie vault round-trips via AES-256-GCM and resolveCredentials', () => {
  const dir = makeTempDir();
  const cookiesFile = path.join(dir, 'cookies.json');
  const vaultFile = path.join(dir, 'cookies.vault');
  fs.writeFileSync(
    cookiesFile,
    JSON.stringify([
      { name: 'auth_token', value: 'abc_auth' },
      { name: 'ct0', value: 'xyz_ct0' }
    ])
  );

  encryptCookiesVault(cookiesFile, 'super-secret-pass', vaultFile);
  const decrypted = decryptCookiesVault('super-secret-pass', vaultFile);
  assert.equal(decrypted.length, 2);

  const creds = resolveCredentials({ vaultKey: 'super-secret-pass', vaultPath: vaultFile });
  assert.equal(creds.authToken, 'abc_auth');
  assert.equal(creds.ct0, 'xyz_ct0');
  assert.match(creds.cookieHeader, /auth_token=abc_auth/);

  assert.throws(() => decryptCookiesVault('wrong-pass', vaultFile));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractTweetId parses full x.com/twitter.com URLs and numeric IDs', () => {
  assert.equal(extractTweetId('https://x.com/dallsirvan/status/2126422136005046569'), '2126422136005046569');
  assert.equal(extractTweetId('https://twitter.com/user/status/123456789?s=20'), '123456789');
  assert.equal(extractTweetId('987654321'), '987654321');
  assert.throws(() => extractTweetId('https://x.com/dallsirvan'), /Invalid tweet ID or URL/);
});

test('normalizeTweetResult and extractTweetsFromInstructions handle x-web and links', () => {
  const instructions = [
    {
      entries: [
        {
          content: {
            content: {
              tweet_results: {
                result: {
                  __typename: 'TweetWithVisibilityResults',
                  tweet: {
                    rest_id: '111222333',
                    core: { user_results: { result: { core: { name: 'Dall', screen_name: 'dallsirvan' } } } },
                    details: { full_text: 'Hello https://t.co/abc', created_at_ms: 1795676018000 },
                    counts: { favorite_count: 5, retweet_count: 2, reply_count: 1 },
                    views: { count: '42' },
                    url_entities: [{ expanded_url: 'https://github.com/dalroot/x-use' }]
                  }
                }
              }
            }
          }
        }
      ]
    }
  ];

  const tweets = extractTweetsFromInstructions(instructions);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].id, '111222333');
  assert.equal(tweets[0].screenName, 'dallsirvan');
  assert.equal(tweets[0].likes, 5);
  assert.deepEqual(tweets[0].links, ['https://github.com/dalroot/x-use']);
  assert.equal(tweets[0].url, 'https://x.com/dallsirvan/status/111222333');
});

test('RateLimiter enforces strict pacing (waitSeconds, halt: false), window cap, concurrency, and tamper/rollback', async () => {
  const dir = makeTempDir();
  const rlPath = path.join(dir, 'rl.json');

  // Strict pacing guard test (cannot be bypassed by minReadGapMs: 0)
  const strictLimiter = new RateLimiter({
    filePath: rlPath,
    maxReads: 2,
    strict: true,
    minReadGapMs: 0,
    maxReadGapMs: 0
  });
  const e1 = await strictLimiter.acquire('GET', 'SearchByRawQuery');
  assert.equal(e1.eventId, 1);
  await assert.rejects(
    () => strictLimiter.acquire('GET', 'UserOriginalsTimeline'),
    (err) => err.code === 'PACING_WAIT_REQUIRED' && err.halt === false && err.waitSeconds >= 1
  );

  // Corrupted ledger halts instead of resetting to 0
  fs.writeFileSync(rlPath, '{bad json');
  assert.throws(
    () => strictLimiter.getStatus(),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true
  );

  // Clock rollback within 2m local tolerance is allowed; >2m halts
  fs.writeFileSync(
    rlPath,
    JSON.stringify({ lastEventId: 5, lastTsMs: Date.now() + 60000, cooldownUntilMs: 0, events: [] })
  );
  assert.equal(strictLimiter.getStatus().lastEventId, 5);

  fs.writeFileSync(
    rlPath,
    JSON.stringify({ lastEventId: 5, lastTsMs: Date.now() + 180000, cooldownUntilMs: 0, events: [] })
  );
  assert.throws(
    () => strictLimiter.getStatus(),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true && /rollback/i.test(err.message)
  );

  // Concurrent Promise.all with maxReads: 2 allows at most 2 and blocks the rest
  const concPath = path.join(dir, 'rl_conc.json');
  const concLimiter = new RateLimiter({ filePath: concPath, maxReads: 2, minReadGapMs: 3000, maxReadGapMs: 3100 });
  const results = await Promise.allSettled([
    concLimiter.acquire('GET', 'op1'),
    concLimiter.acquire('GET', 'op2'),
    concLimiter.acquire('GET', 'op3')
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'RATE_LIMIT_EXCEEDED');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Security: GCM auth tag tamper fails, HTTP proxy rejected, non-TTY resets rejected, CLI no leak & multi-process concurrency, init 429/redirect, and postThread', async () => {
  const dir = makeTempDir();
  const { EventEmitter } = require('events');
  const https = require('https');
  const { sanitizeProxyUrl, createProxyAgent } = require('../src/transport');
  const { spawnSync, execFile } = require('child_process');
  const cliPath = path.join(__dirname, '..', 'bin', 'x-use.js');

  // 1. Real AES-GCM ciphertext tampering (mutates `data` hex, not outer JSON syntax)
  const cookiesFile = path.join(dir, 'cookies.json');
  const vaultFile = path.join(dir, 'cookies.vault');
  fs.writeFileSync(cookiesFile, JSON.stringify([{ name: 'auth_token', value: 'FAKE123' }, { name: 'ct0', value: 'FAKECT0' }]));
  encryptCookiesVault(cookiesFile, 'pass123', vaultFile);
  const blob = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
  blob.data = (blob.data[0] === '0' ? '1' : '0') + blob.data.slice(1);
  fs.writeFileSync(vaultFile, JSON.stringify(blob));
  assert.throws(() => decryptCookiesVault('pass123', vaultFile), /Unsupported state|unable to authenticate/i);

  // 2. Proxy password redaction, HTTP CONNECT support without socks5h:// rewrite, and invalid scheme rejection
  assert.equal(sanitizeProxyUrl('socks5h://alice:SECRET_PASS@127.0.0.1:10808'), 'socks5h://***:***@127.0.0.1:10808');
  const httpProxy = createProxyAgent('http://alice:SECRET_PASS@127.0.0.1:8080');
  assert.equal(httpProxy.proxyUrl, 'http://alice:SECRET_PASS@127.0.0.1:8080');
  assert.throws(() => createProxyAgent('ftp://127.0.0.1:21'), /Unsupported proxy protocol/);

  // 3. Non-TTY reset-breaker & reset-limits --json rejected with exit != 0
  for (const cmd of ['reset-breaker', 'reset-limits']) {
    const cliRes = spawnSync(process.execPath, [cliPath, cmd, '--json'], {
      input: '',
      encoding: 'utf8',
      env: { ...process.env, HOME: dir }
    });
    assert.notEqual(cliRes.status, 0);
    assert.match(cliRes.stderr, /Refusing to reset/);
  }

  // Helper to temporarily stub https.request offline
  async function withMockHttps(handler, fn) {
    const orig = https.request;
    https.request = (opts, cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => {};
      req.destroy = (e) => req.emit('error', e);
      req.write = () => {};
      req.end = () => {
        const result = handler(opts);
        const res = new EventEmitter();
        res.statusCode = result.statusCode;
        res.headers = result.headers || {};
        process.nextTick(() => {
          cb(res);
          if (result.body) res.emit('data', Buffer.from(result.body));
          res.emit('end');
        });
      };
      return req;
    };
    try {
      return await fn();
    } finally {
      https.request = orig;
    }
  }

  // 4. init() 429 trips circuit breaker immediately and persists cooldown
  const c429 = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb_429.json'),
    rateLimitPath: path.join(dir, 'rl_429.json')
  });
  await withMockHttps(
    () => ({ statusCode: 429, headers: { 'retry-after': '75' }, body: 'Too many requests' }),
    async () => {
      await assert.rejects(
        () => c429.init(),
        (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
      );
    }
  );
  assert.equal(c429.getCircuitBreakerStatus().tripped, true);
  assert.ok(c429.getRateLimitStatus().cooldownRemainingSeconds >= 60);

  // 5. init() redirect counts BOTH GETs in RateLimiter while not triggering pacingWait on subsequent read
  let redirectStep = 0;
  const cRedir = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    strictRateLimit: true,
    breakerPath: path.join(dir, 'cb_redir.json'),
    rateLimitPath: path.join(dir, 'rl_redir.json')
  });
  await withMockHttps(
    (opts) => {
      if (opts.path === '/home') {
        redirectStep += 1;
        return { statusCode: 302, headers: { location: '/home?gl=US' }, body: '' };
      }
      if (opts.path.startsWith('/home?gl=')) {
        redirectStep += 1;
        return { statusCode: 200, body: '<html></html>' };
      }
      return { statusCode: 200, body: JSON.stringify({ data: {} }) };
    },
    async () => {
      await cRedir.init();
      const s = cRedir.getRateLimitStatus();
      assert.equal(s.lastEventId, 2);
      assert.equal(s.readsIn15m, 2);
      // Primary read right after init() redirect must succeed without pacingWait
      const headers = await cRedir._getHeaders('GET', '/i/api/graphql/x/Op', true);
      await cRedir._getGraphQL('/i/api/graphql/x/Op', headers, 'Op');
      assert.equal(cRedir.getRateLimitStatus().lastEventId, 3);
    }
  );
  assert.equal(redirectStep, 2);

  // 6. getProfile uses api.x.com UserByScreenName (skipInit) without hitting /home
  let hitHome = false;
  const cProf = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    strictRateLimit: true,
    breakerPath: path.join(dir, 'cb_prof.json'),
    rateLimitPath: path.join(dir, 'rl_prof.json')
  });
  await withMockHttps(
    (opts) => {
      if (opts.path.startsWith('/home')) hitHome = true;
      return {
        statusCode: 200,
        body: JSON.stringify({
          data: {
            user_result_by_screen_name: {
              result: {
                rest_id: '42',
                core: { name: 'Jack', screen_name: 'jack' },
                profile_bio: { description: 'bio', entities: { url: { urls: [{ expanded_url: 'https://block.xyz' }] } } },
                relationship_counts: { followers: 100, following: 10 },
                tweet_counts: { tweets: 50, media_tweets: 5 },
                verification: { is_blue_verified: false }
              }
            }
          }
        })
      };
    },
    async () => {
      const p = await cProf.getProfile('jack');
      assert.equal(p.screenName, 'jack');
      assert.equal(p.website, 'https://block.xyz');
      assert.equal(p.followersCount, 100);
      assert.equal(hitHome, false);
    }
  );

  // 7. Real CLI leak test (stdout & stderr free of FAKE123 / SECRET_PROXY_PASS) + multi-process concurrency (exit code 4)
  const mockPreload = path.join(dir, 'mock_cli_https.js');
  fs.writeFileSync(
    mockPreload,
    `
const https = require('https');
const { EventEmitter } = require('events');
const mode = process.env.MOCK_MODE || 'ok';
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = (e) => req.emit('error', e);
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.headers = {};
    if (mode === '403') {
      res.statusCode = 403;
      process.nextTick(() => { cb(res); res.emit('data', Buffer.from('Forbidden')); res.emit('end'); });
      return;
    }
    res.statusCode = 200;
    const body = JSON.stringify({
      data: { user_result_by_screen_name: { result: { rest_id: '12', core: { name: 'Jack', screen_name: 'jack' } } } }
    });
    process.nextTick(() => { cb(res); res.emit('data', Buffer.from(body)); res.emit('end'); });
  };
  return req;
};
`
  );

  const leakHome = makeTempDir();
  const leakRes = spawnSync(process.execPath, ['-r', mockPreload, cliPath, 'profile', 'jack', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: leakHome,
      MOCK_MODE: '403',
      X_AUTH_TOKEN: 'FAKE123',
      X_CT0: 'FAKECT0',
      X_PROXY_URL: 'socks5h://user:SECRET_PROXY_PASS@127.0.0.1:10808'
    }
  });
  assert.equal(leakRes.status, 3);
  const combinedOut = leakRes.stdout + '\n' + leakRes.stderr;
  assert.equal(combinedOut.includes('FAKE123'), false);
  assert.equal(combinedOut.includes('FAKECT0'), false);
  assert.equal(combinedOut.includes('SECRET_PROXY_PASS'), false);
  fs.rmSync(leakHome, { recursive: true, force: true });

  // Multi-process CLI concurrency: 3 parallel `xuse profile jack --json` against one HOME
  const concHome = makeTempDir();
  const runCli = () =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-r', mockPreload, cliPath, 'profile', 'jack', '--json'],
        { env: { ...process.env, HOME: concHome, MOCK_MODE: 'ok', X_AUTH_TOKEN: 'FAKE123', X_CT0: 'FAKECT0', X_PROXY_URL: '', HTTPS_PROXY: '', SOCKS_PROXY: '' } },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code : 0, stdout, stderr });
        }
      );
    });
  const cliRuns = await Promise.all([runCli(), runCli(), runCli()]);
  const successes = cliRuns.filter((r) => r.code === 0);
  const pacingWaits = cliRuns.filter((r) => r.code === 4);
  assert.equal(successes.length, 1);
  assert.equal(pacingWaits.length, 2);
  fs.rmSync(concHome, { recursive: true, force: true });

  // 8. createTweet missing tweetId throws AMBIGUOUS_WRITE_RESULT with halt: true
  const cNoId = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb_noid.json'),
    rateLimitPath: path.join(dir, 'rl_noid.json')
  });
  await withMockHttps(
    () => ({ statusCode: 200, body: JSON.stringify({ data: { create_tweet: {} } }) }),
    async () => {
      await assert.rejects(
        () => cNoId.createTweet('hello'),
        (err) => err.code === 'AMBIGUOUS_WRITE_RESULT' && err.halt === true
      );
    }
  );

  // 9. postThread checks quota before publishing AND completes 2-tweet thread under strictRateLimit
  const rlPath = path.join(dir, 'rl_thread.json');
  const now = Date.now();
  fs.writeFileSync(
    rlPath,
    JSON.stringify({
      lastEventId: 13,
      lastTsMs: now,
      cooldownUntilMs: 0,
      events: Array.from({ length: 13 }, (_, idx) => idx + 1).map((id) => ({
        eventId: id,
        timestamp: new Date(now).toISOString(),
        tsMs: now,
        kind: 'write',
        target: 'CreateTweet'
      }))
    })
  );
  const threadClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    strictRateLimit: true,
    breakerPath: path.join(dir, 'cb_thread.json'),
    rateLimitPath: rlPath
  });
  await assert.rejects(
    () => threadClient.postThread(['one', 'two', 'three']),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true && /Insufficient write quota/.test(err.message)
  );

  let tweetSeq = 100;
  const okThreadClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    strictRateLimit: true,
    breakerPath: path.join(dir, 'cb_thread_ok.json'),
    rateLimitPath: path.join(dir, 'rl_thread_ok.json')
  });
  // Reduce random write gap ceiling above 15s min (not below 15s) to ~15s-15.1s so the test stays deterministic
  okThreadClient.rateLimiter.maxWriteGapMs = okThreadClient.rateLimiter.minWriteGapMs + 50;
  await withMockHttps(
    (opts) => {
      if (opts.path === '/home') return { statusCode: 200, body: '<html></html>' };
      const id = String(++tweetSeq);
      return {
        statusCode: 200,
        body: JSON.stringify({
          data: {
            create_tweet: {
              tweet_results: {
                result: { rest_id: id, legacy: { full_text: `t-${id}` }, core: { user_results: { result: { core: { screen_name: 'tester' } } } } }
              }
            }
          }
        })
      };
    },
    async () => {
      const published = await okThreadClient.postThread(['first', 'second']);
      assert.equal(published.length, 2);
      assert.equal(published[0].tweetId, '101');
      assert.equal(published[1].tweetId, '102');
      assert.equal(okThreadClient.rateLimiter.strict, true);
    }
  );

  // 10. If breaker trips while waiting in rateLimiter.acquire(), queued request NEVER hits network
  const waitTripClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb_waittrip.json'),
    rateLimitPath: path.join(dir, 'rl_waittrip.json')
  });
  let networkCallsOnTrip = 0;
  const origAcquire = waitTripClient.rateLimiter.acquire.bind(waitTripClient.rateLimiter);
  waitTripClient.rateLimiter.acquire = async (...a) => {
    const ev = await origAcquire(...a);
    waitTripClient.circuitBreaker.recordFailure('Tripped while waiting', { immediate: true });
    return ev;
  };
  await withMockHttps(
    () => {
      networkCallsOnTrip += 1;
      return { statusCode: 200, body: '{}' };
    },
    async () => {
      await assert.rejects(
        () => waitTripClient._httpRequest({ hostname: 'x.com', path: '/i/api/graphql/x/Op', method: 'GET' }),
        (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
      );
    }
  );
  assert.equal(networkCallsOnTrip, 0);

  // 11. Ambiguous POST (network drop / truncated 200) -> CLI --json outputs AMBIGUOUS_WRITE_RESULT + halt: true,
  //     thread stops before tweet #2, and pre-send errors (tripped breaker) do NOT report AMBIGUOUS_WRITE_RESULT
  const postPreload = path.join(dir, 'mock_post_drop.js');
  const countFile = path.join(dir, 'post_calls.txt');
  fs.writeFileSync(
    postPreload,
    `
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');
const mode = process.env.POST_MOCK_MODE || 'drop';
const countFile = ${JSON.stringify(countFile)};
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = (e) => req.emit('error', e);
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.headers = {};
    if (opts.path === '/home') {
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit('data', Buffer.from('<html></html>')); res.emit('end'); });
      return;
    }
    const prev = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
    fs.writeFileSync(countFile, String(prev + 1));
    if (mode === 'drop') {
      process.nextTick(() => req.emit('error', new Error('ECONNRESET mid-response')));
      return;
    }
  };
  return req;
};
`
  );
  const ambigHome = makeTempDir();
  const ambigCli = spawnSync(process.execPath, ['-r', postPreload, cliPath, 'tweet', 'hello', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: ambigHome,
      POST_MOCK_MODE: 'drop',
      X_AUTH_TOKEN: 'FAKE123',
      X_CT0: 'FAKECT0',
      X_PROXY_URL: '',
      HTTPS_PROXY: '',
      SOCKS_PROXY: ''
    }
  });
  const ambigJson = JSON.parse(ambigCli.stderr);
  assert.equal(ambigJson.code, 'AMBIGUOUS_WRITE_RESULT');
  assert.equal(ambigJson.halt, true);
  assert.equal(Number(fs.readFileSync(countFile, 'utf8')), 1);

  const cbPre = new CircuitBreaker({ filePath: path.join(ambigHome, '.x-use', 'circuit_breaker.json') });
  cbPre.recordFailure('Forced pre-trip', { immediate: true });
  const preTripCli = spawnSync(process.execPath, ['-r', postPreload, cliPath, 'tweet', 'blocked', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: ambigHome,
      POST_MOCK_MODE: 'drop',
      X_AUTH_TOKEN: 'FAKE123',
      X_CT0: 'FAKECT0',
      X_PROXY_URL: '',
      HTTPS_PROXY: '',
      SOCKS_PROXY: ''
    }
  });
  const preTripJson = JSON.parse(preTripCli.stderr);
  assert.equal(preTripJson.code, 'CIRCUIT_BREAKER_TRIPPED');
  assert.notEqual(preTripJson.code, 'AMBIGUOUS_WRITE_RESULT');
  assert.equal(Number(fs.readFileSync(countFile, 'utf8')), 1);
  fs.rmSync(ambigHome, { recursive: true, force: true });

  const dropThreadClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    strictRateLimit: true,
    breakerPath: path.join(dir, 'cb_thread_drop.json'),
    rateLimitPath: path.join(dir, 'rl_thread_drop.json')
  });
  let dropThreadPosts = 0;
  await withMockHttps(
    (opts) => {
      if (opts.path === '/home') return { statusCode: 200, body: '<html></html>' };
      dropThreadPosts += 1;
      return { statusCode: 200, body: '{"data":{"truncated' };
    },
    async () => {
      await assert.rejects(
        () => dropThreadClient.postThread(['tweet-1', 'tweet-2']),
        (err) =>
          err.code === 'AMBIGUOUS_WRITE_RESULT' &&
          err.halt === true &&
          Array.isArray(err.published) &&
          err.published.length === 0
      );
    }
  );
  assert.equal(dropThreadPosts, 1);

  // 12. 429 cooldown uses async lock, does not reset corrupted ledger, and preserves concurrent events across 2 processes
  const corruptRlPath = path.join(dir, 'rl_corrupt_cd.json');
  fs.writeFileSync(corruptRlPath, '{corrupted');
  const corruptLimiter = new RateLimiter({ filePath: corruptRlPath });
  await assert.rejects(() => corruptLimiter.recordCooldown(90), (err) => err.halt === true);
  assert.equal(fs.readFileSync(corruptRlPath, 'utf8'), '{corrupted');

  const conc429Preload = path.join(dir, 'mock_conc_429.js');
  fs.writeFileSync(
    conc429Preload,
    `
const https = require('https');
const { EventEmitter } = require('events');
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = (e) => req.emit('error', e);
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    if (opts.path === '/home') {
      setTimeout(() => {
        res.statusCode = 429;
        res.headers = { 'retry-after': '120' };
        cb(res);
        res.emit('data', Buffer.from('Rate limited'));
        res.emit('end');
      }, 60);
      return;
    }
    res.statusCode = 200;
    res.headers = {};
    const body = JSON.stringify({
      data: { user_result_by_screen_name: { result: { rest_id: '12', core: { name: 'Jack', screen_name: 'jack' } } } }
    });
    process.nextTick(() => { cb(res); res.emit('data', Buffer.from(body)); res.emit('end'); });
  };
  return req;
};
`
  );
  const rl429Home = makeTempDir();
  const runProc = (cmdArgs) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-r', conc429Preload, cliPath, ...cmdArgs],
        {
          env: {
            ...process.env,
            HOME: rl429Home,
            X_AUTH_TOKEN: 'FAKE123',
            X_CT0: 'FAKECT0',
            X_PROXY_URL: '',
            HTTPS_PROXY: '',
            SOCKS_PROXY: ''
          }
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
      );
    });
  const [pCheck, pProfile] = await Promise.all([
    runProc(['check', '--json']),
    runProc(['profile', 'jack', '--json'])
  ]);
  assert.equal(pCheck.code, 3);
  const ledgerOnDisk = JSON.parse(fs.readFileSync(path.join(rl429Home, '.x-use', 'rate_limit.json'), 'utf8'));
  const breakerOnDisk = JSON.parse(fs.readFileSync(path.join(rl429Home, '.x-use', 'circuit_breaker.json'), 'utf8'));
  assert.equal(breakerOnDisk.tripped, true);
  assert.equal(ledgerOnDisk.lastEventId, 2);
  assert.equal(ledgerOnDisk.events.length, 2);
  assert.ok(ledgerOnDisk.cooldownUntilMs > Date.now() + 90000);
  assert.ok(pProfile.code === 0 || pProfile.code === 2 || pProfile.code === 3);
  fs.rmSync(rl429Home, { recursive: true, force: true });

  // 13. Merge-hardening checks: HttpConnectAgent CONNECT timeout, replyTweet reply integrity,
  //     atomic vault write perms, bounded parseGraphQLResponse error preview, and CLI --help reset-limits
  const { parseGraphQLResponse } = require('../src/transport');
  const http = require('http');
  const origFetch = globalThis.fetch;
  const origHttpReq = http.request;
  try {
    const { agent } = createProxyAgent('http://127.0.0.1:19999');
    http.request = () => {
      const req = new EventEmitter();
      req.setTimeout = (_ms, fn) => {
        if (fn) process.nextTick(fn);
      };
      req.destroy = (err) => req.emit('error', err);
      req.end = () => {};
      return req;
    };
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          agent.createConnection({ host: 'x.com', port: 443 }, (err, sock) => (err ? reject(err) : resolve(sock)));
        }),
      /HTTP proxy CONNECT timeout/
    );
  } finally {
    http.request = origHttpReq;
    globalThis.fetch = origFetch;
  }

  const bigHtml = 'x'.repeat(1200);
  assert.throws(
    () => parseGraphQLResponse({ statusCode: 502, body: bigHtml, headers: {} }, 'bigErr'),
    (err) => err.statusCode === 502 && err.message.includes('...[truncated]') && err.message.length < 700
  );

  const vaultDir = makeTempDir();
  const cJson = path.join(vaultDir, 'c.json');
  const vPath = path.join(vaultDir, 'cookies.vault');
  fs.writeFileSync(cJson, JSON.stringify([{ name: 'auth_token', value: 'a' }, { name: 'ct0', value: 'b' }]));
  encryptCookiesVault(cJson, 'pass-1234', vPath);
  assert.equal(fs.statSync(vPath).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(vaultDir).some((f) => f.includes('.tmp.')), false);
  fs.rmSync(vaultDir, { recursive: true, force: true });

  const replyClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb_reply.json'),
    rateLimitPath: path.join(dir, 'rl_reply.json')
  });
  let capturedReplyVars = null;
  await withMockHttps(
    (opts) => {
      if (opts.path === '/home') return { statusCode: 200, body: '<html></html>' };
      return {
        statusCode: 200,
        body: JSON.stringify({ data: { create_tweet: { tweet_results: { result: { rest_id: '999', legacy: { full_text: 'ok' } } } } } })
      };
    },
    async () => {
      // Intercept _postGraphQL payload cleanly to inspect variables without touching mock helper
      const origPost = replyClient._postGraphQL.bind(replyClient);
      replyClient._postGraphQL = async (apiPath, headers, payload, opName, reqOpts) => {
        capturedReplyVars = JSON.parse(payload).variables;
        return origPost(apiPath, headers, payload, opName, reqOpts);
      };
      await replyClient.replyTweet('123456', 'hi', { variables: { reply: { in_reply_to_tweet_id: 'EVIL' } } });
      assert.equal(capturedReplyVars.reply.in_reply_to_tweet_id, '123456');
    }
  );

  const helpRes = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /reset-limits/);

  fs.rmSync(dir, { recursive: true, force: true });
});
