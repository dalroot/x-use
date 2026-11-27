const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.x-use');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/**
 * Load saved user configuration from ~/.x-use/config.json if present.
 */
function loadSavedConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (_) {}
  return {};
}

/**
 * Persist user configuration to ~/.x-use/config.json with owner-only permissions.
 */
function saveConfig(newConfig) {
  const current = loadSavedConfig();
  const merged = { ...current, ...newConfig };
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return CONFIG_PATH;
}

/**
 * Resolve X authentication credentials from cookies array, cookies file, env vars, or saved config.
 * @param {Object} config
 * @returns {{ cookieHeader: string, ct0: string, authToken: string }}
 */
function resolveCredentials(config) {
  const saved = loadSavedConfig();
  let cookies = config.cookiesInput;
  const cookiesPath = config.cookiesPath || saved.cookiesPath || null;

  if (!cookies && cookiesPath) {
    const resolved = path.resolve(cookiesPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Cookies file not found: ${resolved}`);
    }
    cookies = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  let cookieHeader = '';
  let ct0 = config.ct0 || saved.ct0 || '';
  let authToken = config.authToken || saved.authToken || '';

  if (Array.isArray(cookies) && cookies.length > 0) {
    cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const ct0Cookie = cookies.find((c) => c.name === 'ct0');
    const authCookie = cookies.find((c) => c.name === 'auth_token');
    ct0 = ct0Cookie ? ct0Cookie.value : ct0;
    authToken = authCookie ? authCookie.value : authToken;
  } else if (authToken && ct0) {
    cookieHeader = `auth_token=${authToken}; ct0=${ct0}`;
  } else {
    throw new Error(
      'Missing X authentication. Run `xuse setup` or provide --cookies / X_COOKIES_PATH / X_AUTH_TOKEN + X_CT0.'
    );
  }

  if (!ct0) {
    throw new Error('Missing `ct0` CSRF token in cookies or environment.');
  }

  return { cookieHeader, ct0, authToken };
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  loadSavedConfig,
  saveConfig,
  resolveCredentials
};
