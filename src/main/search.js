'use strict';
const { net } = require('electron');

/**
 * Veil's own search engine.
 *
 * A meta-search: the main process queries several independent engines
 * directly, merges their rankings, strips tracking parameters and redirect
 * wrappers, then hands clean results to our own results page. The engines never
 * see the user's cookies (a throwaway session is used) and nothing about a
 * query is ever written to disk.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TRACKING_PARAMS = [
  /^utm_/i, /^ga_/i, /^_ga$/i, /^gclid$/i, /^gclsrc$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i,
  /^fbclid$/i, /^igshid$/i, /^msclkid$/i, /^mc_[ce]id$/i, /^yclid$/i, /^twclid$/i, /^ttclid$/i,
  /^ref_src$/i, /^ref_url$/i, /^s_kwcid$/i, /^_hsenc$/i, /^_hsmi$/i, /^vero_/i, /^oly_/i,
  /^icid$/i, /^cmpid$/i, /^campaign_id$/i, /^spm$/i, /^scm$/i, /^trk$/i, /^trkCampaign$/i,
  /^__s$/i, /^_openstat$/i, /^wickedid$/i, /^rb_clickid$/i, /^ir_?clickid$/i
];

function stripTracking(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some(re => re.test(k))) u.searchParams.delete(k);
    }
    u.hash = u.hash.replace(/^#(utm_|xtor).*/i, '');
    return u.toString();
  } catch { return rawUrl; }
}

/** DuckDuckGo wraps outbound links in /l/?uddg=... - unwrap them. */
function unwrapRedirect(href) {
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href);
    const inner = u.searchParams.get('uddg') || u.searchParams.get('url') || u.searchParams.get('u');
    if (inner && /^https?:\/\//i.test(inner)) return inner;
    return href;
  } catch { return href; }
}

/* --------------------------------------------------------------- HTML bits
   These engines change their markup without warning and are not consistent
   about attribute order or quote style, so nothing here may assume either.  */

function attrOf(attrs, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return '';
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : (m[3] || '');
}

function hasClass(attrs, name) {
  return new RegExp('(^|\\s)' + name + '(\\s|$)').test(attrOf(attrs, 'class'));
}

function* eachTag(html, tag) {
  const re = new RegExp('<' + tag + '\\b([^>]*)>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  let m;
  while ((m = re.exec(html))) yield { attrs: m[1], inner: m[2] };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#x27': "'", '#x2f': '/', '#x3d': '=', mdash: '—', ndash: '–', hellip: '…'
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const key = e.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
    }
    return m;
  });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function looksLikeChallenge(html) {
  return /Just a moment|cf-browser-verification|challenge-platform|challenge\.js|g-recaptcha|hcaptcha|Enable JavaScript and cookies to continue/i.test(html);
}

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'DNT': '1',
  'Sec-GPC': '1'
};

/**
 * Deliberately net.request rather than net.fetch: only net.request honours the
 * session's proxy. Using fetch here would quietly send every search query
 * straight out of the machine while the tunnel claimed to be carrying it.
 */
