'use strict';

const $ = (id) => document.getElementById(id);
const params = new URL(location.href).searchParams;
const query = params.get('q') || '';
const page = Math.max(1, Math.min(20, Number(params.get('p')) || 1));

// Which vertical is showing. Kept in the address so a result page can be
// returned to, and so a chip or a tab is an ordinary navigation.
const VERTICALS = [
  ['web', 'Web'], ['images', 'Images'], ['videos', 'Videos'],
  ['news', 'News'], ['shopping', 'Shopping']
];
const vertical = VERTICALS.some(v => v[0] === params.get('t')) ? params.get('t') : 'web';

function pageUrl(n, t, q) {
  const which = t || vertical;
  return 'veil://search/?q=' + encodeURIComponent(q || query) +
         (n > 1 ? '&p=' + n : '') +
         (which === 'images' ? '&t=images' : '');
}

/* ------------------------------------------------------------- verticals */

function renderVerticals() {
  const bar = $('verticals');
  bar.replaceChildren();
  if (!query) return;
  for (const [id, label] of VERTICALS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-selected', id === vertical ? 'true' : 'false');
    if (id !== vertical) b.addEventListener('click', () => veil.go(pageUrl(1, id)));
    bar.append(b);
  }
}

/* ---------------------------------------------------------------- images */


/* ------------------------------------------------------------- the viewer

   Clicking a picture opens it at full size over the page rather than sending
   you to the site it came from. That is nearly always what a click on a search
   thumbnail means, and the trip to the source is still one button away.

   The full image is loaded from its own host; if it refuses - hotlink
   protection, a dead link, a redirect to a login - the thumbnail that is
   already on screen stays as the fallback rather than leaving a black hole. */

let shown = [];        // the pictures behind the current grid, for stepping through
let viewerAt = -1;

function viewerEl() {
  let el = document.getElementById('viewer');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'viewer';
  el.hidden = true;
  el.innerHTML =
    '<div class="sheet">' +
      '<button class="close" title="Close (Esc)">&#215;</button>' +
      '<button class="step prev" title="Previous">&#8249;</button>' +
      '<button class="step next" title="Next">&#8250;</button>' +
      '<div class="stage"><img alt=""></div>' +
      '<div class="info">' +
        '<div class="text"><h3></h3><div class="sub"></div></div>' +
        '<div class="acts">' +
          '<button class="btn page">Open page</button>' +
          '<button class="btn full">Open image</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  el.addEventListener('click', (e) => { if (e.target === el) closeViewer(); });
  el.querySelector('.close').addEventListener('click', closeViewer);
  el.querySelector('.prev').addEventListener('click', () => step(-1));
  el.querySelector('.next').addEventListener('click', () => step(1));
  el.querySelector('.page').addEventListener('click', () => {
    const im = shown[viewerAt];
    if (im) veil.go(im.source);
  });
  el.querySelector('.full').addEventListener('click', () => {
    const im = shown[viewerAt];
    if (im) veil.go(im.image || im.thumbnail);
  });

  document.body.append(el);
  return el;
}

function openViewer(index) {
  if (index < 0 || index >= shown.length) return;
  viewerAt = index;
  const im = shown[index];
  const el = viewerEl();

  const img = el.querySelector('.stage img');
  img.removeAttribute('src');
  img.referrerPolicy = 'no-referrer';
  // Show the thumbnail immediately, then let the full one replace it.
  img.src = im.thumbnail;
  if (im.image && im.image !== im.thumbnail) {
    const full = new Image();
    full.referrerPolicy = 'no-referrer';
    full.addEventListener('load', () => {
      if (viewerAt === index) img.src = im.image;
    });
    full.src = im.image;
  }

  el.querySelector('h3').textContent = im.title || im.host;
  const bits = [im.host];
  if (im.width && im.height) bits.push(im.width + ' \u00d7 ' + im.height);
  el.querySelector('.sub').textContent = bits.filter(Boolean).join('  \u00b7  ');

  el.querySelector('.prev').disabled = index <= 0;
  el.querySelector('.next').disabled = index >= shown.length - 1;

  el.hidden = false;
  document.body.dataset.viewer = '1';
  el.querySelector('.close').focus();
}

function closeViewer() {
  const el = document.getElementById('viewer');
  if (!el) return;
  el.hidden = true;
  viewerAt = -1;
  delete document.body.dataset.viewer;
}

function step(by) {
  const next = viewerAt + by;
  if (next >= 0 && next < shown.length) openViewer(next);
}

