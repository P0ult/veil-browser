'use strict';

const $ = (id) => document.getElementById(id);
const params = new URL(location.href).searchParams;
const query = params.get('q') || '';
const page = Math.max(1, Math.min(20, Number(params.get('p')) || 1));

function pageUrl(n) {
  return 'veil://search/?q=' + encodeURIComponent(query) + (n > 1 ? '&p=' + n : '');
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

function renderPager(data) {
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

  if (!query) {
    $('out').replaceChildren();
    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML = '<h2>What are you looking for?</h2>';
    $('out').append(box);
    $('q').focus();
    return;
  }

  $('out').replaceChildren(skeleton());

  const data = await veil.search(query, page);
  const out = document.createDocumentFragment();

  if (data.answer) out.append(renderAnswer(data.answer));

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