function fetchText(url, session, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    let req;
    const timer = setTimeout(() => {
      try { if (req) req.abort(); } catch {}
      finish(reject, new Error('timed out'));
    }, opts.timeout || 15000);

    try {
      req = net.request({ method: opts.method || 'GET', url, session });
    } catch (e) {
      return finish(reject, e);
    }

    for (const [k, v] of Object.entries(HEADERS)) req.setHeader(k, v);
    if (opts.body) req.setHeader('Content-Type', 'application/x-www-form-urlencoded');

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return finish(reject, new Error('HTTP ' + res.statusCode));
        }
        finish(resolve, Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('error', (e) => finish(reject, e));

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ------------------------------------------------------------------ backends */

/**
 * DuckDuckGo pages by POSTing the hidden form it embeds in each response,
 * including a per-query `vqd` token. There is no page number to guess: page N+1
 * only exists once page N has been read.
 */
function nextPageForm(html) {
  for (const form of eachTag(html, 'form')) {
    const fields = {};
    for (const m of form.inner.match(/<input[^>]*>/gi) || []) {
      const name = attrOf(m, 'name');
      if (name) fields[name] = decodeEntities(attrOf(m, 'value'));
    }
    if (fields.vqd && fields.s !== undefined) return fields;
  }
  return null;
}

function parseDdgLite(html) {
  const snippets = [];
  for (const td of eachTag(html, 'td')) {
    if (hasClass(td.attrs, 'result-snippet')) snippets.push(stripTags(td.inner));
  }
  const out = [];
  let i = 0;
  for (const a of eachTag(html, 'a')) {
    if (!hasClass(a.attrs, 'result-link')) continue;
    const url = unwrapRedirect(decodeEntities(attrOf(a.attrs, 'href')));
    const title = stripTags(a.inner);
    if (/^https?:\/\//i.test(url) && title) {
      try {
        if (!/(^|\.)duckduckgo\.com$/i.test(new URL(url).hostname)) {
          out.push({ title, url, snippet: snippets[i] || '', source: 'duckduckgo' });
        }
      } catch {}
    }
    i++;
  }
  return out;
}

/** Page 1 by GET; later pages by POSTing the form the previous page handed us. */
async function ddgLite(query, session, form) {
  const html = form
    ? await fetchText('https://lite.duckduckgo.com/lite/', session, {
        method: 'POST', body: new URLSearchParams(form).toString()
      })
    : await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), session);

  if (looksLikeChallenge(html)) throw new Error('bot check');
  const results = parseDdgLite(html);
  const next = nextPageForm(html);
  // A short page carrying neither results nor a next-page form is what
  // DuckDuckGo returns when it is throttling us, not a genuinely empty query.
  const throttled = !results.length && !next && html.length < 6000;
  return { results, next, throttled };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Fallback parser for the html.duckduckgo.com markup (first page only). */
async function ddgHtml(query, session) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), session);
  if (looksLikeChallenge(html)) throw new Error('bot check');

  const titles = [];
  const snippets = [];
  for (const a of eachTag(html, 'a')) {
    if (hasClass(a.attrs, 'result__a')) {
      titles.push({ url: unwrapRedirect(decodeEntities(attrOf(a.attrs, 'href'))), title: stripTags(a.inner) });
    } else if (hasClass(a.attrs, 'result__snippet')) {
      snippets.push(stripTags(a.inner));
    }
  }

  const out = [];
  titles.forEach((t, i) => {
    if (!/^https?:\/\//i.test(t.url) || !t.title) return;
    try { if (/(^|\.)duckduckgo\.com$/i.test(new URL(t.url).hostname)) return; } catch { return; }
    out.push({ title: t.title, url: t.url, snippet: snippets[i] || '', source: 'duckduckgo' });
  });
  return { results: out, next: null };
}

