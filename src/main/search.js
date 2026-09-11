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
    for (const [k, v] of Object.entries(opts.headers || {})) req.setHeader(k, v);
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


/* -------------------------------------------------------- generated images

   There is no reliable marker for an image made by a model - no header, no
   metadata that survives a re-host. What there is: a set of sites that exist
   only to publish them, and the words people put in the titles. Both are
   caught here, and both are guesses, so this is offered as a setting rather
   than done silently. It will miss things, and occasionally it will take
   something it should not.                                                  */

const AI_HOSTS = [
  'civitai.com', 'lexica.art', 'prompthero.com', 'openart.ai', 'playgroundai.com',
  'nightcafe.studio', 'creator.nightcafe.studio', 'artbreeder.com', 'midjourney.com',
  'leonardo.ai', 'ideogram.ai', 'craiyon.com', 'stablediffusionweb.com', 'deepai.org',
  'starryai.com', 'mage.space', 'tensor.art', 'seaart.ai', 'pixai.art', 'novelai.net',
  'dream.ai', 'getimg.ai', 'aiartshop.com', 'promptbase.com', 'imagine.art',
  'perchance.org', 'firefly.adobe.com'
];

const AI_WORDS = [
  'ai generated', 'ai-generated', 'aigenerated', 'generated by ai', 'made with ai',
  'ai art', 'ai-art', 'aiart', 'midjourney', 'stable diffusion', 'stable-diffusion',
  'dall-e', 'dall e', 'dalle 3', 'text to image', 'text-to-image', 'ai image',
  'ai portrait', 'ai upscal', 'flux dev', 'sdxl'
];

