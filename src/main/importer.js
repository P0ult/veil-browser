'use strict';
const fs = require('node:fs');

/**
 * Reading what another browser exported.
 *
 * Three formats cover nearly everything:
 *
 *   - a Chromium `Bookmarks` file, which is JSON and sits unencrypted in the
 *     profile of Chrome, Edge, Brave, Vivaldi and Opera alike;
 *   - the Netscape bookmark HTML that every browser since 1994 exports,
 *     Firefox and Safari included;
 *   - a password CSV, which is what Chrome, Edge, Firefox and the password
 *     managers all produce, in almost but not quite the same shape.
 *
 * Passwords are read from a file the user exported rather than from another
 * browser's own store. That is not squeamishness: Chrome encrypts its store
 * with a key held by the operating system and newer versions tie that key to
 * the browser binary, so reading it would mean impersonating Chrome to the
 * keystore. Asking for the export also means nobody is surprised about what
 * moved.
 */

/* --------------------------------------------------------------------- CSV */

/**
 * One CSV file, as rows of cells.
 *
 * Written out rather than pulled in because the awkward parts are exactly the
 * parts a regular expression gets wrong: quoted cells containing commas,
 * quoted cells containing newlines, and `""` meaning one quote. Passwords
 * contain all three.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const src = String(text || '').replace(/^﻿/, '');   // strip a BOM

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }

  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/* Every name the exporters use for the same four things. Chrome says "name",
   Firefox says "url", Bitwarden prefixes everything with "login_", 1Password
   writes "website". */
const FIELDS = {
  url: ['url', 'login_uri', 'website', 'uri', 'hostname', 'web site', 'site', 'login url'],
  username: ['username', 'login_username', 'user', 'user name', 'email', 'login', 'account'],
  password: ['password', 'login_password', 'pass', 'passwd'],
  title: ['name', 'title', 'display name', 'item name']
};

function columnMap(header) {
  const lower = header.map(h => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [field, names] of Object.entries(FIELDS)) {
    map[field] = lower.findIndex(h => names.includes(h));
  }
  return map;
}

/**
 * Logins from an exported CSV.
 *
 * Returns { entries, skipped, format } - `format` is what the header looked
 * like, which is worth showing back to the user when nothing was found.
 */
function parsePasswordCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { entries: [], skipped: 0, format: 'not a CSV, or empty' };

  const header = rows[0];
  const col = columnMap(header);

  if (col.password < 0 || col.url < 0) {
    return {
      entries: [],
      skipped: rows.length - 1,
      format: 'columns: ' + header.map(h => String(h).trim()).filter(Boolean).join(', ')
    };
  }

  const entries = [];
  let skipped = 0;

  for (const row of rows.slice(1)) {
    const at = (i) => (i >= 0 && i < row.length ? String(row[i]).trim() : '');
    const url = at(col.url);
    const password = at(col.password);
    if (!url || !password) { skipped++; continue; }

    // Chrome exports "android://..." rows for phone apps, which mean nothing here.
    if (/^android:/i.test(url)) { skipped++; continue; }

    entries.push({
      origin: url,
      username: at(col.username),
      password,
      title: at(col.title)
    });
  }

  return { entries, skipped, format: 'read ' + entries.length + ' logins' };
}

/* --------------------------------------------------------------- bookmarks */

/** Bookmarks out of a Chromium `Bookmarks` file. */
function parseChromiumBookmarks(text) {
  let data;
  try { data = JSON.parse(String(text || '')); } catch { return []; }
  const roots = data && data.roots;
  if (!roots || typeof roots !== 'object') return [];

  const out = [];
  const walk = (node, trail) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url' && node.url) {
      out.push({ title: String(node.name || ''), url: String(node.url), folder: trail.join(' / ') });
      return;
    }
    if (Array.isArray(node.children)) {
      const name = String(node.name || '');
      const next = name ? trail.concat(name) : trail;
      for (const child of node.children) walk(child, next);
    }
  };

  // bookmark_bar, other, synced - named so the folders read the way they did
  // in the browser they came from.
  const NAMES = { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' };
  for (const [key, node] of Object.entries(roots)) {
    if (!node || typeof node !== 'object') continue;
    walk(Object.assign({}, node, { name: node.name || NAMES[key] || key }), []);
  }
  return out;
}

/**
 * Bookmarks out of Netscape export HTML.
 *
 * The format is thirty years old and not quite HTML - <DT> and <DD> are left
 * unclosed, and folder nesting is implied by <DL> rather than by containment.
 * Reading it as a stream of tags rather than as a document is both simpler and
 * more forgiving of the variations each browser writes.
 */
function parseNetscapeHtml(text) {
  const src = String(text || '');
  const out = [];
  const trail = [];

  // <H3 ...>Folder</H3>, <A HREF="...">Title</A>, <DL>, </DL>
  const token = /<(dl|\/dl|h3|a)\b([^>]*)>([\s\S]*?)(?=<)/gi;
  let m;

  while ((m = token.exec(src)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const inner = (m[3] || '').trim();

    if (tag === 'dl') continue;
    if (tag === '/dl') { trail.pop(); continue; }

    if (tag === 'h3') {
      trail.push(decodeEntities(stripTags(inner)));
      continue;
    }

    if (tag === 'a') {
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1];
      if (!href) continue;
      const added = Number((attrs.match(/add_date\s*=\s*"(\d+)"/i) || [])[1]) || 0;
      out.push({
        title: decodeEntities(stripTags(inner)),
        url: decodeEntities(href),
        folder: trail.join(' / '),
        // Netscape dates are seconds; a few exporters write microseconds.
        added: added > 1e12 ? Math.round(added / 1000) : added * 1000
      });
    }
  }

  return out;
}

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');           // last, or the others double-decode
}

/** Whichever of the two bookmark formats this file turns out to be. */
function parseBookmarksFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const head = text.slice(0, 400).trim();

  if (head.startsWith('{')) {
    const fromJson = parseChromiumBookmarks(text);
    if (fromJson.length) return { items: fromJson, format: 'Chromium bookmarks' };
  }
  if (/<!doctype netscape-bookmark-file|<dl|<a\s+href/i.test(head) || /<a\s+href/i.test(text)) {
    const fromHtml = parseNetscapeHtml(text);
    if (fromHtml.length) return { items: fromHtml, format: 'exported bookmarks HTML' };
  }
  // One last go at JSON, for a file that did not start with a brace.
  const fromJson = parseChromiumBookmarks(text);
  if (fromJson.length) return { items: fromJson, format: 'Chromium bookmarks' };

  return { items: [], format: 'not a bookmarks file Veil recognises' };
}

module.exports = {
  parseCsv,
  parsePasswordCsv,
  parseChromiumBookmarks,
  parseNetscapeHtml,
  parseBookmarksFile
};
