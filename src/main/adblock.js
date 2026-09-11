'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, net } = require('electron');
const { FilterEngine } = require('./filters');

/**
 * The blocker.
 *
 * The rules themselves are read and matched by ./filters, which understands
 * the Adblock Plus / uBlock Origin syntax the real filter lists are written
 * in. This holds the lists together: what ships with Veil, what has been
 * downloaded since, what the user has added by hand, and which sites they have
 * paused blocking on.
 *
 * Two engines, not one, and for a practical reason: the shipped lists are four
 * and a half megabytes and take about a third of a second to read, while the
 * user's own rules change every time they pause blocking on a site. Keeping
 * them apart means pausing a site is instant instead of rebuilding everything.
 */

/** The lists that ship inside the app, and where to get a fresher copy. */
const BUNDLED = [
  { name: 'EasyList', file: 'easylist.txt', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'EasyPrivacy', file: 'easyprivacy.txt', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { name: 'uBlock Origin filters', file: 'ubo-filters.txt', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' },
  { name: 'uBlock Origin privacy', file: 'ubo-privacy.txt', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt' },
  { name: 'uBlock Origin badware', file: 'ubo-badware.txt', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt' }
];

class AdBlock {
  constructor(settings) {
    this.settings = settings;
    this.listsDir = path.join(app.getPath('userData'), 'lists');
    this.bundledDir = path.join(__dirname, '..', '..', 'assets', 'filters');

    this.engine = new FilterEngine();     // the lists
    this.user = new FilterEngine();       // the user's own rules
    this.allow = new Set();               // sites blocking is paused on

    this.counts = new Map();              // webContentsId -> blocked on this page
    this.total = 0;
    this.builtinCount = 0;
    this.listsKey = '';
    this.buildTime = 0;

    this.buildLists();
    this.buildUser();
  }

  /* ------------------------------------------------------------ building */

  /** Which lists are on, as a string, so a needless rebuild can be skipped. */
  keyForLists() {
    return (this.settings.get('adblock.lists', []) || [])
      .filter(l => l.enabled)
      .map(l => l.url || l.file)
      .join('|');
  }

  /** Read every enabled list. The expensive one; only when it has to be. */
  buildLists() {
    const started = Date.now();
    const engine = new FilterEngine();
    const lists = this.settings.get('adblock.lists', []) || [];

    for (const l of lists) {
      if (!l.enabled) continue;
      const text = this.readList(l);
      if (text) engine.addList(text);
    }

    // The short hand-written list Veil has always carried. It is a backstop
    // for a profile with every list turned off, not a list in its own right.
    try {
      const before = engine.counts.host;
      const builtin = fs.readFileSync(
        path.join(__dirname, '..', '..', 'assets', 'blocklist.txt'), 'utf8');
      engine.addList(builtin);
      // What this list added, not what the engine holds - most of its domains
      // are in the big lists as well, so the difference is the honest number.
      this.builtinCount = engine.counts.host - before;
    } catch (e) {
      console.error('[adblock] built-in list missing:', e.message);
    }

    this.engine = engine;
    this.listsKey = this.keyForLists();
    this.buildTime = Date.now() - started;
  }

  /**
   * A downloaded copy if there is one, otherwise the copy that shipped. This
   * is what makes "update lists" meaningful for a list that is also bundled:
   * the shipped copy is a starting point, not a ceiling.
   */
  readList(entry) {
    const cached = path.join(this.listsDir, AdBlock.slug(entry.url || entry.file) + '.txt');
    try { return fs.readFileSync(cached, 'utf8'); } catch {}
    if (entry.file) {
      try { return fs.readFileSync(path.join(this.bundledDir, entry.file), 'utf8'); } catch {}
    }
    return '';
  }

  /** The user's own rules and their paused sites. Cheap, so it runs often. */
  buildUser() {
    const user = new FilterEngine();
    const custom = this.settings.get('adblock.customBlock', []) || [];
    user.addList(custom.join('\n'));
    this.user = user;

    this.allow = new Set(
      (this.settings.get('adblock.allowlist', []) || [])
        .map(d => String(d).trim().toLowerCase().replace(/^www\./, ''))
        .filter(Boolean)
    );
  }

  /** Called whenever settings change: rebuilds only what actually changed. */
  rebuild() {
    this.buildUser();
    if (this.keyForLists() !== this.listsKey) this.buildLists();
  }

  static slug(url) {
    return String(url).replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  }

  /* ------------------------------------------------------------ decisions */

  /**
   * What to do with one request.
   *
   * @param {object} ctx { url, host, type, docDomain, thirdParty }
   * @returns {'block'|'block-host'|null}
   *
   * 'block-host' says the verdict came from a hostname list rather than from a
   * rule that understands context. The caller softens those for a site's own
   * assets, because a hosts list cannot tell the difference between "this
   * domain serves adverts" and "this domain is the page you are reading".
   */
  decide(ctx) {
    const own = this.user.decide(ctx);
    if (own === 'allow') return null;

    const verdict = own || this.engine.decide(ctx);
    if (verdict !== 'block') return null;

    const fromHostList = this.engine.hasBlockedHost(ctx.host) || this.user.hasBlockedHost(ctx.host);
    return fromHostList ? 'block-host' : 'block';
  }

  /** True when hostname or one of its parents is on a hostname list. */
  isBlockedHost(hostname) {
    return this.engine.hasBlockedHost(hostname) || this.user.hasBlockedHost(hostname);
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
    this.buildUser();
  }

  /* ------------------------------------------------------------ cosmetic */

  /** The hiding rules for a site: its own, plus the generic awkward ones. */
  cosmeticFor(hostname) {
    const mine = this.user.cosmeticFor(hostname);
    const theirs = this.engine.cosmeticFor(hostname);
    return {
      specific: theirs.specific.concat(mine.specific),
      complex: theirs.complex.concat(mine.complex),
      excepted: theirs.excepted.concat(mine.excepted)
    };
  }

  /**
   * The generic rules that apply to a page containing these class and id
   * names. Tens of thousands of rules exist; a page is told about the handful
   * that could possibly match something it actually has.
   */
  genericFor(tokens, excepted) {
    const skip = new Set(excepted || []);
    return this.engine.genericFor(tokens, skip).concat(this.user.genericFor(tokens, skip));
  }

  /* -------------------------------------------------------------- counts */

  countHit(wcId) {
    this.total++;
    this.counts.set(wcId, (this.counts.get(wcId) || 0) + 1);
  }
  resetCount(wcId) { this.counts.set(wcId, 0); }
  countFor(wcId) { return this.counts.get(wcId) || 0; }
  forget(wcId) { this.counts.delete(wcId); }

  size() { return this.engine.size() + this.user.size(); }

  stats() {
    const c = this.engine.counts;
    return {
      network: c.network,
      hosts: c.host,
      cosmetic: c.cosmetic + c.generic,
      buildMs: this.buildTime
    };
  }

  /* ------------------------------------------------------------ updating */

  /** Download every enabled list and cache it in userData/lists. */
  async updateLists(onProgress = () => {}) {
    fs.mkdirSync(this.listsDir, { recursive: true });
    const lists = this.settings.get('adblock.lists', []) || [];
    const results = [];

    for (const l of lists) {
      if (!l.enabled || !l.url) continue;
      try {
        onProgress('Fetching ' + l.name + '…');
        const res = await net.fetch(l.url, { headers: { 'User-Agent': 'Veil/1.0' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();

        // A list that parses to almost nothing is a captive portal, an error
        // page, or a truncated download. Keeping the copy we already have is
        // better than replacing it with rubbish.
        const probe = new FilterEngine();
        probe.addList(text);
        if (probe.size() < 50) throw new Error('list looked empty');

        fs.writeFileSync(path.join(this.listsDir, AdBlock.slug(l.url) + '.txt'), text, 'utf8');
        results.push({ name: l.name, ok: true, domains: probe.size() });
      } catch (e) {
        results.push({ name: l.name, ok: false, error: e.message });
      }
    }

    this.settings.update({ adblock: { lastUpdated: Date.now() } });
    this.buildLists();
    return { results, total: this.size() };
  }
}

module.exports = { AdBlock, BUNDLED };
