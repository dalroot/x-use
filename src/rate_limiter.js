const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_RATE_LIMIT_PATH = path.join(os.homedir(), '.x-use', 'rate_limit.json');

const READ_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const WRITE_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_MAX_READS = 20;
const DEFAULT_MAX_WRITES = 5;
const MIN_READ_GAP_MS = 3000;
const MAX_READ_GAP_MS = 6000;
const MIN_WRITE_GAP_MS = 15000;
const MAX_WRITE_GAP_MS = 30000;
const LOCK_STALE_MS = 30000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60 * 1000; // 2 minutes local clock-rollback tolerance

const inProcessQueues = new Map();

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persistent disk-backed rate limiter & jittered spacer.
 * Serializes concurrent calls across both Promise.all and separate CLI processes
 * using an async queue + lockfile + atomic temp-rename writes.
 */
class RateLimiter {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Path to persist rate limit ledger.
   * @param {number} [options.maxReads=20] - Max read requests per 15-minute window (clamped <= 20).
   * @param {number} [options.maxWrites=5] - Max write requests per 60-minute window (clamped <= 5).
   * @param {boolean} [options.strict=false] - Reject immediately when pacing gap is not met.
   * @param {number} [options.minReadGapMs=3000] - Clamped >= 3000ms.
   * @param {number} [options.maxReadGapMs=6000]
   * @param {number} [options.minWriteGapMs=15000] - Clamped >= 15000ms.
   * @param {number} [options.maxWriteGapMs=30000]
   */
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_RATE_LIMIT_PATH;

    const reqReads = Number(options.maxReads);
    this.maxReads =
      Number.isFinite(reqReads) && reqReads > 0
        ? Math.min(DEFAULT_MAX_READS, Math.floor(reqReads))
        : DEFAULT_MAX_READS;

    const reqWrites = Number(options.maxWrites);
    this.maxWrites =
      Number.isFinite(reqWrites) && reqWrites > 0
        ? Math.min(DEFAULT_MAX_WRITES, Math.floor(reqWrites))
        : DEFAULT_MAX_WRITES;

    this.strict = Boolean(options.strict);

    const reqMinRead = options.minReadGapMs ?? MIN_READ_GAP_MS;
    this.minReadGapMs = Math.max(MIN_READ_GAP_MS, Number.isFinite(Number(reqMinRead)) ? Number(reqMinRead) : MIN_READ_GAP_MS);
    const reqMaxRead = options.maxReadGapMs ?? MAX_READ_GAP_MS;
    this.maxReadGapMs = Math.max(this.minReadGapMs, Number.isFinite(Number(reqMaxRead)) ? Number(reqMaxRead) : MAX_READ_GAP_MS);

