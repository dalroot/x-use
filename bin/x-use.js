#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XUseClient = require('../src');
const {
  saveConfig,
  loadSavedConfig,
  encryptCookiesVault,
  isInsecureFileMode
} = require('../src/auth');
const { CircuitBreaker } = require('../src/circuit_breaker');
const { RateLimiter } = require('../src/rate_limiter');
const { sanitizeProxyUrl } = require('../src/transport');

function printHelp() {
  console.log(`xuse (x-use / agent-x-use) — Browserless X (Twitter) CLI for AI Agents

Usage:
  xuse                      Launch interactive parent CLI menu
  xuse <command> [args]     Run a command directly

Commands:
  setup                     Save cookies path / tokens / proxy to ~/.x-use/config.json
  check                     Verify cookie/session connectivity
  profile <username>        Fetch public profile metadata
  tweet <text>              Publish a single tweet
  reply <tweetId> <text>    Reply to a tweet
  thread <file.json>        Publish a thread from a JSON array of strings
  delete <tweetId>          Delete a tweet by ID
  like <tweetId>            Like/favorite a tweet
  retweet <tweetId>         Retweet a tweet
  tweets <username> [n]     Fetch recent tweets for a user
  reposts <username> [n]    Fetch recent reposts for a user
  search <query> [n]        Search tweets
  home [n]                  Fetch Home timeline
  explore [n]               Fetch Explore timeline
  read <url|tweetId>        Fetch a single tweet by URL or ID
  notifications [n]         Fetch notifications
  badges                    Check lightweight unread badge counts
  suggest <query>           Search typeahead suggestions
  breaker                   Show 2-error safety circuit breaker status
  reset-breaker             Reset tripped safety circuit breaker
  limits                    Show persistent rate-limit ledger & last eventId

Options:
  --cookies <path>          Path to cookies JSON file (or set X_COOKIES_PATH)
  --encrypt                 Encrypt cookies into ~/.x-use/cookies.vault using X_USE_KEY
  --proxy <url>             Proxy URL (or set X_PROXY_URL / SOCKS_PROXY)
  --strict                  Halt immediately instead of waiting if pacing gap is not met
  --json                    Output structured JSON for AI agents
  -h, --help                Show help
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = { json: false, cookies: null, proxy: null, encrypt: false, strict: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--encrypt') flags.encrypt = true;
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--cookies' && argv[i + 1]) flags.cookies = argv[++i];
    else if (arg === '--proxy' && argv[i + 1]) flags.proxy = argv[++i];
    else if (arg === '-h' || arg === '--help') flags.help = true;
    else positionals.push(arg);
  }
  return { command: positionals[0], args: positionals.slice(1), flags };
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, (ans) => resolve(ans.trim())));
}

async function runInteractiveMenu(baseFlags) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n⚡ xuse — Browserless X CLI\n`);

  try {
    while (true) {
      const saved = loadSavedConfig();
      const authStatus = saved.cookiesPath
        ? `cookies: ${path.basename(saved.cookiesPath)}`
        : saved.authToken
          ? 'token: configured'
          : 'not configured';

      console.log(`Auth: [${authStatus}] | Proxy: [${sanitizeProxyUrl(saved.proxyUrl || baseFlags.proxy) || 'auto/direct'}]`);
      console.log(`
  1) check    — Verify X session
  2) profile  — Lookup user profile
  3) tweet    — Post a single tweet
  4) reply    — Reply to a tweet
  5) thread   — Post a thread from JSON file
  6) delete   — Delete a tweet by ID
  7) setup    — Configure cookies & proxy
  0) exit
`);
      const choice = await ask(rl, 'Select option [0-7]: ');
      if (choice === '0' || choice === 'exit' || choice === 'q') break;

      const client = new XUseClient({
        ...(baseFlags.cookies ? { cookiesPath: baseFlags.cookies } : {}),
        ...(baseFlags.proxy ? { proxyUrl: baseFlags.proxy } : {})
      });

      try {
        if (choice === '1' || choice === 'check') {
          await client.init();
          console.log('✓ Connected:', { txReady: Boolean(client.transaction), proxy: sanitizeProxyUrl(client.proxyUrl) || 'direct' });
        } else if (choice === '2' || choice === 'profile') {
          const u = await ask(rl, 'Username (without @): ');
          const res = await client.getProfile(u);
          delete res.raw;
          console.log(res);
        } else if (choice === '3' || choice === 'tweet') {
          const text = await ask(rl, 'Tweet text: ');
          if (text) {
            const res = await client.createTweet(text);
            delete res.raw;
            console.log('✓ Published:', res.url);
          }
        } else if (choice === '4' || choice === 'reply') {
          const id = await ask(rl, 'Target tweet ID: ');
          const text = await ask(rl, 'Reply text: ');
          if (id && text) {
            const res = await client.replyTweet(id, text);
            delete res.raw;
            console.log('✓ Replied:', res.url);
          }
        } else if (choice === '5' || choice === 'thread') {
          const file = await ask(rl, 'Path to thread JSON file: ');
          if (file) {
            const items = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
            const res = await client.postThread(items);
            console.log('✓ Published thread:', res.map((t) => t.url));
          }
        } else if (choice === '6' || choice === 'delete') {
          const id = await ask(rl, 'Tweet ID to delete: ');
          if (id) {
            await client.deleteTweet(id);
            console.log('✓ Deleted:', id);
          }
        } else if (choice === '7' || choice === 'setup') {
          const cookiesPath = await ask(rl, 'Cookies JSON path (leave blank to skip): ');
          const proxyUrl = await ask(rl, 'Proxy URL e.g. socks5h://127.0.0.1:10808 (leave blank to skip): ');
          const updates = {};
          if (cookiesPath) updates.cookiesPath = path.resolve(cookiesPath);
          if (proxyUrl) updates.proxyUrl = proxyUrl;
          const savedTo = saveConfig(updates);
          console.log('✓ Saved configuration to', savedTo);
        } else {
          console.log('Unknown option.');
        }
      } catch (err) {
        console.error('✗ Error:', err.message);
      }
      console.log('');
    }
  } finally {
    rl.close();
  }
}