function looksGenerated(r) {
  const host = String(r.host || '').toLowerCase();
  if (AI_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
  const hay = (String(r.title || '') + ' ' + String(r.source || '')).toLowerCase();
  return AI_WORDS.some(w => hay.includes(w));
}


/* ---------------------------------------------------------- more verticals

   Videos and news come from endpoints of their own, which take the same
   per-query token the image search needs. Shopping does not exist as an
   endpoint at all - the shopping and product paths fall through to the generic
   instant-answer API and return nothing - so it is built out of image results
   narrowed to retailers. That gives pictures of the thing that link to the
   listing, which is most of what a shopping tab is for, but it cannot give
   prices, and nothing here pretends otherwise.                              */

const RETAIL_HOSTS = [
  'amazon.', 'ebay.', 'etsy.com', 'aliexpress.', 'temu.com', 'walmart.com',
  'target.com', 'bestbuy.com', 'costco.', 'newegg.com', 'homedepot.com',
  'lowes.com', 'wayfair.', 'ikea.com', 'bhphotovideo.com', 'argos.co.uk',
  'currys.co.uk', 'johnlewis.com', 'screwfix.com', 'diy.com', 'very.co.uk',
  'ao.com', 'appliancesdirect.co.uk', 'jbhifi.com.au', 'officeworks.com.au',
  'kogan.com', 'catch.com.au', 'bigw.com.au', 'kmart.com.au', 'myer.com.au',
  'harveynorman.', 'thegoodguys.com.au', 'bunnings.com.au', 'woolworths.',
  'coles.com.au', 'flipkart.com', 'shopee.', 'lazada.', 'rakuten.',
  'zalando.', 'asos.com', 'next.co.uk', 'marksandspencer.com'
];

function isRetail(host) {
  const h = String(host || '').toLowerCase();
  return RETAIL_HOSTS.some(r => h.includes(r));
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** The token both of these need, with one retry for a cold network stack. */
async function vqdFor(query, session, ia) {
  const url = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&ia=' + ia;
  let html;
  try { html = await fetchText(url, session, { timeout: 9000 }); }
  catch { html = await fetchText(url, session, { timeout: 15000 }); }
  const m = /vqd=["']?([-\w]+)["']?/.exec(html);
  if (!m) throw new Error('no token');
  return { token: m[1], from: url };
}

async function ddgVideos(query, session, page = 1) {
  const vqd = await vqdFor(query, session, 'videos');
  const offset = (Math.max(1, page) - 1) * 60;
  const url = 'https://duckduckgo.com/v.js?l=us-en&o=json&q=' + encodeURIComponent(query) +
              '&vqd=' + encodeURIComponent(vqd.token) + '&f=,,,&p=1&s=' + offset;
  const body = await fetchText(url, session, {
    headers: { 'Referer': vqd.from, 'Accept': 'application/json' }
  });

  let data;
  try { data = JSON.parse(body); } catch { throw new Error('unreadable reply'); }

  return (Array.isArray(data.results) ? data.results : []).map(r => ({
    title: decodeHtml(r.title).slice(0, 200),
    url: String(r.content || ''),
    description: decodeHtml(r.description).slice(0, 300),
    thumbnail: String((r.images && (r.images.medium || r.images.large || r.images.small)) || ''),
    duration: String(r.duration || ''),
    publisher: String(r.publisher || r.provider || ''),
    uploader: String(r.uploader || ''),
    published: String(r.published || ''),
    views: Number((r.statistics && r.statistics.viewCount) || 0)
  })).filter(r => /^https?:/i.test(r.url) && r.title);
}

async function ddgNews(query, session, page = 1) {
  const vqd = await vqdFor(query, session, 'news');
  const offset = (Math.max(1, page) - 1) * 30;
  const url = 'https://duckduckgo.com/news.js?l=us-en&o=json&q=' + encodeURIComponent(query) +
              '&vqd=' + encodeURIComponent(vqd.token) + '&noamp=1&p=1&s=' + offset;
  const body = await fetchText(url, session, {
    headers: { 'Referer': vqd.from, 'Accept': 'application/json' }
  });

  let data;
  try { data = JSON.parse(body); } catch { throw new Error('unreadable reply'); }

  return (Array.isArray(data.results) ? data.results : []).map(r => ({
    title: decodeHtml(r.title).slice(0, 220),
    url: String(r.url || ''),
    excerpt: decodeHtml(r.excerpt).slice(0, 400),
    source: String(r.source || ''),
    image: String(r.image || ''),
    when: String(r.relative_time || ''),
    date: Number(r.date) || 0
  })).filter(r => /^https?:/i.test(r.url) && r.title)
    // The endpoint returns these by relevance, which for a news tab means the
    // top of the page can be years old. Newest first is what "news" means.
    .sort((a, b) => b.date - a.date);
}

/* -------------------------------------------------------------------- images

   DuckDuckGo's image endpoint needs a token it only hands out on the HTML page
   for the same query, so this is two requests: one to be given the token, one
   to use it. The token is per query and short lived, which is why it is not
   worth caching beyond the run.                                              */

async function ddgImages(query, session, page = 1) {
  // One attempt, not two. The retry here used to exist to cover a cold network
  // stack, and it meant a blocked DuckDuckGo cost twenty-four seconds before
  // anything else was tried. Bing now covers both cases, and covers them in
  // three and a half seconds.
  const tokenUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iax=images&ia=images';
  const html = await fetchText(tokenUrl, session, { timeout: 9000 });

  const m = /vqd=["']?([-\w]+)["']?/.exec(html) || /vqd=([-\d]+)/.exec(html);
  if (!m) throw new Error('no token');

  const offset = (Math.max(1, page) - 1) * 50;
  const url = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(query) +
              '&vqd=' + encodeURIComponent(m[1]) + '&f=,,,&p=1&s=' + offset;

  // The referer is the page the token came from, which is what a browser
  // actually sends here. The bare origin is one of the things DuckDuckGo
  // takes as a sign the request did not come from its own page.
  const body = await fetchText(url, session, {
    headers: { 'Referer': tokenUrl, 'Accept': 'application/json, text/javascript' }
  });

  let data;
  try { data = JSON.parse(body); } catch { throw new Error('unreadable reply'); }
  const list = Array.isArray(data.results) ? data.results : [];

  // Related searches, as the chips above the grid. `text` is the whole refined
  // query rather than just the new word, so a chip stays tied to what was asked.
  const expansions = (Array.isArray(data.query_expansions) ? data.query_expansions : [])
    .map(e => ({
      label: String(e.displayText || '').slice(0, 60),
      query: String(e.text || e.displayText || '').slice(0, 120),
      thumbnail: String((e.thumbnail && e.thumbnail.thumbnailUrl) || '')
    }))
    .filter(e => e.label && e.query)
    .slice(0, 24);

  const results = list.map(r => ({
    title: String(r.title || '').slice(0, 200),
    image: String(r.image || ''),
    thumbnail: String(r.thumbnail || r.image || ''),
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
    source: String(r.url || ''),
    host: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })()
  })).filter(r => /^https:/i.test(r.thumbnail) && /^https?:/i.test(r.source));

  return { results, expansions };
}

/* --------------------------------------------------------- a second source

   DuckDuckGo's picture, video and news endpoints all want a token it only
   hands out on the HTML page for that query, and it refuses that page - or the
   endpoint itself, with a 403 - whenever it decides the traffic looks
   automated. It does that often enough that a search for "dog" could fail for
   no reason the user could see or act on.

   So none of these verticals depend on one source any more. Bing answers the
   same three questions without a token: an async fragment for pictures and
   videos, and an RSS feed for news. It is asked only when DuckDuckGo has
   already failed or come back empty, and the results page says which one
   answered.                                                                  */

function bingUrl(pathAndQuery) { return 'https://www.bing.com' + pathAndQuery; }

const BING_HEADERS = {
  'Referer': 'https://www.bing.com/',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
};

/** The one JSON blob Bing hangs off each result, as an object. */
function attrJson(attrs, name) {
  const raw = attrOf(attrs, name);
  if (!raw) return null;
  try { return JSON.parse(decodeEntities(raw)); } catch { return null; }
}

async function bingImages(query, session, page = 1) {
  const first = (Math.max(1, page) - 1) * 35 + 1;
  const html = await fetchText(bingUrl(
    '/images/async?q=' + encodeURIComponent(query) +
    '&first=' + first + '&count=35&mmasync=1'), session, { headers: BING_HEADERS, timeout: 9000 });

  if (looksLikeChallenge(html)) throw new Error('bot check');

  // Each result is an anchor carrying a JSON blob, wrapped around the
  // thumbnail image. The image is where the shape of the picture comes from:
  // the blob has no dimensions, and the justified rows need a ratio.
  const out = [];
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass="iusc"[^>]*)>/gi)];
  anchors.forEach((a, i) => {
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const chunk = html.slice(a.index, end);
    const m = attrJson(a[1], 'm');
    if (!m || !m.murl || !m.purl) return;

    const img = /<img\b([^>]*\bclass="mimg"[^>]*)>/i.exec(chunk);
    const thumb = img ? decodeEntities(attrOf(img[1], 'src')) : '';
    const w = img ? Number(attrOf(img[1], 'width')) : 0;
    const h = img ? Number(attrOf(img[1], 'height')) : 0;

    out.push({
      title: decodeHtml(m.t || '').slice(0, 200),
      image: String(m.murl),
      thumbnail: thumb || String(m.turl || m.murl),
      // These are the thumbnail's dimensions, not the original's. They carry
      // the one thing the grid needs - the shape - and saying so is better
      // than printing a made-up size under the picture, so the viewer is told
      // they are approximate.
      width: Number.isFinite(w) ? w : 0,
      height: Number.isFinite(h) ? h : 0,
      approxSize: true,
      source: String(m.purl),
      host: (() => { try { return new URL(m.purl).hostname.replace(/^www\./, ''); } catch { return ''; } })()
    });
  });

  return { results: out.filter(r => /^https?:/i.test(r.thumbnail) && /^https?:/i.test(r.source)), expansions: [] };
}

