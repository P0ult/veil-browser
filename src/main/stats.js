'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * What Veil has blocked, kept across sessions.
 *
 * This is deliberately not browsing history, and the distinction is the whole
 * design. A history records where you went. This records what was refused on
 * your behalf: the domain that was turned away, what kind of list named it,
 * and how many times. The page you were reading when it happened is not
 * written down, because writing it down would turn a blocking log into exactly
 * the record this browser refuses to keep.
 *
 * So: `doubleclick.net, 412 times, an advert list` is kept.
 * `doubleclick.net, on the page you read at 11:04` is not.
 *
 * Days are kept as counts against a date, for the chart, and nothing finer -
 * an hourly breakdown of a single day starts to describe when you are at your
 * desk, which is again more than the number is worth.
 */

const FILE = 'block-stats.json';
const DAYS_KEPT = 60;
const MAX_DOMAINS = 3000;      // beyond this the tail is trimmed on save
const SAVE_AFTER_MS = 20000;   // at most one write every twenty seconds

/** Today, as YYYY-MM-DD in local time. */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

class BlockStats {
  constructor(opts = {}) {
    this.file = path.join(app.getPath('userData'), FILE);
    // Off means nothing is counted and nothing is written. The switch is here
    // rather than at the call site so that turning it off also stops the file
    // being touched at all.
    this.enabled = opts.enabled !== false;
    this.timer = null;
    this.dirty = false;
    this.load();
  }

  /** Empty, in the shape everything below expects. */
  static blank() {
    return {
      since: Date.now(),
      total: 0,
      byKind: { advert: 0, tracker: 0, custom: 0, other: 0 },
      domains: {},                 // domain -> { n, kind, last }
      days: {}                     // YYYY-MM-DD -> count
    };
  }

  load() {
    this.data = BlockStats.blank();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = {
          since: Number(raw.since) || Date.now(),
          total: Number(raw.total) || 0,
          byKind: Object.assign(BlockStats.blank().byKind, raw.byKind || {}),
          domains: (raw.domains && typeof raw.domains === 'object') ? raw.domains : {},
          days: (raw.days && typeof raw.days === 'object') ? raw.days : {}
        };
      }
    } catch {
      // No file yet, or one that cannot be read. Starting from empty is the
      // right answer either way - these are counters, not anything to recover.
    }
    this.trimDays();
  }

  /**
   * Record one blocked request.
   *
   * Called from the hot path of every page load, so it does arithmetic and
   * nothing else: the write to disk is debounced well behind it.
   */
  record(domain, kind) {
    if (!this.enabled) return;
    const d = String(domain || '').toLowerCase().replace(/^www\./, '');
    if (!d || !d.includes('.')) return;

    const k = (kind === 'advert' || kind === 'tracker' || kind === 'custom') ? kind : 'other';
    this.data.total++;
    this.data.byKind[k] = (this.data.byKind[k] || 0) + 1;

    const entry = this.data.domains[d];
    if (entry) {
      entry.n++;
      entry.last = Date.now();
      // A domain on two lists is named by the first one that stopped it, and
      // stays that way - flapping between labels would make the figure read
      // as if something had changed when nothing had.
      if (!entry.kind && k !== 'other') entry.kind = k;
    } else {
      this.data.domains[d] = { n: 1, kind: k === 'other' ? '' : k, last: Date.now() };
    }

    const day = today();
    this.data.days[day] = (this.data.days[day] || 0) + 1;

    this.schedule();
  }

  /** Write soon, not now. */
  schedule() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, SAVE_AFTER_MS);
    if (this.timer.unref) this.timer.unref();
  }

  trimDays() {
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > DAYS_KEPT) {
      delete this.data.days[keys.shift()];
    }
  }

  /** Drop the long tail of domains seen once, oldest first, when it gets silly. */
  trimDomains() {
    const names = Object.keys(this.data.domains);
    if (names.length <= MAX_DOMAINS) return;
    names.sort((a, b) => {
      const A = this.data.domains[a], B = this.data.domains[b];
      return (B.n - A.n) || ((B.last || 0) - (A.last || 0));
    });
    const kept = {};
    for (const name of names.slice(0, MAX_DOMAINS)) kept[name] = this.data.domains[name];
    this.data.domains = kept;
  }

  saveNow() {
    if (!this.enabled || !this.dirty) return;
    this.trimDays();
    this.trimDomains();
    try {
      // Written beside the target and renamed, so a crash mid-write cannot
      // leave a half-file that fails to parse on the next launch.
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('[stats] could not save:', e.message);
    }
  }

  /** Everything the statistics page draws, already sorted and cut down. */
  summary(topN = 50) {
    const domains = Object.entries(this.data.domains)
      .map(([domain, v]) => ({ domain, n: v.n, kind: v.kind || 'other', last: v.last || 0 }))
      .sort((a, b) => b.n - a.n);

    const days = Object.keys(this.data.days).sort();
    const recent = days.slice(-30).map(date => ({ date, n: this.data.days[date] || 0 }));

    return {
      enabled: this.enabled,
      since: this.data.since,
      total: this.data.total,
      byKind: this.data.byKind,
      domainCount: domains.length,
      top: domains.slice(0, topN),
      days: recent,
      busiestDay: recent.reduce((best, d) => (d.n > (best ? best.n : -1) ? d : best), null)
    };
  }

  /** Forget everything, and take the file with it. */
  clear() {
    this.data = BlockStats.blank();
    this.dirty = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { fs.unlinkSync(this.file); } catch {}
  }

  setEnabled(on) {
    const want = on !== false;
    if (want === this.enabled) return;
    this.enabled = want;
    if (!want) {
      // Turning counting off leaves what is already there alone; there is a
      // separate button for forgetting it.
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }
  }
}

module.exports = { BlockStats };
