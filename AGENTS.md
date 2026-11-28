# AGENTS.md — x-use

Instructions for AI coding and CLI agents working in this repository or using `x-use` (`xuse` / `agent-x-use`).

## Using `x-use` as an Agent

Read [SKILL.md](./SKILL.md) completely before running any `xuse` command.

- Always pass `--json` when invoking the CLI.
- Never ask for, print, log, or commit user X cookies (`auth_token`, `ct0`), `X_USE_KEY`, or proxy credentials.
- Run one command at a time; never run concurrent `xuse` commands.
- Always ask the user for explicit confirmation before any write operation (`tweet`, `reply`, `thread`, `like`, `retweet`, `delete`).
- Respect exit codes:
  - `0`: Success
  - `4`: Pacing wait (`pacingWait: true`) — wait `waitSeconds` and retry once
  - `2` / `3`: Rate limit or circuit breaker tripped (`halt: true`) — stop immediately and report to the user; never run `reset-breaker` or `reset-limits`

## Developing in This Repository

- **Runtime:** Node.js `>=20.19.0`.
- **Tests:** Run `npm test` after every code or doc change; all tests must pass (`node --check` + `node --test test/x-use.test.js`).
- **Security:** Never commit cookie files, `.pem` keys, tokens, or local user paths. Keep private vault file permissions at `0600`.
- **Anti-ban Fidelity:** Never add automatic retry loops on failed X GraphQL requests.