async function bingVideos(query, session, page = 1) {
  const first = (Math.max(1, page) - 1) * 30 + 1;
  const html = await fetchText(bingUrl(
    '/videos/asyncv2?q=' + encodeURIComponent(query) +
    '&async=content&first=' + first + '&count=30&mmasync=1'), session,
    { headers: BING_HEADERS, timeout: 9000 });

  if (looksLikeChallenge(html)) throw new Error('bot check');

  // The thumbnail lives in one attribute and everything else in another, on
  // different elements of the same card. They are joined on the video's URL
  // rather than on position, which no longer holds when a card is missing one.
  const thumbs = new Map();
  for (const m of html.matchAll(/\bmmeta="([^"]*)"/gi)) {
    try {
      const j = JSON.parse(decodeEntities(m[1]));
      if (j && j.murl && j.turl) thumbs.set(String(j.murl), String(j.turl));
    } catch {}
  }

  const cards = [...html.matchAll(/\bvrhm="([^"]*)"/gi)];
  const out = [];
  cards.forEach((c, i) => {
    let j = null;
    try { j = JSON.parse(decodeEntities(c[1])); } catch { return; }
    if (!j || !j.murl || !j.vt) return;

    const end = i + 1 < cards.length ? cards[i + 1].index : html.length;
    const chunk = html.slice(c.index, end);
    const views = /meta_vc_content">([^<]+)/i.exec(chunk);
    const publisher = /mc_vtvc_meta_row"><span>([^<]+)/i.exec(chunk);
    const channel = /mc_vtvc_meta_row_channel">([^<]+)/i.exec(chunk);

    out.push({
      title: decodeHtml(j.vt).slice(0, 200),
      url: String(j.murl),
      description: '',
      thumbnail: thumbs.get(String(j.murl)) ||
                 (j.thid ? 'https://tse1.mm.bing.net/th?id=' + encodeURIComponent(j.thid) + '&pid=Api' : ''),
      duration: String(j.du || ''),
      publisher: publisher ? decodeHtml(publisher[1]) : '',
      uploader: channel ? decodeHtml(channel[1]) : '',
      published: '',
      views: 0,
      // Already written out as "2.7M views"; there is no number behind it to
      // format, so the page is handed the words.
      viewsText: views ? decodeHtml(views[1]).replace(/\s*views?$/i, '') : ''
    });
  });

  return out.filter(v => /^https?:/i.test(v.url));
}