(async () => {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  if (!command) {
    if (process.stdin.isTTY && !flags.json) {
      await runInteractiveMenu(flags);
      process.exit(0);
    } else {
      printHelp();
      process.exit(0);
    }
  }

  if (command === 'setup' || command === 'auth') {
    const updates = {};
    if (flags.cookies && flags.encrypt) {
      const vaultPath = encryptCookiesVault(flags.cookies, process.env.X_USE_KEY);
      updates.vaultPath = vaultPath;
      updates.cookiesPath = null;
    } else if (flags.cookies) {
      updates.cookiesPath = path.resolve(flags.cookies);
      if (isInsecureFileMode(updates.cookiesPath) && !flags.json) {
        console.warn(`⚠ Warning: ${updates.cookiesPath} has group/world permissions. Run: chmod 600 "${updates.cookiesPath}"`);
      }
    }
    if (flags.proxy) updates.proxyUrl = flags.proxy;
    if (Object.keys(updates).length === 0) {
      console.log('Usage: xuse setup --cookies ./cookies.json [--proxy socks5h://127.0.0.1:10808]');
      process.exit(1);
    }
    const savedTo = saveConfig(updates);
    if (flags.json) {
      const safeUpdates = {
        ...updates,
        ...(updates.proxyUrl ? { proxyUrl: sanitizeProxyUrl(updates.proxyUrl) } : {})
      };
      console.log(JSON.stringify({ ok: true, data: { configPath: savedTo, ...safeUpdates } }, null, 2));
    } else {
      console.log('✓ Configuration saved to', savedTo);
    }
    process.exit(0);
  }

  const strictRateLimit = flags.strict || flags.json || !process.stdin.isTTY;

  try {
    if (command === 'breaker') {
      const result = new CircuitBreaker().getStatus();
      console.log(flags.json ? JSON.stringify({ ok: true, data: result }, null, 2) : result);
      return;
    }
    if (command === 'reset-breaker') {
      if (!process.stdin.isTTY || flags.json) {
        throw new Error(
          'Refusing to reset circuit breaker in non-interactive or --json mode. A human must run "xuse reset-breaker" in a terminal.'
        );
      }
      const result = new CircuitBreaker().reset();
      console.log(result);
      return;
    }
    if (command === 'limits') {
      const result = new RateLimiter().getStatus();
      console.log(flags.json ? JSON.stringify({ ok: true, data: result }, null, 2) : result);
      return;
    }
    if (command === 'reset-limits') {
      if (!process.stdin.isTTY || flags.json) {
        throw new Error(
          'Refusing to reset rate limits in non-interactive or --json mode. A human must run "xuse reset-limits" in a terminal.'
        );
      }
      const result = new RateLimiter().reset();
      console.log(result);
      return;
    }

    const client = new XUseClient({
      ...(flags.cookies ? { cookiesPath: flags.cookies } : {}),
      ...(flags.proxy ? { proxyUrl: flags.proxy } : {}),
      ...(strictRateLimit ? { strictRateLimit: true } : {})
    });

    let result;
    switch (command) {
      case 'check':
        await client.init();
        result = { ok: true, txReady: Boolean(client.transaction), proxy: sanitizeProxyUrl(client.proxyUrl) || 'direct' };
        break;
      case 'profile':
        if (!args[0]) throw new Error('Missing <username>');
        result = await client.getProfile(args[0]);
        delete result.raw;
        break;
      case 'tweet':
        if (!args[0]) throw new Error('Missing <text>');
        result = await client.createTweet(args.join(' '));
        delete result.raw;
        break;
      case 'reply':
        if (!args[0] || !args[1]) throw new Error('Usage: xuse reply <tweetId> <text>');
        result = await client.replyTweet(args[0], args.slice(1).join(' '));
        delete result.raw;
        break;
      case 'thread': {
        if (!args[0]) throw new Error('Missing <file.json>');
        const items = JSON.parse(fs.readFileSync(args[0], 'utf8'));
        const res = await client.postThread(items);
        result = res.map(({ raw, ...rest }) => rest);
        break;
      }
      case 'delete':
        if (!args[0]) throw new Error('Missing <tweetId>');
        result = await client.deleteTweet(args[0]);
        break;
      case 'like':
        if (!args[0]) throw new Error('Missing <tweetId>');
        result = await client.favoriteTweet(args[0]);
        break;
      case 'retweet':
        if (!args[0]) throw new Error('Missing <tweetId>');
        result = await client.retweet(args[0]);
        break;
      case 'tweets':
        if (!args[0]) throw new Error('Missing <username>');
        result = await client.getUserTweets(args[0], Number(args[1]) || 20);
        break;
      case 'reposts':
        if (!args[0]) throw new Error('Missing <username>');
        result = await client.getUserReposts(args[0], Number(args[1]) || 20);
        break;
      case 'search':
        if (!args[0]) throw new Error('Missing <query>');
        result = await client.searchTweets(args[0], Number(args[1]) || 20);
        break;
      case 'home':
        result = await client.getHomeTimeline(Number(args[0]) || 20);
        break;
      case 'explore':
        result = await client.getExplore(Number(args[0]) || 20);
        break;
      case 'read':
        if (!args[0]) throw new Error('Missing <tweetId>');
        result = await client.getTweet(args[0]);
        break;
      case 'notifications':
        result = await client.getNotifications(Number(args[0]) || 40);
        break;
      case 'badges':
        result = await client.getBadgeCounts();
        break;
      case 'suggest':
        if (!args[0]) throw new Error('Missing <query>');
        result = await client.searchTypeahead(args.join(' '));
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    if (flags.json) {
      const out = {
        ok: true,
        ...(client.lastEvent ? { event: client.lastEvent } : {}),
        data: result
      };
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(result);
    }
  } catch (err) {
    if (flags.json) {
      const payload = {
        ok: false,
        error: err.message,
        ...(err.halt ? { halt: true, actionRequired: 'STOP_AND_NOTIFY_USER' } : {}),
        ...(err.code === 'CIRCUIT_BREAKER_TRIPPED' ? { circuitBreakerTripped: true } : {}),
        ...(err.code === 'RATE_LIMIT_EXCEEDED'
          ? { rateLimitExceeded: true, retryAfterSeconds: err.retryAfterSeconds }
          : {}),
        ...(err.code === 'PACING_WAIT_REQUIRED'
          ? { halt: false, pacingWait: true, waitSeconds: err.waitSeconds }
          : {}),
        ...(Array.isArray(err.published)
          ? { published: err.published.map(({ raw, ...rest }) => rest) }
          : {})
      };
      console.error(JSON.stringify(payload, null, 2));
    } else {
      console.error('Error:', err.message);
    }
    const exitCode =
      err.code === 'PACING_WAIT_REQUIRED'
        ? 4
        : err.code === 'RATE_LIMIT_EXCEEDED'
          ? 2
          : err.code === 'CIRCUIT_BREAKER_TRIPPED'
            ? 3
            : 1;
    process.exit(exitCode);
  }
})();