/** Marginalia indexes the non-commercial web, so it surfaces different pages. */
async function marginalia(query, session, page = 1) {
  const hosts = ['https://old-search.marginalia.nu', 'https://marginalia-search.com'];
  const suffix = '/search?query=' + encodeURIComponent(query) + (page > 1 ? '&page=' + page : '');
  let html = null;
  let lastErr = null;
  for (const host of hosts) {
    try { html = await fetchText(host + suffix, session, { timeout: 8000 }); break; }
    catch (e) { lastErr = e; }
  }
  if (html == null) throw lastErr || new Error('unreachable');

  const out = [];
  for (const sec of eachTag(html, 'section')) {
    if (!hasClass(sec.attrs, 'search-result')) continue;
    let url = '';
    let title = '';
    for (const a of eachTag(sec.inner, 'a')) {
      if (!hasClass(a.attrs, 'title')) continue;
      url = decodeEntities(attrOf(a.attrs, 'href'));
      title = stripTags(a.inner);
      break;
    }
    if (!/^https?:\/\//i.test(url) || !title) continue;
    let snippet = '';
    for (const p of eachTag(sec.inner, 'p')) {
      if (hasClass(p.attrs, 'description')) { snippet = stripTags(p.inner); break; }
    }
    out.push({ title, url, snippet, source: 'marginalia' });
  }
  return out;
}

/** Mojeek also runs an independent crawler, but usually demands a bot check. */
async function mojeek(query, session, page = 1) {
  const offset = (page - 1) * 10 + 1;
  const html = await fetchText(
    'https://www.mojeek.com/search?q=' + encodeURIComponent(query) + (page > 1 ? '&s=' + offset : ''), session);
  if (looksLikeChallenge(html)) throw new Error('bot check');

  const out = [];
  for (const li of eachTag(html, 'li')) {
    let url = '';
    let title = '';
    for (const a of eachTag(li.inner, 'a')) {
      const href = decodeEntities(attrOf(a.attrs, 'href'));
      if (!/^https?:\/\//i.test(href)) continue;
      try { if (/(^|\.)mojeek\.com$/i.test(new URL(href).hostname)) continue; } catch { continue; }
      url = href; title = stripTags(a.inner); break;
    }
    if (!url || title.length < 2) continue;
    let snippet = '';
    for (const p of eachTag(li.inner, 'p')) {
      if (hasClass(p.attrs, 's')) { snippet = stripTags(p.inner); break; }
    }
    out.push({ title, url, snippet, source: 'mojeek' });
  }
  if (!out.length) throw new Error('no results parsed');
  return out;
}

/** Wikipedia summary card - a real answer instead of a scraped snippet. */
async function wikipedia(query, session) {
  try {
    const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
      encodeURIComponent(query) + '&srlimit=1&format=json';
    const json = JSON.parse(await fetchText(searchUrl, session, { timeout: 12000 }));
    const hit = json && json.query && json.query.search && json.query.search[0];
    if (!hit) return null;

    const sum = JSON.parse(await fetchText(
      'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.title.replace(/ /g, '_')),
      session, { timeout: 12000 }));
    if (!sum || sum.type === 'disambiguation' || !sum.extract) return null;

    return {
      title: sum.title,
      extract: sum.extract,
      url: (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) ||
           ('https://en.wikipedia.org/wiki/' + encodeURIComponent(hit.title)),
      thumbnail: (sum.thumbnail && sum.thumbnail.source) || '',
      source: 'Wikipedia'
    };
  } catch { return null; }
}

/* ------------------------------------------------------------------ merging */

function normalizeKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/+$/, '').toLowerCase();
  } catch { return url; }
}

// Broad indexes carry more weight than niche ones, so a specialist engine's top
// hit does not outrank the obvious answer on an everyday query.
const WEIGHT = { duckduckgo: 1, mojeek: 0.85, marginalia: 0.55 };

// How long a supporting engine or the answer card may delay the results page.
const SECONDARY_DEADLINE = 6000;

function fuse(lists, limit, strip) {
  const byKey = new Map();
  for (const list of lists) {
    list.forEach((r, idx) => {
      if (!r || !r.url) return;
      const url = strip ? stripTracking(r.url) : r.url;
      const key = normalizeKey(url);
      const score = (WEIGHT[r.source] || 0.7) / (60 + idx + 1);
      const seen = byKey.get(key);
      if (seen) {
        seen.score += score;
        if (!seen.snippet && r.snippet) seen.snippet = r.snippet;
        if (!seen.sources.includes(r.source)) seen.sources.push(r.source);
      } else {
        byKey.set(key, { title: r.title, url, snippet: r.snippet || '', score, sources: [r.source] });
      }
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function softCap(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })
  ]);
}

/* ------------------------------------------------------------------ public */

const DIRECT_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  mojeek:     'https://www.mojeek.com/search?q=%s',
  startpage:  'https://www.startpage.com/sp/search?query=%s',
  brave:      'https://search.brave.com/search?q=%s',
  wikipedia:  'https://en.wikipedia.org/wiki/Special:Search?search=%s',
  marginalia: 'https://old-search.marginalia.nu/search?query=%s'
};

class SearchEngine {
  constructor(settings, session) {
    this.settings = settings;
    this.session = session;   // throwaway session: no cookies follow a query
    // Page tokens for the query on screen, in memory only, replaced whenever
    // the query changes. Nothing here is written down or kept afterwards.
    this.cursor = { query: '', pages: [] };
  }

  /**
   * Resolving the system proxy on a cold session can take twenty seconds, which
   * would otherwise land entirely on the first search. This does that work at
   * startup and sends nothing to any search engine.
   */
  warmUp() {
    try { this.session.resolveProxy('https://lite.duckduckgo.com/').catch(() => {}); } catch {}
  }