document.addEventListener('keydown', (e) => {
  if (viewerAt < 0) return;
  if (e.key === 'Escape') { e.preventDefault(); closeViewer(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});

/* A tile in a justified row.
 *
 * Rows are packed by the browser rather than by arithmetic here: each tile is
 * a flex item whose grow factor is its aspect ratio, so a row of them stretches
 * to exactly the container width and every tile in that row ends up the same
 * height. Wide pictures take more of the row than tall ones, which is what
 * stops the grid looking like a spreadsheet. */
function renderImage(im) {
  const ratio = (im.width && im.height) ? (im.width / im.height) : 1.5;

  const a = document.createElement('a');
  a.className = 'tile';
  a.href = im.source;
  a.title = (im.title || im.host) + ' - ' + im.host;
  a.style.flexGrow = String(ratio);
  a.style.flexBasis = Math.round(ratio * 190) + 'px';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openViewer(shown.indexOf(im));
  });

  const img = document.createElement('img');
  img.src = im.thumbnail;
  img.alt = '';
  img.loading = 'lazy';
  // Someone else's server; it does not need to know which page asked.
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => a.remove());
  a.append(img);

  const cap = document.createElement('span');
  cap.className = 'cap';
  cap.textContent = im.title || im.host;
  a.append(cap);

  return a;
}

/* The related searches above the grid: a refinement of what was asked, not a
   new search. Each carries the whole refined query, so "Black Lab" on a search
   for dogs becomes "Black Lab Dog". */
function renderExpansions(list) {
  const bar = document.getElementById('expansions');
  bar.replaceChildren();
  bar.hidden = !list || !list.length;
  if (bar.hidden) return;

  for (const e of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'exp';
    b.title = 'Search for: ' + e.query;

    if (e.thumbnail) {
      const t = document.createElement('img');
      t.src = e.thumbnail;
      t.alt = '';
      t.loading = 'lazy';
      t.referrerPolicy = 'no-referrer';
      t.addEventListener('error', () => t.remove());
      b.append(t);
    }
    const label = document.createElement('span');
    label.textContent = e.label;
    b.append(label);

    b.addEventListener('click', () => veil.go(pageUrl(1, 'images', e.query)));
    bar.append(b);
  }
}

/* ---------------------------------------------------------------- videos */

function renderVideo(v) {
  const row = document.createElement('div');
  row.className = 'vid';

  const a = document.createElement('a');
  a.className = 'shot';
  a.href = v.url;
  a.title = v.title;
  a.addEventListener('click', (e) => { e.preventDefault(); veil.go(v.url); });
  if (v.thumbnail) {
    const img = document.createElement('img');
    img.src = v.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove());
    a.append(img);
  }
  if (v.duration) {
    const d = document.createElement('span');
    d.className = 'dur';
    d.textContent = v.duration;
    a.append(d);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const h = document.createElement('h3');
  const link = document.createElement('a');
  link.href = v.url;
  link.textContent = v.title;
  link.addEventListener('click', (e) => { e.preventDefault(); veil.go(v.url); });
  h.append(link);

  const meta = document.createElement('div');
  meta.className = 'sub';
  const bits = [v.publisher || v.uploader, v.views ? compact(v.views) + ' views' : '', when(v.published)];
  meta.textContent = bits.filter(Boolean).join('  \u00b7  ');

  const desc = document.createElement('p');
  desc.textContent = v.description;

  body.append(h, meta, desc);
  row.append(a, body);
  return row;
}

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return days + ' days ago';
  if (days < 365) return Math.round(days / 30) + ' months ago';
  return Math.round(days / 365) + ' years ago';
}

async function runVideos() {
  $('out').replaceChildren(skeleton());
  $('side').replaceChildren();
  const data = await veil.searchVideos(query, page);
  const out = document.createDocumentFragment();

  if (!data.results.length) {
    out.append(emptyBox('No videos', data.error));
  } else {
    const list = document.createElement('div');
    list.className = 'vids';
    for (const v of data.results) list.append(renderVideo(v));
    out.append(list);
  }
  meta([data.results.length ? data.results.length + ' videos' : '', secs(data.took)]);
  const nav = renderPager({ page, hasNext: data.results.length >= 30 });
  if (nav) out.append(nav);
  $('out').replaceChildren(out);
}

/* ------------------------------------------------------------------ news */

function renderNews(n) {
  const row = document.createElement('div');
  row.className = 'news';

  if (n.image) {
    const a = document.createElement('a');
    a.className = 'shot';
    a.href = n.url;
    a.addEventListener('click', (e) => { e.preventDefault(); veil.go(n.url); });
    const img = document.createElement('img');
    img.src = n.image;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => a.remove());
    a.append(img);
    row.append(a);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const src = document.createElement('div');
  src.className = 'sub';
  src.textContent = [n.source, n.when].filter(Boolean).join('  \u00b7  ');

  const h = document.createElement('h3');
  const link = document.createElement('a');
  link.href = n.url;
  link.textContent = n.title;
  link.addEventListener('click', (e) => { e.preventDefault(); veil.go(n.url); });
  h.append(link);

  const p = document.createElement('p');
  p.textContent = n.excerpt;

  body.append(src, h, p);
  row.append(body);
  return row;
}

