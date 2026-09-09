'use strict';

/* The vertical tab bar.
 *
 * It renders in its own view so that it can float over the page rather than
 * push it aside, which means it owns its whole viewport and reports the width
 * it would like to be. The main process decides where to put it. */

const $ = (id) => document.getElementById(id);
const els = {
  rail: $('rail'), tabs: $('tabs'), shortcuts: $('shortcuts'),
  downloads: $('go-downloads'), settings: $('go-settings')
};

let state = { tabs: [], activeId: null };
let settings = null;
let downloads = [];

/* ------------------------------------------------------------------ tabs */

const tabEls = new Map();          // id -> { root, fav, title, close }

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function tabLabel(t) {
  if (t.title) return t.title;
  const host = hostOf(t.url);
  return host || 'New tab';
}

/* Elements are kept and updated rather than rebuilt, so that a click landing
   on a close button is not destroyed underneath the pointer mid-press. */
function makeTab(id) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.dataset.id = String(id);

  const fav = document.createElement('div');
  fav.className = 'fav';

  const title = document.createElement('div');
  title.className = 'title';

  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Close tab';
  close.innerHTML = '<svg class="icon"><use href="#i-x"/></svg>';
  close.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    veil.tab.close(Number(root.dataset.id));
  });

  root.addEventListener('mousedown', (e) => {
    if (e.target && e.target.closest && e.target.closest('.close')) return;
    const tabId = Number(root.dataset.id);
    if (e.button === 0) veil.tab.select(tabId);
    if (e.button === 1) { e.preventDefault(); veil.tab.close(tabId); }
  });

  root.append(fav, title, close);
  return { root, fav, title, close };
}

function updateTab(refs, t, active) {
  refs.root.classList.toggle('active', active);

  const label = tabLabel(t);
  if (refs.title.textContent !== label) {
    refs.title.textContent = label;
    refs.root.title = label;
  }

  const host = hostOf(t.url);
  let cls = 'fav', text = '', bg = '';
  if (t.loading) {
    cls = 'fav spin';
  } else if (t.url.startsWith('veil://')) {
    cls = 'fav internal';
    text = 'V';
  } else {
    text = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
    bg = 'hsl(' + hue(host) + ' 58% 62%)';
  }
  if (refs.fav.className !== cls) refs.fav.className = cls;
  if (refs.fav.textContent !== text) refs.fav.textContent = text;
  if (refs.fav.style.background !== bg) refs.fav.style.background = bg;
}

function renderTabs() {
  const live = new Set(state.tabs.map(t => t.id));
  for (const [id, refs] of [...tabEls]) {
    if (!live.has(id)) { refs.root.remove(); tabEls.delete(id); }
  }
  state.tabs.forEach((t, i) => {
    let refs = tabEls.get(t.id);
    if (!refs) { refs = makeTab(t.id); tabEls.set(t.id, refs); }
    updateTab(refs, t, t.id === state.activeId);
    if (els.tabs.children[i] !== refs.root) {
      els.tabs.insertBefore(refs.root, els.tabs.children[i] || null);
    }
  });
}

/* ------------------------------------------------------------- shortcuts */

function renderShortcuts() {
  const list = (settings && settings.browser && settings.browser.shortcuts) || [];
  els.shortcuts.textContent = '';
  els.shortcuts.hidden = list.length === 0;
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'shortcut';
    b.title = s.title + ' - ' + s.url;

    const mark = document.createElement('span');
    mark.className = 'mark';
    const host = hostOf(s.url);
    mark.textContent = ((s.title || host).trim()[0] || '?').toUpperCase();
    mark.style.background = 'hsl(' + hue(host || s.title) + ' 58% 62%)';

    b.append(mark);
    b.addEventListener('click', () => veil.nav.go(s.url));
    els.shortcuts.append(b);
  }
}

/* ------------------------------------------------------------- downloads */

function renderDownloads() {
  const n = downloads.length;
  let dot = els.downloads.querySelector('.dot');
  if (!n) { if (dot) dot.remove(); return; }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'dot';
    els.downloads.append(dot);
  }
  dot.textContent = n > 99 ? '99+' : String(n);
}

/* ------------------------------------------------------- width and peek

   Collapsed the rail shows icons only, and widens again while the pointer is
   on it. There is no button for that: a collapsed rail that hid its own
   expander left no way back. The width is reported on every frame of the
   animation so the main process can move in step.                          */

const PEEK_IN = 180, PEEK_OUT = 140, PEEK_MS = 170;
const RAIL_MIN = 52;
let peekTimer = null, peekRaf = 0, railW = RAIL_MIN;

function fullWidth() {
  const a = (settings && settings.appearance) || {};
  return Math.max(150, Math.min(420, Number(a.sidebarWidth) || 220));
}

function collapsed() { return els.rail.dataset.collapsed === '1'; }

function report() {
  veil.reportRail({ width: Math.round(railW) });
}

function slide(to, done) {
  cancelAnimationFrame(peekRaf);
  const from = railW;
  if (Math.round(from) === Math.round(to)) { if (done) done(); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / PEEK_MS);
    railW = from + (to - from) * (1 - Math.pow(1 - p, 3));
    report();
    if (p < 1) peekRaf = requestAnimationFrame(step);
    else if (done) done();
  };
  peekRaf = requestAnimationFrame(step);
}

function peek(on) {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    if (!collapsed()) { delete els.rail.dataset.peek; return; }
    if (on) { els.rail.dataset.peek = '1'; slide(fullWidth()); }
    else slide(RAIL_MIN, () => { delete els.rail.dataset.peek; report(); });
  }, on ? PEEK_IN : PEEK_OUT);
}

document.documentElement.addEventListener('mouseenter', () => peek(true));
document.documentElement.addEventListener('mousemove', () => peek(true));
document.documentElement.addEventListener('mouseleave', () => peek(false));

/* ---------------------------------------------------------------- wiring */

function applySettings(s) {
  settings = s;
  const a = (s && s.appearance) || {};
  const isCollapsed = !!a.sidebarCollapsed;
  els.rail.dataset.collapsed = isCollapsed ? '1' : '0';
  els.rail.dataset.float = a.autoHideChrome ? '1' : '0';

  cancelAnimationFrame(peekRaf);
  clearTimeout(peekTimer);
  delete els.rail.dataset.peek;
  railW = isCollapsed ? RAIL_MIN : fullWidth();
  document.documentElement.style.setProperty('--rail-full', fullWidth() + 'px');

  renderShortcuts();
  report();
}

$('new-tab').addEventListener('click', () => veil.tab.open());
els.settings.addEventListener('click', () => veil.action('openInternal', 'veil://settings/'));
els.downloads.addEventListener('click', () => veil.action('openInternal', 'veil://downloads/'));

veil.on('tabs', (s) => { state = s; renderTabs(); });
veil.on('settings', (s) => { applySettings(s); });
veil.on('downloads', (d) => { downloads = Array.isArray(d) ? d : []; renderDownloads(); });

veil.getSettings().then((s) => { applySettings(s); veil.ready(); });