  resolveBang(query) {
    const m = /(?:^|\s)!([a-z0-9_+-]{1,16})(?:\s+|$)/i.exec(query);
    if (!m) return null;
    const template = (this.settings.get('search.bangs', {}) || {})[m[1].toLowerCase()];
    if (!template) return null;
    const rest = (query.slice(0, m.index) + ' ' + query.slice(m.index + m[0].length)).trim();
    return template.replace('%s', encodeURIComponent(rest));
  }

  externalUrl(query) {
    const engine = this.settings.get('search.engine', 'veil');
    const tpl = engine === 'custom'
      ? (this.settings.get('search.customUrl') || DIRECT_ENGINES.duckduckgo)
      : (DIRECT_ENGINES[engine] || DIRECT_ENGINES.duckduckgo);
    return tpl.replace('%s', encodeURIComponent(query));
  }

  urlForQuery(query) {
    const bang = this.resolveBang(query);
    if (bang) return bang;
    if (this.settings.get('search.engine', 'veil') === 'veil') {
      return 'veil://search/?q=' + encodeURIComponent(query);
    }
    return this.externalUrl(query);
  }

  /**
   * Walk DuckDuckGo forward to the requested page, caching each page as it
   * arrives. Going back is then free and going deeper costs exactly one
   * request, because page N+1 cannot be asked for until page N has been read.
   */
  async ddgPage(query, page, errors) {
    if (this.cursor.query !== query) this.cursor = { query, pages: [] };
    const pages = this.cursor.pages;

    while (pages.length < page) {
      const first = pages.length === 0;
      const form = first ? null : pages[pages.length - 1].next;
      if (!first && !form) break;                 // upstream offered no further page

      try {
        let r = await ddgLite(query, this.session, form);
        // Throttling is transient; one unhurried retry usually clears it.
        if (r.throttled) {
          await sleep(1500);
          r = await ddgLite(query, this.session, form);
        }
        if (first && !r.results.length) r = await ddgHtml(query, this.session);
        if (r.throttled) errors.push('DuckDuckGo is rate-limiting requests - try again in a moment');
        pages.push(r);
        if (!r.results.length) break;
      } catch (e) {
        if (first) {
          try { pages.push(await ddgHtml(query, this.session)); continue; }
          catch (e2) { errors.push('DuckDuckGo: ' + e2.message); break; }
        }
        errors.push('DuckDuckGo: ' + e.message);
        break;
      }
    }

    return pages[page - 1] || { results: [], next: null };
  }

  async run(query, page = 1) {
    const started = Date.now();
    page = Math.max(1, Math.min(20, Number(page) || 1));

    const cfg = this.settings.get('search.backends', {}) || {};
    const limit = Math.max(5, Math.min(50, this.settings.get('search.resultCount', 20)));
    const strip = this.settings.get('search.stripTrackingParams', true);
    const errors = [];

    const ddgJob = cfg.duckduckgo !== false
      ? this.ddgPage(query, page, errors)
      : Promise.resolve({ results: [], next: null });

    const others = [];
    if (cfg.marginalia !== false) {
      others.push(softCap(
        marginalia(query, this.session, page).catch(e => { errors.push('Marginalia: ' + e.message); return []; }),
        SECONDARY_DEADLINE, []));
    }
    if (cfg.mojeek === true) {
      others.push(softCap(
        mojeek(query, this.session, page).catch(e => { errors.push('Mojeek: ' + e.message); return []; }),
        SECONDARY_DEADLINE, []));
    }

    // The answer card belongs to the query, not to page seven of its results.
    const answerJob = (page === 1 && cfg.wikipedia !== false)
      ? softCap(wikipedia(query, this.session), SECONDARY_DEADLINE, null)
      : Promise.resolve(null);

    const [ddg, otherLists, answer] = await Promise.all([ddgJob, Promise.all(others), answerJob]);
    const results = fuse([ddg.results, ...otherLists], limit, strip);

    return {
      query,
      page,
      hasNext: !!ddg.next && results.length > 0,
      results,
      answer,
      errors,
      took: Date.now() - started,
      fallbackUrl: this.externalUrl(query)
    };
  }
}

module.exports = { SearchEngine, DIRECT_ENGINES, stripTracking };