async function runNews() {
  $('out').replaceChildren(skeleton());
  $('side').replaceChildren();
  const data = await veil.searchNews(query, page);
  const out = document.createDocumentFragment();

  if (!data.results.length) {
    out.append(emptyBox('No news', data.error));
  } else {
    const list = document.createElement('div');
    list.className = 'newslist';
    for (const n of data.results) list.append(renderNews(n));
    out.append(list);
  }
  meta([data.results.length ? data.results.length + ' stories' : '', secs(data.took)]);
  $('out').replaceChildren(out);
}

/* -------------------------------------------------------------- shopping */

async function runShopping() {
  document.body.dataset.vertical = 'shopping';
  $('out').replaceChildren(skeleton());
  $('side').replaceChildren();
  const data = await veil.searchShopping(query, page);
  shown = data.results;
  const out = document.createDocumentFragment();

  // Said once, plainly, rather than leaving an empty column where a price
  // would be: Veil has no source that gives prices.
  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Product pictures from retailers, linking to the listing. ' +
                     'Veil has no source for prices, so there are none here.';
  out.append(note);

  if (!data.results.length) {
    out.append(emptyBox('Nothing from a retailer', data.error));
  } else {
    const grid = document.createElement('div');
    grid.className = 'imgs';
    for (const im of data.results) grid.append(renderImage(im));
    for (let i = 0; i < 6; i++) {
      const filler = document.createElement('span');
      filler.className = 'tile filler';
      grid.append(filler);
    }
    out.append(grid);
  }
  meta([data.results.length ? data.results.length + ' listings' : '',
        data.scanned ? 'of ' + data.scanned + ' results' : '', secs(data.took)]);
  const nav = renderPager({ page, hasNext: data.results.length >= 10 });
  if (nav) out.append(nav);
  $('out').replaceChildren(out);
}

/* ------------------------------------------------------------- shared bits */

function emptyBox(heading, detail) {
  const box = document.createElement('div');
  box.className = 'empty';
  const h = document.createElement('h2');
  h.textContent = heading;
  box.append(h);
  if (detail) {
    const p = document.createElement('p');
    p.textContent = detail;
    box.append(p);
  }
  return box;
}

function secs(ms) { return ((ms || 0) / 1000).toFixed(1) + 's'; }

function meta(bits) {
  if (page > 1) bits = bits.concat(['page ' + page]);
  $('meta').textContent = bits.filter(Boolean).join('  \u00b7  ');
}

async function runImages() {
  document.body.dataset.vertical = 'images';
  $('out').replaceChildren(skeleton());
  $('side').replaceChildren();

  const data = await veil.searchImages(query, page);
  shown = data.results;
  renderExpansions(data.expansions);
  const out = document.createDocumentFragment();

  if (!data.results.length) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML = '<h2>No images</h2>';
    const p = document.createElement('p');
    p.textContent = data.error || 'Nothing came back for that.';
    box.append(p);
    out.append(box);
  } else {
    const grid = document.createElement('div');
    grid.className = 'imgs';
    for (const im of data.results) grid.append(renderImage(im));
    // Without these, the last row stretches its few tiles across the whole
    // width, which reads as a mistake rather than as the end of the results.
    for (let i = 0; i < 6; i++) {
      const filler = document.createElement('span');
      filler.className = 'tile filler';
      grid.append(filler);
    }
    out.append(grid);
  }

  const bits = [];
  if (data.results.length) bits.push(data.results.length + ' images');
  if (data.hidden) bits.push(data.hidden + ' AI-looking hidden');
  bits.push(((data.took || 0) / 1000).toFixed(1) + 's');
  if (page > 1) bits.push('page ' + page);
  $('meta').textContent = bits.join('  ·  ');

  if (data.results.length) {
    const nav = renderPager({ page, hasNext: data.results.length >= 40 });
    if (nav) out.append(nav);
  }

  $('out').replaceChildren(out);
}

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function prettyPath(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).slice(0, 3);
    return [u.hostname.replace(/^www\./, '')].concat(parts).join(' › ');
  } catch { return url; }
}

function skeleton() {
  const box = document.createElement('div');
  box.className = 'skeleton';
  for (let i = 0; i < 6; i++) {
    const g = document.createElement('div');
    g.innerHTML = '';
    g.style.width = [42, 88, 70][i % 3] + '%';
    if (i % 3 === 0) g.style.marginTop = '22px';
    box.append(g);
  }
  return box;
}

/* ---------------------------------------------------------------- render */

