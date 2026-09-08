'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');
const { baseDomain } = require('./net-privacy');

/**
 * The password vault.
 *
 * Deliberately the one thing in Veil that survives a restart, because a
 * password manager that forgets is not a password manager. Everything else
 * about it is built to keep that exception narrow:
 *
 *   - entries live in a single AES-256-GCM blob; the plaintext never touches disk
 *   - the key comes from your master password via PBKDF2-SHA512, 600k rounds
 *   - the derived key exists only in main-process memory while unlocked
 *   - passwords are never handed to page JavaScript; the preload writes them
 *     straight into the form fields, and only for a matching site
 */

const KDF_ITERATIONS = 600000;
const KEY_LEN = 32;

function now() { return Date.now(); }

function randomId() { return crypto.randomBytes(9).toString('base64url'); }

function deriveKey(master, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(master), salt, KDF_ITERATIONS, KEY_LEN, 'sha512',
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(key, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const AMBIGUOUS = 'Il1O0';
const SETS = {
  lower: 'abcdefghijkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?'
};

class Vault {
  constructor(settings) {
    this.settings = settings;
    this.file = path.join(app.getPath('userData'), 'vault.enc');
    this.keyFile = path.join(app.getPath('userData'), 'vault.key');
    this.key = null;         // Buffer while unlocked, null otherwise
    this.entries = null;     // decrypted entries while unlocked
    this.lockTimer = null;
  }

  exists() { try { return fs.existsSync(this.file); } catch { return false; } }
  unlocked() { return !!this.key; }

  /**
   * A vault can be protected two ways: by a master password, or - so that
   * saving a login needs no setup at all - by a random key that only the OS
   * keystore holds. The envelope records which.
   */
  hasMaster() {
    try { return this.readEnvelope().hasMaster !== false; } catch { return false; }
  }

  state() {
    return {
      exists: this.exists(),
      unlocked: this.unlocked(),
      count: this.entries ? this.entries.length : 0,
      quickUnlock: this.hasQuickUnlock(),
      hasMaster: this.exists() ? this.hasMaster() : false,
      autofill: !!this.settings.get('passwords.autofill', true),
      autoSave: !!this.settings.get('passwords.autoSave', true)
    };
  }

  hasQuickUnlock() { try { return fs.existsSync(this.keyFile); } catch { return false; } }

  readEnvelope() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  /* --------------------------------------------------------- lifecycle */

  async create(master) {
    if (!master || String(master).length < 8) throw new Error('Use at least 8 characters');
    if (this.exists()) throw new Error('A vault already exists');
    const salt = crypto.randomBytes(32);
    this.key = await deriveKey(master, salt);
    this.entries = [];
    this.writeAll(salt, true);
    this.armAutoLock();
    return this.state();
  }

  /**
   * Create a vault with no master password, the key held only by the OS
   * keystore. This is what lets the first saved login happen silently instead
   * of interrupting the user to invent a passphrase. It is the same protection
   * Chrome and Edge give saved passwords on Windows: anyone who can sign in as
   * you can read them. A master password can be added later.
   */
  createAuto() {
    if (this.exists()) throw new Error('A vault already exists');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keystore is unavailable');
    this.key = crypto.randomBytes(KEY_LEN);
    this.entries = [];
    this.writeAll(crypto.randomBytes(32), false);
    fs.writeFileSync(this.keyFile, safeStorage.encryptString(this.key.toString('base64')));
    this.armAutoLock();
    return this.state();
  }

  async unlock(master) {
    if (!this.exists()) throw new Error('No vault yet');
    const env = this.readEnvelope();
    if (env.hasMaster === false) {
      throw new Error('This vault has no master password - it opens with your Windows account');
    }
    const key = await deriveKey(master, Buffer.from(env.salt, 'base64'));
    let json;
    try {
      json = decrypt(key, env);
    } catch {
      throw new Error('Wrong master password');
    }
    this.key = key;
    this.entries = JSON.parse(json);
    this.armAutoLock();
    return this.state();
  }

  /**
   * Optional convenience: wrap the derived key with the OS keystore (DPAPI on
   * Windows) so the vault opens with the Windows account instead of the master
   * password. Anyone who can log in as you can then read it - which is the
   * trade the user is explicitly making when they turn this on.
   */
  enableQuickUnlock() {
    if (!this.key) throw new Error('Unlock the vault first');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keystore is unavailable');
    fs.writeFileSync(this.keyFile, safeStorage.encryptString(this.key.toString('base64')));
    return this.state();
  }

  disableQuickUnlock() {
    // Without a master password the OS keystore is the only way in; removing it
    // would lock the vault permanently.
    if (this.exists() && !this.hasMaster()) {
      throw new Error('Add a master password first, or this vault could never be opened again');
    }
    try { fs.unlinkSync(this.keyFile); } catch {}
    return this.state();
  }

  quickUnlock() {
    if (!this.hasQuickUnlock()) throw new Error('Windows unlock is not set up');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keystore is unavailable');
    const key = Buffer.from(safeStorage.decryptString(fs.readFileSync(this.keyFile)), 'base64');
    const env = this.readEnvelope();
    let json;
    try { json = decrypt(key, env); } catch { throw new Error('Stored key no longer matches the vault'); }
    this.key = key;
    this.entries = JSON.parse(json);
    this.armAutoLock();
    return this.state();
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.entries = null;
    clearTimeout(this.lockTimer);
    return this.state();
  }

  armAutoLock() {
    clearTimeout(this.lockTimer);
    const mins = Number(this.settings.get('passwords.autoLockMinutes', 15)) || 0;
    if (mins > 0) this.lockTimer = setTimeout(() => this.lock(), mins * 60000);
  }

  /** Sets a master password, or changes an existing one. */
  async changeMaster(current, next) {
    if (this.hasMaster()) await this.unlock(current);
    else this.requireOpen();          // no master yet: must already be open
    if (!next || String(next).length < 8) throw new Error('Use at least 8 characters');
    const salt = crypto.randomBytes(32);
    this.key = await deriveKey(next, salt);
    this.writeAll(salt, true);
    if (this.hasQuickUnlock()) this.enableQuickUnlock();
    return this.state();
  }

  /* ------------------------------------------------------------ storage */

  writeAll(saltBuf, hasMaster) {
    let salt;
    let master;
    if (saltBuf) {
      salt = saltBuf.toString('base64');
      master = hasMaster;
    } else {
      const prev = this.readEnvelope();
      salt = prev.salt;
      master = prev.hasMaster !== false;
    }
    const blob = encrypt(this.key, JSON.stringify(this.entries));
    const env = {
      v: 1,
      kdf: master ? 'pbkdf2-sha512' : 'random',
      iterations: KDF_ITERATIONS,
      hasMaster: !!master,
      salt,
      ...blob
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(env), 'utf8');
  }

  requireOpen() {
    if (!this.key) throw new Error('The vault is locked');
    this.armAutoLock();
  }

  /* ------------------------------------------------------------ entries */

  /** Never includes passwords. */
  list() {
    this.requireOpen();
    return this.entries
      .map(e => ({
        id: e.id, title: e.title, origin: e.origin, username: e.username,
        notes: e.notes || '', updated: e.updated, hasPassword: !!e.password
      }))
      .sort((a, b) => (a.title || a.origin).localeCompare(b.title || b.origin));
  }

  reveal(id) {
    this.requireOpen();
    const e = this.entries.find(x => x.id === id);
    if (!e) throw new Error('No such entry');
    return e.password;
  }

  save(entry) {
    this.requireOpen();
    const origin = originOf(entry.origin) || String(entry.origin || '').trim();
    if (!origin) throw new Error('A site address is required');
    if (!entry.username && !entry.password) throw new Error('Nothing to save');

    if (entry.id) {
      const e = this.entries.find(x => x.id === entry.id);
      if (!e) throw new Error('No such entry');
      Object.assign(e, {
        title: entry.title || e.title,
        origin,
        username: entry.username,
        notes: entry.notes || '',
        updated: now()
      });
      if (entry.password) e.password = entry.password;
    } else {
      this.entries.push({
        id: randomId(),
        title: entry.title || hostOf(origin).replace(/^www\./, ''),
        origin,
        username: entry.username || '',
        password: entry.password || '',
        notes: entry.notes || '',
        created: now(),
        updated: now()
      });
    }
    this.writeAll();
    return this.list();
  }

  remove(id) {
    this.requireOpen();
    const i = this.entries.findIndex(x => x.id === id);
    if (i >= 0) { this.entries.splice(i, 1); this.writeAll(); }
    return this.list();
  }

  /* ----------------------------------------------------------- autofill */

  /**
   * Candidates for a page, as identity only - no passwords cross this line.
   * Matching is on the registrable domain, the same rule browsers use, so a
   * login saved on accounts.example.com works on example.com but never leaks
   * to example.evil.com.
   */
  candidates(pageUrl) {
    if (!this.key) return [];
    const host = hostOf(pageUrl);
    if (!host) return [];
    const base = baseDomain(host);
    return this.entries
      .filter(e => {
        const eh = hostOf(e.origin);
        return eh && baseDomain(eh) === base;
      })
      .map(e => ({ id: e.id, username: e.username, origin: e.origin, title: e.title }));
  }

  /**
   * The only path that returns a password for filling, and it re-checks the
   * requesting page itself rather than trusting the caller's claim.
   */
  credentialFor(id, pageUrl) {
    this.requireOpen();
    const e = this.entries.find(x => x.id === id);
    if (!e) throw new Error('No such entry');
    const eh = hostOf(e.origin);
    const ph = hostOf(pageUrl);
    if (!eh || !ph || baseDomain(eh) !== baseDomain(ph)) {
      throw new Error('That login does not belong to this site');
    }
    return { username: e.username, password: e.password };
  }

  /** Does this exact username already exist for the site? */
  findByLogin(pageUrl, username) {
    if (!this.key) return null;
    const base = baseDomain(hostOf(pageUrl));
    return this.entries.find(e => baseDomain(hostOf(e.origin)) === base && e.username === username) || null;
  }

  /* ---------------------------------------------------------- generator */

  static generate(opts = {}) {
    const length = Math.max(8, Math.min(128, Number(opts.length) || 20));
    let pool = '';
    if (opts.lower !== false) pool += SETS.lower;
    if (opts.upper !== false) pool += SETS.upper;
    if (opts.digits !== false) pool += SETS.digits;
    if (opts.symbols) pool += SETS.symbols;
    if (!pool) pool = SETS.lower + SETS.digits;
    if (opts.avoidAmbiguous !== false) {
      pool = [...pool].filter(c => !AMBIGUOUS.includes(c)).join('');
    }
    let out = '';
    // Rejection sampling keeps every character equally likely.
    const limit = 256 - (256 % pool.length);
    while (out.length < length) {
      for (const byte of crypto.randomBytes(length * 2)) {
        if (byte >= limit) continue;
        out += pool[byte % pool.length];
        if (out.length === length) break;
      }
    }
    return out;
  }
}

module.exports = { Vault };