/** Bing publishes news as RSS, which needs no token and no scraping at all. */
async function bingNews(query, session, page = 1) {
  const first = (Math.max(1, page) - 1) * 10 + 1;
  const xml = await fetchText(bingUrl(
    '/news/search?q=' + encodeURIComponent(query) + '&format=RSS&first=' + first), session,
    { headers: BING_HEADERS, timeout: 9000 });

  const pick = (block, tag) => {
    const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
    return m ? decodeEntities(m[1]).replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : '';
  };

  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1];
    // Bing wraps every link in a click tracker with the real address inside it.
    const url = unwrapRedirect(pick(block, 'link'));
    const title = stripTags(pick(block, 'title'));
    if (!/^https?:/i.test(url) || !title) continue;

    const when = pick(block, 'pubDate');
    const date = Math.floor(Date.parse(when) / 1000);
    // The image comes as a template: the feed says where to put the size.
    const image = pick(block, 'News:Image');

    out.push({
      title: title.slice(0, 220),
      url,
      excerpt: stripTags(pick(block, 'description')).slice(0, 400),
      source: stripTags(pick(block, 'News:Source')),
      image: image ? image + '&w=400&h=225&c=14' : '',
      when: relativeWhen(date),
      date: Number.isFinite(date) ? date : 0
    });
  }
  return out.sort((a, b) => b.date - a.date);
}

/** "3 days ago", from a unix timestamp. The RSS gives an absolute date only. */
function relativeWhen(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const mins = Math.floor((Date.now() / 1000 - sec) / 60);
  if (mins < 2) return 'just now';
  if (mins < 60) return mins + ' minutes ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hours / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  const months = Math.round(days / 30);
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  return Math.round(days / 365) + ' years ago';
}

/**
 * Ask the sources in order, and take the first that actually answers.
 *
 * "Answers" means came back with something: a source that returns an empty
 * list has not answered the question, it has just failed quietly, and falling
 * through to the next one is the whole point of having a second.
 *
 * The next source is started either when the one before it fails, or when it
 * has been quiet for `hedgeMs` - so a source that is being slow rather than
 * refusing does not hold up the page, and a source that is working is still
 * the one whose answer gets used. Both may end up in flight; whichever comes
 * back first with results wins.
 *
 * Every failure is kept, so that when none of them worked the page can say
 * what each one said rather than "search failed".
 */
const HEDGE_MS = 3500;

function firstAnswer(attempts, hedgeMs = HEDGE_MS) {
  return new Promise((resolve) => {
    const notes = [];
    const timers = [];
    let started = 0;
    let running = 0;
    let done = false;

    const finish = (value, source) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve({ value, source, notes });
    };

    const next = () => {
      if (done || started >= attempts.length) return;
      const [name, run] = attempts[started++];
      running++;

      // The hedge. A source that has not answered by now is not necessarily
      // broken - but waiting out its whole timeout before even asking the
      // next one is what turned a blocked DuckDuckGo into a twenty-second
      // wait on a search for "dog".
      timers.push(setTimeout(next, hedgeMs));

      Promise.resolve().then(run).then(
        (value) => {
          running--;
          const list = Array.isArray(value) ? value : (value && value.results) || [];
          if (list.length) return finish(value, name);
          notes.push(name + ' had nothing for it');
          next();
          if (!running && started >= attempts.length) finish(null, '');
        },
        (e) => {
          running--;
          notes.push(name + ': ' + (e.message || 'failed'));
          next();
          if (!running && started >= attempts.length) finish(null, '');
        }
      );
    };

    next();
  });
}

