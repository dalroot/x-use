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
   * @param {number} [options.maxErrors=2] - Consecutive errors before tripping.
   */
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.X_BREAKER_PATH || DEFAULT_BREAKER_PATH;
    this.maxErrors = Number(options.maxErrors) || MAX_CONSECUTIVE_ERRORS;
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return {
      consecutiveErrors: 0,
      tripped: false,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null
    };
  }

  _save(state) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
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
          `Last error: ${state.lastError}. ` +
          `Inspect the issue and run "xuse reset-breaker" (or client.resetCircuitBreaker()) before continuing.`
      );
      err.code = 'CIRCUIT_BREAKER_TRIPPED';
      err.halt = true;
      err.lastError = state.lastError;
      throw err;
    }
  }

  recordSuccess() {
    const state = this._load();
    return this._save({
      ...state,
      consecutiveErrors: 0,
      tripped: false,
      lastError: null,
      lastSuccessAt: new Date().toISOString()
    });
  }

  recordFailure(errorMessage) {
    const state = this._load();
    const consecutiveErrors = (state.consecutiveErrors || 0) + 1;
    const tripped = consecutiveErrors >= this.maxErrors;
    return this._save({
      ...state,
      consecutiveErrors,
      tripped,
      lastError: String(errorMessage || 'Unknown error'),
      lastErrorAt: new Date().toISOString()
    });
  }

  reset() {
    return this._save({
      consecutiveErrors: 0,
      tripped: false,
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: this._load().lastSuccessAt || null
    });
  }
}

module.exports = {
  CircuitBreaker,
  DEFAULT_BREAKER_PATH,
  MAX_CONSECUTIVE_ERRORS
};
