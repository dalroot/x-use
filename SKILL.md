---
name: x-use
description: Browserless X (Twitter) CLI and SDK for AI agents. Use to read timelines, search, fetch tweets by URL, watch notifications safely, and publish tweets/threads/replies without Chrome or Puppeteer.
---

# x-use (Agent X Use)

Fast, browserless X (Twitter) automation over pure HTTPS (`api.x.com` + `x.com` GraphQL) with a built-in **2-error safety circuit breaker**.

## Authentication & Cookie Security

Provide one of:
- **Encrypted vault (Recommended):**
  ```bash
  export X_USE_KEY="your-strong-passphrase"
  xuse setup --cookies ./cookies.json --encrypt
  # Delete plaintext ./cookies.json afterward; vault is stored at ~/.x-use/cookies.vault (0600)
  ```
- **Plaintext cookies file (owner-only `chmod 600`):** `X_COOKIES_PATH=/path/to/cookies.json` or `--cookies`
- **Direct tokens:** `X_AUTH_TOKEN` + `X_CT0` environment variables

Optional proxy:
- `X_PROXY_URL=socks5h://127.0.0.1:10808` (or `--proxy <url>`)

## Safety Circuit Breaker & Rate Limiter (Mandatory)

- **Persistent Rate Limiter (`~/.x-use/rate_limit.json`):** Every request is logged on disk (`0600`) with an incrementing `eventId` and ISO timestamp — cannot be bypassed across CLI calls.
  - Window caps: max **20 reads / 15m** (`3–6s` jittered gap), max **5 writes / 60m** (`15–30s` jittered gap).
  - If given multiple tasks (e.g., 10 tasks), **execute them discretely with delays**, never in a parallel burst.
  - Check remaining budget anytime with `xuse limits --json`, or pass `--strict` to fail immediately instead of waiting.
- **2-Error Circuit Breaker (`~/.x-use/circuit_breaker.json`):** After **2 consecutive errors**, all further requests are blocked.
- **Agent Halt Rule:** If `--json` returns `"halt": true` (`"circuitBreakerTripped": true` or `"rateLimitExceeded": true`), you MUST **STOP immediately**, NEVER retry or bypass, and report the exact `error` (and `retryAfterSeconds` if present) to the user.
  ```bash
  xuse limits --json
  xuse breaker --json
  xuse reset-breaker --json
  ```

## Security & Privacy

- **Explicit Credentials Only:** `x-use` never scans or reads browser profile directories. It only uses credentials explicitly supplied by the user (`--cookies`, `X_COOKIES_PATH`, `X_AUTH_TOKEN`+`X_CT0`, or the local `AES-256-GCM` vault `~/.x-use/cookies.vault` unlocked by `X_USE_KEY`).
- **Strict Destination Isolation:** Credentials are only sent to `x.com` and `api.x.com` and are never logged or included in `--json` outputs.
- **No Background Polling:** Notification checks (`xuse badges`, `xuse notifications`) are strictly on-demand; no background timer loops are started.

## Agent CLI Commands (Always pass `--json`)

### Read & Discovery (`api.x.com` `x-web` GraphQL)
```bash
# Verify session & proxy
xuse check --json

# Fetch public profile metadata
xuse profile <username> --json

# Search tweets
xuse search "query" 20 --json

# Fetch user's original tweets or reposts
xuse tweets <username> 20 --json
xuse reposts <username> 20 --json

# Read a single tweet by full URL or numeric ID (extracts text, author, stats, links)
xuse read https://x.com/user/status/1234567890 --json

# Fetch Home timeline (TL) or Explore feed
xuse home 20 --json
xuse explore 20 --json

# Search autocomplete suggestions
xuse suggest "keyword" --json
```

### On-Demand Notifications (No Timer Polling)
```bash
# Check ~100B unread counter before querying full notifications
xuse badges --json

# Fetch notifications only when unread > 0
xuse notifications 20 --json
```

### Write Actions (Never auto-retried)
```bash
xuse tweet "Hello from x-use" --json
xuse reply <tweet_id> "Reply text" --json
xuse thread ./thread.json --json
xuse like <tweet_id> --json
xuse retweet <tweet_id> --json
xuse delete <tweet_id> --json
```