/** What to put on the page when nothing came back. */
function whyNot(what, got, rawCount) {
  if (rawCount > 0) return 'Every result was filtered out.';
  return 'No ' + what + ' came back. ' + (got.notes.length ? got.notes.join('. ') + '.' : '');
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

/**
 * How long the main engine gets before the page is drawn without it.
 *
 * DuckDuckGo can take two attempts of fifteen seconds each when it is being
 * throttled or blocked, and a search that sits there for half a minute reads
 * as a broken browser rather than a slow engine. Past this point the results
 * that did arrive are shown, with a line saying who did not answer. The
 * request is not cancelled - if it lands later it goes into the page cache
 * and the next page of that search is instant.
 */
const PRIMARY_DEADLINE = 12000;

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

  /** Image results, kept apart from the web ones: a different shape entirely. */
  async images(query, page = 1) {
    const q = String(query || '').trim();
    if (!q) return { query: q, page: 1, results: [], expansions: [], error: '' };
    const started = Date.now();

    const got = await firstAnswer([
      ['DuckDuckGo', () => ddgImages(q, this.session, page)],
      ['Bing', () => bingImages(q, this.session, page)]
    ]);

    const { results, expansions } = got.value || { results: [], expansions: [] };
    const hideAi = this.settings.get('search.hideAiImages', true);
    const kept = hideAi ? results.filter(r => !looksGenerated(r)) : results;

    return {
      query: q, page, results: kept, expansions: expansions || [],
      hidden: results.length - kept.length,
      source: got.source,
      took: Date.now() - started,
      error: kept.length ? '' : whyNot('pictures', got, results.length)
    };
  }

  /** Video results. A different shape again, so it gets its own call. */
  async videos(query, page = 1) {
    const q = String(query || '').trim();
    if (!q) return { query: q, page: 1, results: [], error: '' };
    const started = Date.now();

    const got = await firstAnswer([
      ['DuckDuckGo', () => ddgVideos(q, this.session, page)],
      ['Bing', () => bingVideos(q, this.session, page)]
    ]);

    return {
      query: q, page, results: got.value || [], source: got.source,
      took: Date.now() - started,
      error: (got.value || []).length ? '' : whyNot('videos', got, 0)
    };
  }

  async news(query, page = 1) {
    const q = String(query || '').trim();
    if (!q) return { query: q, page: 1, results: [], error: '' };
    const started = Date.now();

    const got = await firstAnswer([
      ['DuckDuckGo', () => ddgNews(q, this.session, page)],
      ['Bing', () => bingNews(q, this.session, page)]
    ]);

    return {
      query: q, page, results: got.value || [], source: got.source,
      took: Date.now() - started,
      error: (got.value || []).length ? '' : whyNot('stories', got, 0)
    };
  }

  /**
   * Shopping, such as it can be.
   *
   * There is no shopping endpoint to ask, so this narrows image results to
   * retailers: a picture of the thing that links to the listing. No prices -
   * they are not in anything Veil can see - and the page says so rather than
   * leaving a gap where a number should be.
   */
  async shopping(query, page = 1) {
    const q = String(query || '').trim();
    if (!q) return { query: q, page: 1, results: [], error: '' };
    const started = Date.now();

    const got = await firstAnswer([
      ['DuckDuckGo', () => ddgImages(q, this.session, page)],
      ['Bing', () => bingImages(q, this.session, page)]
    ]);

    const results = (got.value && got.value.results) || [];
    let shops = results.filter(r => isRetail(r.host));
    let scanned = results.length;

    // A thin first pass is worth a second, differently worded one: asking for
    // the thing "for sale" moves the balance of a picture search towards
    // listings. Measured rather than assumed - it is a few more each time, not
    // a transformation - so it is only done when the first pass was thin.
    if (shops.length < 8 && results.length) {
      const more = await firstAnswer([
        ['DuckDuckGo', () => ddgImages(q + ' for sale', this.session, page)],
        ['Bing', () => bingImages(q + ' for sale', this.session, page)]
      ]).catch(() => null);

      const extra = (more && more.value && more.value.results) || [];
      const seen = new Set(shops.map(r => r.image));
      for (const r of extra) {
        if (isRetail(r.host) && !seen.has(r.image)) { seen.add(r.image); shops.push(r); }
      }
      scanned += extra.length;
    }

    return {
      query: q, page, results: shops,
      scanned,
      source: got.source,
      took: Date.now() - started,
      error: shops.length ? ''
        : results.length ? 'Nothing from a retailer Veil recognises in these results.'
        : whyNot('listings', got, 0)
    };
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
      ? softCap(this.ddgPage(query, page, errors), PRIMARY_DEADLINE, { results: [], next: null, late: true })
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
    if (ddg.late) errors.push('DuckDuckGo did not answer in time - showing what the other engines found');
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
