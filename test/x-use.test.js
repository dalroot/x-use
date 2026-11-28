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

  assert.throws(() => client._parseGraphQL({ statusCode: 404, body: 'Not Found' }, 'op1'), /status 404/);
  assert.equal(client.getCircuitBreakerStatus().tripped, false);

  assert.throws(() => client._parseGraphQL({ statusCode: 500, body: 'Server Error' }, 'op2'), /CIRCUIT BREAKER TRIPPED/);
  assert.equal(client.getCircuitBreakerStatus().tripped, true);

  await assert.rejects(() => client._httpRequest({ hostname: 'api.x.com', path: '/' }), /TRIPPED/);

  client.resetCircuitBreaker();
  assert.equal(client.getCircuitBreakerStatus().tripped, false);

  // Immediate trip on 403 & 429 + cooldown persistence
  assert.throws(
    () => client._parseGraphQL({ statusCode: 403, body: 'Forbidden' }, 'op3'),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
  );
  client.resetCircuitBreaker();
  assert.throws(
    () => client._parseGraphQL({ statusCode: 429, headers: { 'retry-after': '120' }, body: 'Rate limited' }, 'op4'),
    (err) => err.code === 'CIRCUIT_BREAKER_TRIPPED' && err.halt === true
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(client.getRateLimitStatus().cooldownRemainingSeconds >= 100);

  fs.rmSync(dir, { recursive: true, force: true });
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

  // Clock rollback halts
  fs.writeFileSync(
    rlPath,
    JSON.stringify({ lastEventId: 5, lastTsMs: Date.now() + 60000, cooldownUntilMs: 0, events: [] })
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

test('Security: vault tamper fails, proxy credentials & cookies never leak, non-TTY reset-breaker rejected, postThread checks quota', async () => {
  const dir = makeTempDir();
  const { sanitizeProxyUrl } = require('../src/transport');
  const { spawnSync } = require('child_process');

  // 1. Vault tampering detection
  const cookiesFile = path.join(dir, 'cookies.json');
  const vaultFile = path.join(dir, 'cookies.vault');
  fs.writeFileSync(cookiesFile, JSON.stringify([{ name: 'auth_token', value: 'FAKE123' }, { name: 'ct0', value: 'FAKECT0' }]));
  encryptCookiesVault(cookiesFile, 'pass123', vaultFile);
  const rawVault = fs.readFileSync(vaultFile);
  rawVault[rawVault.length - 1] ^= 0xff;
  fs.writeFileSync(vaultFile, rawVault);
  assert.throws(() => decryptCookiesVault('pass123', vaultFile));

  // 2. Proxy password redaction & no token leak in errors
  assert.equal(sanitizeProxyUrl('socks5h://alice:SECRET_PASS@127.0.0.1:10808'), 'socks5h://***:***@127.0.0.1:10808');
  const client = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb.json'),
    rateLimitPath: path.join(dir, 'rl.json')
  });
  try {
    client._parseGraphQL({ statusCode: 403, body: 'Forbidden' }, 'check');
  } catch (err) {
    assert.equal(err.message.includes('FAKE123'), false);
    assert.equal(err.message.includes('FAKECT0'), false);
  }

  // 3. Non-TTY reset-breaker --json rejected
  const cliRes = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'x-use.js'), 'reset-breaker', '--json'], {
    input: '',
    encoding: 'utf8',
    env: { ...process.env, HOME: dir }
  });
  assert.notEqual(cliRes.status, 0);
  assert.match(cliRes.stderr, /Refusing to reset circuit breaker/);

  // 4. postThread checks write quota before publishing
  const rlPath = path.join(dir, 'rl_thread.json');
  const now = Date.now();
  fs.writeFileSync(
    rlPath,
    JSON.stringify({
      lastEventId: 3,
      lastTsMs: now,
      cooldownUntilMs: 0,
      events: [1, 2, 3].map((id) => ({ eventId: id, timestamp: new Date(now).toISOString(), tsMs: now, kind: 'write', target: 'CreateTweet' }))
    })
  );
  const threadClient = new XUseClient({
    authToken: 'FAKE123',
    ct0: 'FAKECT0',
    proxyUrl: '',
    breakerPath: path.join(dir, 'cb_thread.json'),
    rateLimitPath: rlPath
  });
  await assert.rejects(
    () => threadClient.postThread(['one', 'two', 'three']),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true && /Insufficient write quota/.test(err.message)
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
