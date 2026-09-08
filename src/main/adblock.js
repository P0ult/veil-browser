'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, net } = require('electron');

/**
 * Domain-based blocking engine.
 *
 * Everything is reduced to a set of hostnames. A request is blocked when its
 * hostname, or any parent of it, is in the set. That keeps lookups to a handful
 * of Set hits per request instead of running regexes over every URL, which is
 * what makes full filter-list engines heavy.
 */
class AdBlock {
  constructor(settings) {
    this.settings = settings;
    this.blocked = new Set();
    this.allow = new Set();
    this.builtinCount = 0;
    this.listsDir = path.join(app.getPath('userData'), 'lists');
    this.counts = new Map();   // webContentsId -> blocked count for current page
    this.total = 0;
    this.rebuild();
  }

  /** Parse hosts-format, plain-domain, or AdGuard-DNS-ish lines. */
  static parse(text, into) {
    let n = 0;
    for (let line of text.split('\n')) {
      const hash = line.indexOf('#');
      if (hash >= 0) line = line.slice(0, hash);
      line = line.trim();
      if (!line) continue;

      // "0.0.0.0 example.com" / "127.0.0.1 example.com"
      const parts = line.split(/\s+/);
      let host = parts.length > 1 ? parts[1] : parts[0];

      // "||example.com^" (AdGuard/uBO domain rule)
      if (host.startsWith('||')) host = host.slice(2);
      host = host.replace(/[\^|].*$/, '');
      if (host.startsWith('.')) host = host.slice(1);
      host = host.toLowerCase().replace(/\/.*$/, '');

      if (!host || host === 'localhost' || host === 'localhost.localdomain') continue;
      if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') continue;
      if (!host.includes('.') || /[^a-z0-9.\-_*]/.test(host)) continue;
      if (host.includes('*')) continue;               // wildcards not supported

      into.add(host);
      n++;
    }
    return n;
  }

  rebuild() {
    const set = new Set();

    // Built-in list shipped with the app
    try {
      const builtin = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'blocklist.txt'), 'utf8');
      this.builtinCount = AdBlock.parse(builtin, set);
    } catch (e) {
      this.builtinCount = 0;
      console.error('[adblock] built-in list missing:', e.message);
    }

    // Downloaded lists that are enabled
    const lists = this.settings.get('adblock.lists', []);
    for (const l of lists) {
      if (!l.enabled) continue;
      try {
        const cached = fs.readFileSync(path.join(this.listsDir, AdBlock.slug(l.url) + '.txt'), 'utf8');
        AdBlock.parse(cached, set);
      } catch {}
    }

    // User's own rules
    AdBlock.parse((this.settings.get('adblock.customBlock', []) || []).join('\n'), set);

    this.blocked = set;
    this.allow = new Set(
      (this.settings.get('adblock.allowlist', []) || [])
        .map(d => String(d).trim().toLowerCase().replace(/^www\./, ''))
        .filter(Boolean)
    );
  }

  static slug(url) {
    return String(url).replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  }

  /** True when hostname or one of its parents is on the blocklist. */
  isBlockedHost(hostname) {
    if (!hostname) return false;
    const h = hostname.toLowerCase();
    if (this.blocked.has(h)) return true;
    let i = h.indexOf('.');
    while (i !== -1) {
      const parent = h.slice(i + 1);
      if (!parent.includes('.')) break;              // stop before bare TLD
      if (this.blocked.has(parent)) return true;
      i = h.indexOf('.', i + 1);
    }
    return false;
  }

  /** True when the user has paused blocking for this top-level site. */
  isAllowedSite(hostname) {
    if (!hostname) return false;
    const h = hostname.toLowerCase().replace(/^www\./, '');
    if (this.allow.has(h)) return true;
    let i = h.indexOf('.');
    while (i !== -1) {
      const parent = h.slice(i + 1);
      if (!parent.includes('.')) break;
      if (this.allow.has(parent)) return true;
      i = h.indexOf('.', i + 1);
    }
    return false;
  }

  toggleSite(hostname, on) {
    const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (!h) return;
    const list = new Set(this.settings.get('adblock.allowlist', []) || []);
    if (on) list.delete(h); else list.add(h);
    this.settings.update({ adblock: { allowlist: [...list] } });
    this.rebuild();
  }

  countHit(wcId) {
    this.total++;
    this.counts.set(wcId, (this.counts.get(wcId) || 0) + 1);
  }
  resetCount(wcId) { this.counts.set(wcId, 0); }
  countFor(wcId) { return this.counts.get(wcId) || 0; }
  forget(wcId) { this.counts.delete(wcId); }

  size() { return this.blocked.size; }

  /** Download every enabled list and cache it in userData/lists. */
  async updateLists(onProgress = () => {}) {
    fs.mkdirSync(this.listsDir, { recursive: true });
    const lists = this.settings.get('adblock.lists', []) || [];
    const results = [];
    for (const l of lists) {
      if (!l.enabled) continue;
      try {
        onProgress(`Fetching ${l.name}…`);
        const res = await net.fetch(l.url, { headers: { 'User-Agent': 'Veil/1.0' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        const probe = new Set();
        const n = AdBlock.parse(text, probe);
        if (n < 10) throw new Error('list looked empty');
        fs.writeFileSync(path.join(this.listsDir, AdBlock.slug(l.url) + '.txt'), text, 'utf8');
        results.push({ name: l.name, ok: true, domains: n });
      } catch (e) {
        results.push({ name: l.name, ok: false, error: e.message });
      }
    }
    this.settings.update({ adblock: { lastUpdated: Date.now() } });
    this.rebuild();
    return { results, total: this.blocked.size };
  }
}

module.exports = { AdBlock };
