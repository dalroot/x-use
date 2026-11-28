const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BREAKER_PATH = path.join(os.homedir(), '.x-use', 'circuit_breaker.json');
const MAX_CONSECUTIVE_ERRORS = 2;

/**
 * Persistent 2-error safety circuit breaker to protect X accounts from
 * repeated failing requests or automated retry loops.
 */
class CircuitBreaker {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Path to persist circuit breaker state.
   * @param {number} [options.maxErrors=2] - Consecutive errors before tripping (clamped <= 2).
   */
  constructor(options = {}) {
    this.filePath = options.filePath || DEFAULT_BREAKER_PATH;
    const requested = Number(options.maxErrors);
    this.maxErrors =
      Number.isFinite(requested) && requested > 0
        ? Math.min(MAX_CONSECUTIVE_ERRORS, Math.floor(requested))
        : MAX_CONSECUTIVE_ERRORS;
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      return {
        consecutiveErrors: 0,
        tripped: false,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      const corruptErr = new Error(
        `Safety circuit breaker state file is corrupted (${err.message}). Halting — notify the user to inspect.`
      );
      corruptErr.code = 'CIRCUIT_BREAKER_TRIPPED';
      corruptErr.halt = true;
      throw corruptErr;
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.tripped !== 'boolean') {
      const corruptErr = new Error(
        'Safety circuit breaker state file has invalid format. Halting — notify the user to inspect.'
      );
      corruptErr.code = 'CIRCUIT_BREAKER_TRIPPED';
      corruptErr.halt = true;
      throw corruptErr;
    }

    return parsed;
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

  getStatus() {
    return this._load();
  }

  assertReady() {
    const state = this._load();
    if (state.tripped) {
      const err = new Error(
        `Safety circuit breaker TRIPPED after ${state.consecutiveErrors} consecutive errors. ` +
          `Last error: ${state.lastError}. STOP and notify the user to inspect the issue.`
      );
      err.code = 'CIRCUIT_BREAKER_TRIPPED';
      err.halt = true;
      err.lastError = state.lastError;
      throw err;
    }
  }

  recordSuccess() {
    const state = this._load();
    // Never allow an in-flight older request to clear an already-tripped breaker;
    // only explicit human reset() may restore a tripped circuit breaker.
    if (state.tripped) {
      return state;
    }
    return this._save({
      ...state,
      consecutiveErrors: 0,
      tripped: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString()
    });
  }

  recordFailure(errorMessage, { immediate = false } = {}) {
    let state;
    try {
      state = this._load();
    } catch (_) {
      state = {
        consecutiveErrors: 0,
        tripped: true,
        lastError: null,
        lastErrorAt: null,
        lastSuccessAt: null
      };
    }
    const consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    const tripped = Boolean(immediate) || consecutiveErrors >= this.maxErrors;
    return this._save({
      ...state,
      consecutiveErrors,
      tripped,
      lastError: String(errorMessage || 'Unknown error'),
      lastErrorAt: new Date().toISOString()
    });
  }

  reset() {
    const prev = fs.existsSync(this.filePath)
      ? (() => {
          try {
            return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
          } catch (_) {
            return {};
          }
        })()
      : {};
    return this._save({
      consecutiveErrors: 0,
      tripped: false,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: prev.lastSuccessAt || null
    });
  }
}

module.exports = {
  CircuitBreaker,
  DEFAULT_BREAKER_PATH,
  MAX_CONSECUTIVE_ERRORS
};
