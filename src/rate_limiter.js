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

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Persistent disk-backed rate limiter & jittered spacer.
 * Cannot be bypassed across separate CLI invocations: every request increments
 * an exact eventId with ISO timestamp and enforces window caps + pacing.
 */
class RateLimiter {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Path to persist rate limit ledger.
   * @param {number} [options.maxReads=20] - Max read requests per 15-minute window.
   * @param {number} [options.maxWrites=5] - Max write requests per 60-minute window.
   * @param {boolean} [options.strict=false] - Halt instead of sleeping when pacing gap is not met.
   * @param {number} [options.minReadGapMs=3000]
   * @param {number} [options.maxReadGapMs=6000]
   * @param {number} [options.minWriteGapMs=15000]
   * @param {number} [options.maxWriteGapMs=30000]
   */
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.X_RATE_LIMIT_PATH || DEFAULT_RATE_LIMIT_PATH;
    this.maxReads = Number(options.maxReads) || DEFAULT_MAX_READS;
    this.maxWrites = Number(options.maxWrites) || DEFAULT_MAX_WRITES;
    this.strict = Boolean(options.strict);
    this.minReadGapMs = options.minReadGapMs ?? MIN_READ_GAP_MS;
    this.maxReadGapMs = options.maxReadGapMs ?? MAX_READ_GAP_MS;
    this.minWriteGapMs = options.minWriteGapMs ?? MIN_WRITE_GAP_MS;
    this.maxWriteGapMs = options.maxWriteGapMs ?? MAX_WRITE_GAP_MS;
  }

  _load(now = Date.now()) {
    let state = {
      lastEventId: 0,
      events: []
    };
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        state = {
          lastEventId: Number(parsed.lastEventId) || 0,
          events: Array.isArray(parsed.events) ? parsed.events : []
        };
      }
    } catch (_) {}

    // Prune events older than the largest window (60 min)
    const cutoff = now - WRITE_WINDOW_MS;
    state.events = state.events.filter((e) => e.tsMs >= cutoff);
    return state;
  }

  _save(state) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  }

  getStatus(now = Date.now()) {
    const state = this._load(now);
    const readCutoff = now - READ_WINDOW_MS;
    const writeCutoff = now - WRITE_WINDOW_MS;

    const recentReads = state.events.filter((e) => e.kind === 'read' && e.tsMs >= readCutoff);
    const recentWrites = state.events.filter((e) => e.kind === 'write' && e.tsMs >= writeCutoff);
    const lastEvent = state.events[state.events.length - 1] || null;

    return {
      lastEventId: state.lastEventId,
      lastEventAt: lastEvent ? lastEvent.timestamp : null,
      lastEventKind: lastEvent ? lastEvent.kind : null,
      lastEventTarget: lastEvent ? lastEvent.target : null,
      readsIn15m: recentReads.length,
      maxReads15m: this.maxReads,
      readsRemaining: Math.max(0, this.maxReads - recentReads.length),
      writesIn60m: recentWrites.length,
      maxWrites60m: this.maxWrites,
      writesRemaining: Math.max(0, this.maxWrites - recentWrites.length)
    };
  }

  /**
   * Enforce window caps and jittered pacing before sending a request,
   * and atomically record the new eventId + ISO timestamp.
   * @param {'GET'|'POST'|string} method
   * @param {string} target
   * @returns {Promise<{ eventId: number, timestamp: string, kind: 'read'|'write', waitedMs: number }>}
   */
  async acquire(method, target = '') {
    const kind = String(method || 'GET').toUpperCase() === 'GET' ? 'read' : 'write';
    let now = Date.now();
    let state = this._load(now);

    const windowMs = kind === 'read' ? READ_WINDOW_MS : WRITE_WINDOW_MS;
    const maxAllowed = kind === 'read' ? this.maxReads : this.maxWrites;
    const recent = state.events.filter((e) => e.kind === kind && e.tsMs >= now - windowMs);

    if (recent.length >= maxAllowed) {
      const oldestTs = recent[0].tsMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestTs + windowMs - now) / 1000));
      const err = new Error(
        `Safety rate limit reached (${recent.length}/${maxAllowed} ${kind} requests in window, lastEventId=#${state.lastEventId}). ` +
          `Halting to protect X account. Retry after ${retryAfterSeconds}s.`
      );
      err.code = 'RATE_LIMIT_EXCEEDED';
      err.halt = true;
      err.rateLimitExceeded = true;
      err.retryAfterSeconds = retryAfterSeconds;
      throw err;
    }

    // Enforce human-like pacing with random jitter since the last event of the same kind
    const lastSame = [...state.events].reverse().find((e) => e.kind === kind);
    let waitedMs = 0;
    if (lastSame) {
      const targetGap =
        kind === 'read'
          ? randomBetween(this.minReadGapMs, this.maxReadGapMs)
          : randomBetween(this.minWriteGapMs, this.maxWriteGapMs);
      const elapsed = now - lastSame.tsMs;
      if (elapsed < targetGap) {
        const waitNeeded = targetGap - elapsed;
        if (this.strict) {
          const err = new Error(
            `Strict pacing guard: ${kind} called ${elapsed}ms after event #${lastSame.eventId} (${lastSame.timestamp}). ` +
              `Wait at least ${Math.ceil(waitNeeded / 1000)}s before the next task.`
          );
          err.code = 'RATE_LIMIT_EXCEEDED';
          err.halt = true;
          err.rateLimitExceeded = true;
          err.retryAfterSeconds = Math.max(1, Math.ceil(waitNeeded / 1000));
          throw err;
        }
        await new Promise((r) => setTimeout(r, waitNeeded));
        waitedMs = waitNeeded;
        now = Date.now();
        state = this._load(now);
      }
    }

    const eventId = state.lastEventId + 1;
    const timestamp = new Date(now).toISOString();
    state.lastEventId = eventId;
    state.events.push({
      eventId,
      timestamp,
      tsMs: now,
      kind,
      target: String(target).slice(0, 120)
    });
    this._save(state);

    return { eventId, timestamp, kind, waitedMs };
  }
}

module.exports = {
  RateLimiter,
  DEFAULT_RATE_LIMIT_PATH,
  READ_WINDOW_MS,
  WRITE_WINDOW_MS,
  DEFAULT_MAX_READS,
  DEFAULT_MAX_WRITES
};