    const reqMinWrite = options.minWriteGapMs ?? MIN_WRITE_GAP_MS;
    this.minWriteGapMs = Math.max(MIN_WRITE_GAP_MS, Number.isFinite(Number(reqMinWrite)) ? Number(reqMinWrite) : MIN_WRITE_GAP_MS);
    const reqMaxWrite = options.maxWriteGapMs ?? MAX_WRITE_GAP_MS;
    this.maxWriteGapMs = Math.max(this.minWriteGapMs, Number.isFinite(Number(reqMaxWrite)) ? Number(reqMaxWrite) : MAX_WRITE_GAP_MS);
  }

  _createRateError(message, retryAfterSeconds, { code = 'RATE_LIMIT_EXCEEDED', halt = true } = {}) {
    const err = new Error(message);
    err.code = code;
    err.halt = halt;
    err.rateLimitExceeded = code === 'RATE_LIMIT_EXCEEDED';
    err.pacingWait = code === 'PACING_WAIT_REQUIRED';
    if (retryAfterSeconds !== undefined) {
      err.retryAfterSeconds = retryAfterSeconds;
      if (code === 'PACING_WAIT_REQUIRED') {
        err.waitSeconds = retryAfterSeconds;
      }
    }
    return err;
  }

  _load(now = Date.now()) {
    if (!fs.existsSync(this.filePath)) {
      return {
        lastEventId: 0,
        lastTsMs: 0,
        cooldownUntilMs: 0,
        events: []
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      throw this._createRateError(
        `Rate limit ledger is corrupted (${err.message}). Halting to protect X account.`
      );
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events) || typeof parsed.lastEventId !== 'number') {
      throw this._createRateError(
        'Rate limit ledger has invalid structure. Halting to protect X account.'
      );
    }

    const lastTsMs = Number(parsed.lastTsMs) || parsed.events.reduce((m, e) => Math.max(m, Number(e.tsMs) || 0), 0);
    if (lastTsMs > 0 && lastTsMs - now > CLOCK_ROLLBACK_TOLERANCE_MS) {
      throw this._createRateError(
        `System clock rollback detected (now=${new Date(now).toISOString()} < last=${new Date(lastTsMs).toISOString()}). Halting to protect X account.`
      );
    }

    const cutoff = now - WRITE_WINDOW_MS;
    return {
      lastEventId: parsed.lastEventId,
      lastTsMs,
      cooldownUntilMs: Number(parsed.cooldownUntilMs) || 0,
      events: parsed.events.filter((e) => Number(e.tsMs) >= cutoff)
    };
  }

  _save(state) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    return state;
  }

  async _withLock(fn) {
    const prev = inProcessQueues.get(this.filePath) || Promise.resolve();
    let releaseQueue;
    const next = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    inProcessQueues.set(this.filePath, next);
    await prev;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + 15000;
    let lockFd = null;

    try {
      while (lockFd === null) {
        try {
          lockFd = fs.openSync(lockPath, 'wx', 0o600);
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch (_) {}
          if (Date.now() > deadline) {
            throw this._createRateError('Timed out waiting for rate-limit lockfile. Halting.');
          }
          await sleep(15);
        }
      }
      return await fn();
    } finally {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
        } catch (_) {}
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {}
      }
      releaseQueue();
    }
  }

  async recordCooldown(seconds) {
    const sec = Math.max(1, Math.ceil(Number(seconds) || 60));
    return this._withLock(async () => {
      const now = Date.now();
      const state = this._load(now);
      const until = now + sec * 1000;
      if (until > (state.cooldownUntilMs || 0)) {
        state.cooldownUntilMs = until;
        this._save(state);
      }
      return state;
    });
  }

  /**
   * Reset cooldown and window history while keeping monotonic lastEventId.
   * Intended strictly for human operator recovery from an interactive TTY.
   */
  reset() {
    let prevId = 0;
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        prevId = Number(parsed?.lastEventId) || 0;
      }
    } catch (_) {}
    return this._save({
      lastEventId: prevId,
      lastTsMs: 0,
      cooldownUntilMs: 0,
      events: []
    });
  }

  getStatus(now = Date.now()) {
    const state = this._load(now);
    const readCutoff = now - READ_WINDOW_MS;
    const writeCutoff = now - WRITE_WINDOW_MS;

    const recentReads = state.events.filter((e) => e.kind === 'read' && e.tsMs >= readCutoff);
    const recentWrites = state.events.filter((e) => e.kind === 'write' && e.tsMs >= writeCutoff);
    const lastEvent = state.events[state.events.length - 1] || null;
    const cooldownRemainingSeconds =
      state.cooldownUntilMs && state.cooldownUntilMs > now
        ? Math.ceil((state.cooldownUntilMs - now) / 1000)
        : 0;

    return {
      lastEventId: state.lastEventId,
      lastEventAt: lastEvent ? lastEvent.timestamp : null,
      lastEventKind: lastEvent ? lastEvent.kind : null,
      lastEventTarget: lastEvent ? lastEvent.target : null,
      cooldownRemainingSeconds,
      readsIn15m: recentReads.length,
      maxReads15m: this.maxReads,
      readsRemaining: Math.max(0, this.maxReads - recentReads.length),
      writesIn60m: recentWrites.length,
      maxWrites60m: this.maxWrites,
      writesRemaining: Math.max(0, this.maxWrites - recentWrites.length)
    };
  }

  /**
   * Enforce cooldowns, window caps, and jittered pacing before sending a request,
   * and atomically record the new eventId + ISO timestamp.
   * Re-validates state after any pacing sleep so concurrent callers cannot burst.
   * @param {'GET'|'POST'|string} method
   * @param {string} [operationName] - Operation identifier only (no URLs or queries).
   * @param {Object} [acquireOpts]
   * @param {boolean} [acquireOpts.bypassPacing=false] - Skip pacing gap (still counts toward quota and eventId).
   * @param {boolean} [acquireOpts.isInit=false] - Mark session init request so primary request is not blocked by it.
   * @returns {Promise<{ eventId: number, timestamp: string, kind: 'read'|'write', waitedMs: number }>}
   */
  async acquire(method, operationName = '', acquireOpts = {}) {
    const kind = String(method || 'GET').toUpperCase() === 'GET' ? 'read' : 'write';
    const windowMs = kind === 'read' ? READ_WINDOW_MS : WRITE_WINDOW_MS;
    const maxAllowed = kind === 'read' ? this.maxReads : this.maxWrites;
    const bypassPacing = Boolean(acquireOpts.bypassPacing);
    const isInit = Boolean(acquireOpts.isInit);
    const isStrict = acquireOpts.strict !== undefined ? Boolean(acquireOpts.strict) : this.strict;
    let totalWaitedMs = 0;

    while (true) {
      const outcome = await this._withLock(async () => {
        const now = Date.now();
        const state = this._load(now);

        if (state.cooldownUntilMs && now < state.cooldownUntilMs) {
          const retryAfterSeconds = Math.max(1, Math.ceil((state.cooldownUntilMs - now) / 1000));
          throw this._createRateError(
            `Rate-limit cooldown active from server 429 response. Retry after ${retryAfterSeconds}s.`,
            retryAfterSeconds
          );
        }

        const recent = state.events.filter((e) => e.kind === kind && e.tsMs >= now - windowMs);
        if (recent.length >= maxAllowed) {
          const oldestTs = recent[0].tsMs;
          const retryAfterSeconds = Math.max(1, Math.ceil((oldestTs + windowMs - now) / 1000));
          throw this._createRateError(
            `Safety rate limit reached (${recent.length}/${maxAllowed} ${kind} requests in window, lastEventId=#${state.lastEventId}). ` +
              `Halting to protect X account. Retry after ${retryAfterSeconds}s.`,
            retryAfterSeconds
          );
        }

        const lastSame = bypassPacing
          ? null
          : [...state.events].reverse().find((e) => e.kind === kind && !e.isInit);
        if (lastSame) {
          const targetGap =
            kind === 'read'
              ? randomBetween(this.minReadGapMs, this.maxReadGapMs)
              : randomBetween(this.minWriteGapMs, this.maxWriteGapMs);
          const elapsed = now - lastSame.tsMs;
          if (elapsed < targetGap) {
            const waitNeeded = targetGap - elapsed;
            if (isStrict) {
              const waitSeconds = Math.max(1, Math.ceil(waitNeeded / 1000));
              throw this._createRateError(
                `Pacing guard: ${kind} called ${elapsed}ms after event #${lastSame.eventId} (${lastSame.timestamp}). ` +
                  `Wait ${waitSeconds}s before the next request.`,
                waitSeconds,
                { code: 'PACING_WAIT_REQUIRED', halt: false }
              );
            }
            return { waitNeeded };
          }
        }

        const eventId = state.lastEventId + 1;
        const timestamp = new Date(now).toISOString();
        state.lastEventId = eventId;
        state.lastTsMs = now;
        state.events.push({
          eventId,
          timestamp,
          tsMs: now,
          kind,
          ...(isInit ? { isInit: true } : {}),
          target: String(operationName || kind).slice(0, 40)
        });
        this._save(state);
        return { acquired: { eventId, timestamp, kind, waitedMs: totalWaitedMs } };
      });

      if (outcome.acquired) {
        return outcome.acquired;
      }
      await sleep(outcome.waitNeeded);
      totalWaitedMs += outcome.waitNeeded;
    }
  }
}

module.exports = {
  RateLimiter,
  DEFAULT_RATE_LIMIT_PATH,
  READ_WINDOW_MS,
  WRITE_WINDOW_MS,
  DEFAULT_MAX_READS,
  DEFAULT_MAX_WRITES,
  MIN_READ_GAP_MS,
  MIN_WRITE_GAP_MS
};
