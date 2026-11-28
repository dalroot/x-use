---
name: x-use
description: Browserless X (Twitter) CLI and SDK for AI agents. Use to read timelines, search, fetch tweets by URL, check notifications on demand, and publish tweets/threads/replies without Chrome or Puppeteer.
---

# x-use (Agent X Use)

Fast, browserless X (Twitter) automation over pure HTTPS (`api.x.com` + `x.com` GraphQL) with a built-in **safety circuit breaker** and **persistent rate limiter**.

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

- **Persistent Rate Limiter (`~/.x-use/rate_limit.json`):** Every request is logged on disk (`0600`) with an incrementing `eventId` and ISO timestamp.
  - Window caps: max **50 reads / 15m** (`3–6s` jittered gap), max **15 writes / 60m** (`15–30s` jittered gap).
  - If given multiple tasks (e.g., 10 tasks), **execute them discretely with delays**, never in a parallel burst.
  - In `--json` or non-TTY mode, `--strict` is active by default so pacing gaps exit with code **4** and `{"ok":false,"halt":false,"pacingWait":true,"waitSeconds":N}` instead of blocking. If you receive `pacingWait: true`, wait `waitSeconds` seconds and retry the exact same command **once at most**.
  - Thread duration note: `xuse thread` spaces writes by 15–30s internally to complete the confirmed thread cleanly, so multi-tweet threads can take a few minutes (allow a higher command timeout instead of assuming it hung).
  - Check remaining budget anytime with `xuse limits --json`.
- **Safety Circuit Breaker (`~/.x-use/circuit_breaker.json`):** Trips immediately on `401`/`403`/`429` or account-restriction GraphQL errors, or after **2 consecutive errors**, blocking all further requests.
- **Exit Codes & Agent Halt Rule:**
  - `0` = success, `1` = general error, `2` = rate-limit quota exhausted (`halt: true`), `3` = circuit breaker tripped (`halt: true`), `4` = short pacing wait (`halt: false`, `pacingWait: true`).
  - If `--json` returns `"halt": true` (`"circuitBreakerTripped": true` or `"rateLimitExceeded": true`), you MUST **STOP immediately**, NEVER retry or bypass, and report the exact `error` (and `retryAfterSeconds` if present) to the user.
  - **NEVER** inspect, edit, or delete `~/.x-use/` state files, and **NEVER** attempt to reset the circuit breaker or rate limits. Only a human user can reset them from an interactive terminal.
  - **Write Confirmation Rule:** Read operations are safe for autonomous execution; write operations (`tweet`, `reply`, `thread`, `like`, `retweet`, `delete`) MUST only be executed with explicit user confirmation.
  ```bash
  xuse limits --json
  xuse breaker --json
  ```

## Security & Privacy

- **Explicit Credentials Only:** `x-use` never scans or reads browser profile directories. It only uses credentials explicitly supplied by the user (`--cookies`, `X_COOKIES_PATH`, `X_AUTH_TOKEN`+`X_CT0`, or the local `AES-256-GCM` vault `~/.x-use/cookies.vault` unlocked by `X_USE_KEY`).
- **Security Model Note:** The encrypted vault protects cookies at rest on disk against external readers, not against an agent running in the same environment where `X_USE_KEY` is already exported.
- **Strict Destination Isolation:** Credentials are only sent to `x.com` and `api.x.com` and are never logged or included in `--json` outputs.
- **No Background Polling:** Notification checks (`xuse badges`, `xuse notifications`) are strictly on-demand; no background timer loops are started.
- **Unofficial API Risk:** `x-use` uses X's unofficial web/GraphQL API; excessive or automated usage may still trigger X account restrictions.

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

### Write Actions (Require explicit user confirmation; never auto-retried)
```bash
xuse tweet "Hello from x-use" --json
xuse reply <tweet_id> "Reply text" --json
xuse thread ./thread.json --json
xuse like <tweet_id> --json
xuse retweet <tweet_id> --json
xuse delete <tweet_id> --json
```
