'use strict';

const $ = (id) => document.getElementById(id);

const PAGE_SIZE = 25;
let shown = PAGE_SIZE;
let summary = null;

function number(n) {
  return Number(n || 0).toLocaleString();
}

function sinceText(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !ts) return 'since you started';
  return 'since ' + d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The four headline figures. */
function renderFigures(s) {
  const kinds = s.byKind || {};
  const advert = Number(kinds.advert || 0);
  const tracker = Number(kinds.tracker || 0);
  const cards = [
    { n: number(s.total), k: 'requests blocked, ' + sinceText(s.since) },
    { n: number(advert), k: 'matched an advert list', kind: 'advert' },
    { n: number(tracker), k: 'matched a tracking list', kind: 'tracker' },
    { n: number(s.domainCount), k: 'distinct domains turned away' }
  ];

  $('figures').replaceChildren(...cards.map(c => {
    const box = document.createElement('div');
    box.className = 'figure';
    if (c.kind) box.dataset.kind = c.kind;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = c.n;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = c.k;
    box.append(n, k);
    return box;
  }));
}

/**
 * Thirty bars. Days with nothing blocked still get a bar, at the floor, so a
 * quiet day reads as a quiet day rather than as a gap in the record.
 */
function renderChart(s) {
  const days = Array.isArray(s.days) ? s.days : [];
  const chart = $('chart');

  if (days.length === 0) {
    chart.replaceChildren();
    $('axis-from').textContent = 'nothing counted yet';
    $('axis-to').textContent = '';
    return;
  }

  const peak = days.reduce((m, d) => Math.max(m, d.n || 0), 0) || 1;
  const last = days[days.length - 1];

  chart.replaceChildren(...days.map(d => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = Math.max(2, Math.round((d.n / peak) * 100)) + '%';
    if (d === last) bar.dataset.today = '1';
    bar.title = d.date + ': ' + number(d.n) + ' blocked';
    return bar;
  }));

  const from = new Date(days[0].date + 'T00:00:00');
  $('axis-from').textContent = Number.isFinite(from.getTime())
    ? from.toLocaleDateString([], { day: 'numeric', month: 'short' })
    : days[0].date;
  $('axis-to').textContent = 'busiest day ' + number(peak);
}

function renderTable(s) {
  const top = Array.isArray(s.top) ? s.top : [];
  const wrap = $('table-wrap');

  if (top.length === 0) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.style.margin = '0';
    p.textContent = 'Nothing blocked yet. Browse for a minute and come back.';
    wrap.replaceChildren(p);
    $('show-more').hidden = true;
    return;
  }

  const table = document.createElement('table');
  table.className = 'domains';

  const head = document.createElement('tr');
  for (const [text, cls] of [['Domain', 'domain'], ['List', ''], ['Blocked', 'n']]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls === 'n') th.style.textAlign = 'right';
    head.appendChild(th);
  }
  const thead = document.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  const body = document.createElement('tbody');
  for (const row of top.slice(0, shown)) {
    const tr = document.createElement('tr');

    const domain = document.createElement('td');
    domain.className = 'domain';
    domain.textContent = row.domain;

    const kind = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.kind = row.kind || 'other';
    tag.textContent = row.kind === 'advert' ? 'advert'
      : row.kind === 'tracker' ? 'tracking'
      : row.kind === 'custom' ? 'your rule'
      : 'list';
    kind.appendChild(tag);

    const n = document.createElement('td');
    n.className = 'n';
    n.textContent = number(row.n);

    tr.append(domain, kind, n);
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.replaceChildren(table);

  const more = $('show-more');
  more.hidden = top.length <= shown;
  more.textContent = 'Show more (' + number(top.length - shown) + ' left)';
}

function render(s) {
  summary = s;
  renderFigures(s);
  renderChart(s);
  renderTable(s);
  $('toggle').setAttribute('aria-checked', s.enabled ? 'true' : 'false');
}

async function load() {
  try {
    render(await window.veil.stats.summary());
  } catch (e) {
    $('table-wrap').textContent = 'Could not read the figures: ' + (e && e.message || e);
  }
}

$('show-more').addEventListener('click', () => {
  shown += PAGE_SIZE;
  renderTable(summary);
});

$('clear').addEventListener('click', async () => {
  shown = PAGE_SIZE;
  render(await window.veil.stats.clear());
});

$('toggle').addEventListener('click', async () => {
  const next = $('toggle').getAttribute('aria-checked') !== 'true';
  $('toggle').setAttribute('aria-checked', next ? 'true' : 'false');
  await window.veil.setSettings({ privacy: { blockStats: next } });
  load();
});

load();
// The numbers move while you read them, which is the point of the page.
setInterval(load, 5000);
