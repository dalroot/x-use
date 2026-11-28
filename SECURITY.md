# Security Policy

## Reporting a Vulnerability

Please do **not** open public GitHub issues for security vulnerabilities, credential handling flaws, or leaked secrets.

Instead, report security issues privately by contacting the maintainer via GitHub Security Advisories (`Security -> Advisories -> Report a vulnerability` on this repository).

Please include:
- A clear description of the issue and affected file/version.
- Steps to reproduce or a minimal offline proof of concept (using **fake** credentials only — never send real cookies, tokens, or HAR files).

## Security & Trust Model

- **Local Cookie Vault:** `~/.x-use/cookies.vault` encrypts cookies at rest with AES-256-GCM and a per-vault random salt/IV derived via `scryptSync`. This protects credentials at rest on disk against external readers; any process sharing the environment where `X_USE_KEY` is exported (such as an AI agent) can decrypt the vault.
- **No Credential Leakage:** `auth_token`, `ct0`, and proxy credentials (`user:pass@`) must never appear in stdout, stderr, `--json` outputs, rate-limit ledgers, or git history.
- **Secret Rotation:** If X cookies or tokens are ever exposed or committed, log out of all active X sessions immediately to invalidate them. Removing files from git history alone is insufficient.
- **Safety Guards:** Rate limits and the fail-closed circuit breaker mitigate accidental automation bursts and runaway loops, not adversarial local root/shell access.
