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

test('XUseClient trips breaker after 2 failed GraphQL responses and blocks 3rd call', async () => {
  const dir = makeTempDir();
  const client = new XUseClient({
    authToken: 'test_auth',
    ct0: 'test_ct0',
    breakerPath: path.join(dir, 'cb.json')
  });

  assert.throws(() => client._parseGraphQL({ statusCode: 404, body: 'Not Found' }, 'op1'), /status 404/);
  assert.equal(client.getCircuitBreakerStatus().tripped, false);

  assert.throws(() => client._parseGraphQL({ statusCode: 403, body: 'Forbidden' }, 'op2'), /CIRCUIT BREAKER TRIPPED/);
  assert.equal(client.getCircuitBreakerStatus().tripped, true);

  await assert.rejects(() => client._httpRequest({ hostname: 'api.x.com', path: '/' }), /TRIPPED/);

  client.resetCircuitBreaker();
  assert.equal(client.getCircuitBreakerStatus().tripped, false);
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

test('RateLimiter records incrementing eventId + ISO timestamp and halts on cap or strict pacing', async () => {
  const dir = makeTempDir();
  const rlPath = path.join(dir, 'rl.json');
  const limiter = new RateLimiter({
    filePath: rlPath,
    maxReads: 2,
    minReadGapMs: 0,
    maxReadGapMs: 0
  });

  const e1 = await limiter.acquire('GET', '/graphql/op1');
  const e2 = await limiter.acquire('GET', '/graphql/op2');
  assert.equal(e1.eventId, 1);
  assert.equal(e2.eventId, 2);
  assert.match(e2.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  const status = limiter.getStatus();
  assert.equal(status.lastEventId, 2);
  assert.equal(status.readsRemaining, 0);

  await assert.rejects(
    () => limiter.acquire('GET', '/graphql/op3'),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true && err.retryAfterSeconds > 0
  );

  // Strict pacing guard test
  const strictLimiter = new RateLimiter({
    filePath: path.join(dir, 'rl_strict.json'),
    maxReads: 10,
    strict: true,
    minReadGapMs: 5000,
    maxReadGapMs: 5000
  });
  await strictLimiter.acquire('GET', '/graphql/a');
  await assert.rejects(
    () => strictLimiter.acquire('GET', '/graphql/b'),
    (err) => err.code === 'RATE_LIMIT_EXCEEDED' && err.halt === true
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('XUseClient sends aligned sec-ch-ua and sec-fetch-site headers', async () => {
  const client = new XUseClient({ authToken: 'a', ct0: 'b' });
  const apiHeaders = await client._getHeaders('GET', '/graphql/x/SearchByRawQuery', true, 'api.x.com');
  assert.equal(apiHeaders['sec-fetch-site'], 'same-site');
  assert.equal(apiHeaders['sec-fetch-mode'], 'cors');
  assert.match(apiHeaders['sec-ch-ua'], /Chromium/);

  const webHeaders = await client._getHeaders('POST', '/i/api/graphql/x/CreateTweet', true, 'x.com');
  assert.equal(webHeaders['sec-fetch-site'], 'same-origin');
});