function renderAnswer(a) {
  const card = document.createElement('div');
  card.className = 'answer';

  if (a.thumbnail) {
    const img = document.createElement('img');
    img.src = a.thumbnail;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    card.append(img);
  }

  const body = document.createElement('div');
  const h = document.createElement('h2');
  const link = document.createElement('a');
  link.textContent = a.title;
  link.href = a.url;
  link.addEventListener('click', (e) => { e.preventDefault(); veil.go(a.url); });
  h.append(link);

  const p = document.createElement('p');
  p.textContent = a.extract;

  const src = document.createElement('div');
  src.className = 'src';
  src.textContent = a.source;

  body.append(h, p, src);
  card.append(body);
  return card;
}

function renderResult(r) {
  const el = document.createElement('div');
  el.className = 'result';
  const host = hostOf(r.url);

  const line = document.createElement('div');
  line.className = 'host';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.style.background = `hsl(${hue(host)} 58% 64%)`;
  glyph.textContent = (host[0] || '?').toUpperCase();
  const path = document.createElement('span');
  path.textContent = prettyPath(r.url);
  line.append(glyph, path);

  const h = document.createElement('h3');
  const a = document.createElement('a');
  a.textContent = r.title;
  a.href = r.url;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.button === 1) veil.openTab(r.url);
    else veil.go(r.url);
  });
  a.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); veil.openTab(r.url); } });
  h.append(a);

  el.append(line, h);

  if (r.snippet) {
    const p = document.createElement('p');
    p.textContent = r.snippet;
    el.append(p);
  }

  if (r.sources && r.sources.length > 1) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    for (const s of r.sources) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = s;
      tags.append(t);
    }
    el.append(tags);
  }

  return el;
}

function renderEmpty(data) {
  const box = document.createElement('div');
  box.className = 'empty';

  const h = document.createElement('h2');
  h.textContent = data.page > 1 ? 'Nothing on this page' : 'No results came back';
  const p = document.createElement('p');
  p.textContent = data.errors && data.errors.length
    ? 'The search backends did not answer: ' + data.errors.join(' · ')
    : 'Nothing matched that query.';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const btn = document.createElement('button');
  btn.className = 'btn primary';
  btn.textContent = 'Try it on DuckDuckGo';
  btn.addEventListener('click', () => veil.go(data.fallbackUrl));

  const retry = document.createElement('button');
  retry.className = 'btn';
  retry.textContent = 'Retry';
  retry.addEventListener('click', run);

  box.append(h, p, btn, retry);
  return box;
}

function renderPager(data) {   // { page, hasNext } - both verticals use this
  if (data.page <= 1 && !data.hasNext) return null;

  const nav = document.createElement('div');
  nav.className = 'pager';

  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = 'Previous';
  prev.disabled = data.page <= 1;
  prev.addEventListener('click', () => veil.go(pageUrl(data.page - 1)));

  const label = document.createElement('span');
  label.className = 'pager-page';
  label.textContent = 'Page ' + data.page;

  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = 'Next';
  next.disabled = !data.hasNext;
  next.addEventListener('click', () => veil.go(pageUrl(data.page + 1)));

  nav.append(prev, label, next);
  return nav;
}

/* -------------------------------------------------------------------- run */

async function run() {
  document.title = query ? query + (page > 1 ? ' · page ' + page : '') + ' — Veil' : 'Search';
  $('q').value = query;
  $('meta').textContent = '';

  document.body.dataset.vertical = vertical;
  renderVerticals();

  if (!query) {
    $('side').replaceChildren();
    $('out').replaceChildren();
    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML = '<h2>What are you looking for?</h2>';
    $('out').append(box);
    $('q').focus();
    return;
  }

  if (vertical === 'images') return runImages();
  if (vertical === 'videos') return runVideos();
  if (vertical === 'news') return runNews();
  if (vertical === 'shopping') return runShopping();

  $('out').replaceChildren(skeleton());
  $('side').replaceChildren();

  const data = await veil.search(query, page);
  const out = document.createDocumentFragment();

  // Google puts this in a column of its own, and it reads better there: the
  // results start at the top of the page instead of below a card.
  $('side').replaceChildren(data.answer ? renderAnswer(data.answer) : '');

  if (!data.results.length) {
    out.append(renderEmpty(data));
  } else {
    for (const r of data.results) out.append(renderResult(r));
  }

  const bits = [];
  if (data.results.length) bits.push(data.results.length + ' results');
  bits.push((data.took / 1000).toFixed(1) + 's');
  if (data.page > 1) bits.push('page ' + data.page);
  $('meta').textContent = bits.join('  ·  ');

  const pager = renderPager(data);
  if (pager) out.append(pager);

  $('out').replaceChildren(out);
}

/* ----------------------------------------------------------------- wiring */

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) veil.go(q);
});

$('mark').addEventListener('click', () => veil.go('veil://home/'));

veil.onSettings((s) => VeilTheme.apply(s));
veil.getSettings().then((s) => VeilTheme.apply(s));
run();
