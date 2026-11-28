const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.x-use');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const VAULT_PATH = path.join(CONFIG_DIR, 'cookies.vault');

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

function isAllowedXDomain(domain) {
  if (!domain) return true;
  const clean = String(domain).toLowerCase().trim().replace(/^\.+/, '');
  return (
    clean === 'x.com' ||
    clean.endsWith('.x.com') ||
    clean === 'twitter.com' ||
    clean.endsWith('.twitter.com')
  );
}

/**
 * Resolve X authentication credentials from cookies array, cookies file, env vars, or saved config.
 * Filters cookie entries to X/Twitter domains when `domain` is specified, while permitting
 * domain-less cookie exports (e.g. minimal `[{ name, value }]` files).
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

  const vaultKey = config.vaultKey || process.env.X_USE_KEY || '';
  const vaultPath = config.vaultPath || VAULT_PATH;
  if (!cookies && vaultKey && fs.existsSync(vaultPath)) {
    cookies = decryptCookiesVault(vaultKey, vaultPath);
  }

  let cookieHeader = '';
  let ct0 = config.ct0 || saved.ct0 || '';
  let authToken = config.authToken || saved.authToken || '';

  if (Array.isArray(cookies) && cookies.length > 0) {
    const validCookies = cookies.filter(
      (c) => c && c.name && c.value !== undefined && isAllowedXDomain(c.domain)
    );
    cookieHeader = validCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const ct0Cookie = validCookies.find((c) => c.name === 'ct0');
    const authCookie = validCookies.find((c) => c.name === 'auth_token');
    ct0 = ct0Cookie ? ct0Cookie.value : ct0;
    authToken = authCookie ? authCookie.value : authToken;
  } else if (authToken && ct0) {
    cookieHeader = `auth_token=${authToken}; ct0=${ct0}`;
  } else {
    throw new Error(
      'Missing X authentication. Run `xuse setup` or provide --cookies / X_COOKIES_PATH / X_AUTH_TOKEN + X_CT0.'
    );
  }

  if (!authToken) {
    throw new Error('Missing `auth_token` session cookie in cookies or environment.');
  }
  if (!ct0) {
    throw new Error('Missing `ct0` CSRF token in cookies or environment.');
  }

  return { cookieHeader, ct0, authToken };
}

/**
 * Encrypt a browser cookies JSON file into ~/.x-use/cookies.vault using AES-256-GCM.
 */
function encryptCookiesVault(cookiesPath, passphrase, vaultPath = VAULT_PATH) {
  if (!passphrase) throw new Error('Passphrase (or X_USE_KEY) is required to encrypt cookies.');
  const raw = fs.readFileSync(path.resolve(cookiesPath), 'utf8');
  JSON.parse(raw); // validate JSON before storing

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const dir = path.dirname(vaultPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload = JSON.stringify({
    alg: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex')
  });
  fs.writeFileSync(vaultPath, payload, { mode: 0o600 });
  return vaultPath;
}

/**
 * Decrypt ~/.x-use/cookies.vault using AES-256-GCM.
 */
function decryptCookiesVault(passphrase, vaultPath = VAULT_PATH) {
  if (!passphrase) throw new Error('Passphrase (or X_USE_KEY) is required to decrypt cookies vault.');
  const blob = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  const key = crypto.scryptSync(passphrase, Buffer.from(blob.salt, 'hex'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'hex')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(decrypted);
}

/**
 * Check if a cookie file has group/world permissions on POSIX systems.
 */
function isInsecureFileMode(filePath) {
  try {
    const stat = fs.statSync(path.resolve(filePath));
    return (stat.mode & 0o077) !== 0;
  } catch (_) {
    return false;
  }
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  VAULT_PATH,
  loadSavedConfig,
  saveConfig,
  resolveCredentials,
  encryptCookiesVault,
  decryptCookiesVault,
  isInsecureFileMode
};
