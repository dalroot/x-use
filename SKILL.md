---
name: x-use
description: Browserless X (Twitter) CLI and SDK for AI agents. Use to publish tweets, threads, replies, and fetch profiles without launching Chrome or Puppeteer.
---

# x-use (Agent X Use)

Fast, browserless X (Twitter) automation over pure HTTPS.

## Authentication

Provide either:
- `X_COOKIES_PATH=/path/to/cookies.json` (exported browser cookie JSON array containing `auth_token` and `ct0`)
- OR `X_AUTH_TOKEN` + `X_CT0` environment variables

Optional proxy:
- `X_PROXY_URL=socks5h://127.0.0.1:10808` (or `--proxy <url>`)

## Agent CLI Commands (Always pass `--json`)

```bash
# Verify session
x-use check --json

# Fetch user profile
x-use profile <username> --json

# Post a single tweet
x-use tweet "Hello from x-use" --json

# Reply to a tweet
x-use reply <tweet_id> "Reply text" --json

# Post a thread from a JSON array of strings
x-use thread ./thread.json --json

# Delete a tweet
x-use delete <tweet_id> --json
```
