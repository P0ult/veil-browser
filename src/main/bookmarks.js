'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

/**
 * Bookmarks.
 *
 * Veil has no history, deliberately and permanently: nothing records the pages
 * you visit. A bookmark is the opposite kind of thing - you asked for it to be
 * remembered, by name, and a browser that cannot keep the handful of pages you
 * care about is not a browser. So this exists, it is plain JSON in the
 * profile, and it holds only what you put in it.
 *
 * The distinction is worth stating plainly because the two get confused: a
 * history is a record made about you, a bookmark is a note made by you.
 */

const FILE = 'bookmarks.json';
const MAX = 20000;          // well past any real collection; a guard, not a budget

function now() { return Date.now(); }
function id() { return crypto.randomBytes(8).toString('hex'); }

/** A url Veil is willing to keep, normalised, or '' if it is not one. */
function cleanUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    // Nothing but the web and files. A bookmark to javascript: is a bookmarklet,
    // which is a script someone else wrote running on whatever page you are on.
    if (!/^(https?|file|ftp):$/.test(u.protocol)) return '';
    return u.href;
  } catch { return ''; }
}

/** What two bookmarks have to share to be the same one. */
function keyOf(url) {
  try {
    const u = new URL(url);
    return (u.protocol + '//' + u.host + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch { return String(url || '').toLowerCase(); }
}

class Bookmarks {
  constructor() {
    this.file = path.join(app.getPath('userData'), FILE);
    this.items = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw && raw.items);
      this.items = (Array.isArray(list) ? list : [])
        .map(b => ({
          id: String(b.id || id()),
          title: String(b.title || '').slice(0, 300),
          url: String(b.url || ''),
          folder: String(b.folder || '').slice(0, 200),
          added: Number(b.added) || now()
        }))
        .filter(b => b.url);
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 0));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[bookmarks] could not save:', e.message);
    }
  }

  list() {
    return this.items
      .slice()
      .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') ||
                      (a.title || a.url).localeCompare(b.title || b.url));
  }

  has(url) {
    const k = keyOf(url);
    return this.items.some(b => keyOf(b.url) === k);
  }

  /** Add one. Returns the bookmark, or null if it was already there. */
  add({ url, title, folder } = {}) {
    const href = cleanUrl(url);
    if (!href) throw new Error('That is not an address Veil can bookmark');
    if (this.has(href)) return null;
    if (this.items.length >= MAX) throw new Error('Too many bookmarks');

    const item = {
      id: id(),
      title: String(title || '').trim().slice(0, 300) || hostOf(href),
      url: href,
      folder: String(folder || '').trim().slice(0, 200),
      added: now()
    };
    this.items.push(item);
    this.save();
    return item;
  }

  /**
   * Add many at once, skipping the ones already here.
   *
   * One write at the end rather than one per bookmark: an import is thousands
   * of them, and writing the whole file after each would take minutes.
   */
  addMany(list) {
    const seen = new Set(this.items.map(b => keyOf(b.url)));
    let added = 0, skipped = 0, rejected = 0;

    for (const raw of Array.isArray(list) ? list : []) {
      const href = cleanUrl(raw && raw.url);
      if (!href) { rejected++; continue; }
      const k = keyOf(href);
      if (seen.has(k)) { skipped++; continue; }
      if (this.items.length >= MAX) { rejected++; continue; }

      seen.add(k);
      this.items.push({
        id: id(),
        title: String(raw.title || '').trim().slice(0, 300) || hostOf(href),
        url: href,
        folder: String(raw.folder || '').trim().slice(0, 200),
        added: Number(raw.added) || now()
      });
      added++;
    }

    if (added) this.save();
    return { added, skipped, rejected, total: this.items.length };
  }

  remove(bookmarkId) {
    const i = this.items.findIndex(b => b.id === bookmarkId);
    if (i >= 0) { this.items.splice(i, 1); this.save(); }
    return this.list();
  }

  /** Remove by address, for a star that toggles. */
  removeUrl(url) {
    const k = keyOf(url);
    const before = this.items.length;
    this.items = this.items.filter(b => keyOf(b.url) !== k);
    if (this.items.length !== before) this.save();
    return before !== this.items.length;
  }

  clear() {
    this.items = [];
    this.save();
  }

  folders() {
    const set = new Set();
    for (const b of this.items) if (b.folder) set.add(b.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

module.exports = { Bookmarks, cleanUrl, keyOf };
