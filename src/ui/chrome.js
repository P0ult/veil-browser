'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  chrome: $('chrome'), tabs: $('tabs'), url: $('url'), omnibox: $('omnibox'),
  scheme: $('scheme-icon'), shield: $('shield'), shieldCount: $('shield-count'),
  tunnel: $('tunnel'), tunnelLabel: $('tunnel-label'),
  back: $('nav-back'), fwd: $('nav-fwd'), reload: $('nav-reload'), home: $('nav-home'),
  findbar: $('findbar'), findInput: $('find-input'), findCount: $('find-count'),
  toast: $('toast'), toastText: $('toast-text'),
  prompt: $('prompt'), promptText: $('prompt-text'), promptActions: $('prompt-actions'),
  topbar: $('topbar'), toolbar: $('toolbar'),
  tabstrip: $('tabstrip'), topTabs: $('top-tabs'),
  wincontrols: $('wincontrols')
};

let state = { tabs: [], activeId: null };
let settings = null;
let editing = false;          // the user is typing in the omnibox
let loading = false;

/* ------------------------------------------------------------------ helpers */

function activeTab() {
  return state.tabs.find(t => t.id === state.activeId) || null;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** A stable colour per site, so tabs stay recognisable without fetching favicons. */
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function prettyUrl(url) {
  if (!url) return '';
  if (url === 'veil://home/' || url === 'veil://home') return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'veil:') {
      if (u.hostname === 'search') return u.searchParams.get('q') || 'veil://search';
      return 'veil://' + u.hostname;
    }
    let s = u.host + u.pathname + u.search + u.hash;
    if (u.protocol === 'http:') s = 'http://' + s;
    return s.replace(/\/$/, '') || u.host;
  } catch { return url; }
}

function tabLabel(t) {
  if (t.url.startsWith('veil://search')) {
    try { return 'Search · ' + (new URL(t.url).searchParams.get('q') || ''); } catch {}
  }
  if (t.url.startsWith('veil://home')) return 'New tab';
  if (t.url.startsWith('veil://settings')) return 'Settings';
  if (t.url.startsWith('veil://about')) return 'About Veil';
  return t.title || hostOf(t.url) || 'Loading…';
}

/* --------------------------------------------------------------- rendering */

// Tab elements are kept and updated in place rather than rebuilt. Rebuilding
// on every state push (which happens on each blocked request) threw away the
// element the pointer was already interacting with, so a click on the close
// button never completed.
const tabEls = new Map();   // id -> { root, fav, title, close }

function makeTab(id) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.dataset.id = String(id);
  root.draggable = true;

  const fav = document.createElement('span');

  const title = document.createElement('span');
  title.className = 'title';

  const close = document.createElement('span');
  close.className = 'close';
  close.title = 'Close tab';
  close.innerHTML = '<svg class="icon"><use href="#i-x"/></svg>';

  // mousedown, not click: the pointer-down on a tab selects it, and anything
  // that redraws the strip between press and release would cancel the click.
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
  let cls = 'fav';
  let text = '';
  let bg = '';
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

function renderToolbar() {
  const t = activeTab();
  els.back.disabled = !t || !t.canGoBack;
  els.fwd.disabled = !t || !t.canGoForward;

  loading = !!(t && t.loading);
  els.reload.firstElementChild.firstElementChild.setAttribute('href', loading ? '#i-stop' : '#i-reload');
  els.reload.title = loading ? 'Stop' : 'Reload (Ctrl+R)';

  if (!editing) {
    els.url.value = t ? prettyUrl(t.url) : '';
  }

  const url = t ? t.url : '';
  const use = els.scheme.firstElementChild;
  els.scheme.setAttribute('class', 'icon scheme');
  if (url.startsWith('veil://')) { use.setAttribute('href', '#i-veil'); els.scheme.classList.add('secure'); }
  else if (url.startsWith('https://')) { use.setAttribute('href', '#i-lock'); els.scheme.classList.add('secure'); }
  else if (url.startsWith('http://')) { use.setAttribute('href', '#i-globe'); els.scheme.classList.add('insecure'); }
  else { use.setAttribute('href', '#i-globe'); }

  const n = t ? t.blocked : 0;
  els.shieldCount.textContent = n > 999 ? '999+' : String(n);
  els.shield.classList.toggle('hit', n > 0);
  els.shield.title = n
    ? n + ' request' + (n === 1 ? '' : 's') + ' blocked on this page — click to pause blocking here'
    : 'Nothing blocked on this page — click to pause blocking here';
}

function render() {
  renderTabs();
  renderToolbar();
}

/* ------------------------------------------------------------------ omnibox */

els.url.addEventListener('focus', () => {
  editing = true;
  // Ctrl+L must not focus something the user cannot see.
  veil.action('holdChrome', true);
  const t = activeTab();
  if (t && !t.url.startsWith('veil://home')) els.url.value = t.url;
  requestAnimationFrame(() => els.url.select());
  els.omnibox.classList.add('focused');
});

els.url.addEventListener('blur', () => {
  editing = false;
  veil.action('holdChrome', false);
  if (els.chrome.dataset.chromeMode === 'centre') veil.closeCentre();
  els.omnibox.classList.remove('focused');
  renderToolbar();
});

els.url.addEventListener('keydown', (e) => {
  const centre = els.chrome.dataset.chromeMode === 'centre';
  if (e.key === 'Enter') {
    const value = els.url.value.trim();
    if (!value) return;
    editing = false;
    // A minimal new tab really is a new tab - it just did not exist until
    // there was something to put in it.
    if (centre || e.altKey) veil.nav.goNewTab(value);
    else veil.nav.go(value);
    els.url.value = '';
    els.url.blur();
    if (centre) veil.closeCentre();
  } else if (e.key === 'Escape') {
    editing = false;
    renderToolbar();
    els.url.blur();
    if (centre) veil.closeCentre();      // backing out leaves no empty tab
  }
});

/* The minimal new tab reuses this whole document; only its shape changes. */
veil.on('chromeMode', (mode) => {
  els.chrome.dataset.chromeMode = mode === 'centre' ? 'centre' : 'bar';
  if (mode === 'centre') { els.url.value = ''; }
  reportLayout();
});

/* ----------------------------------------------------------------- controls */

els.back.addEventListener('click', () => veil.nav.back());
els.fwd.addEventListener('click', () => veil.nav.forward());
els.home.addEventListener('click', () => veil.nav.home());
els.reload.addEventListener('click', (e) => {
  if (loading) veil.nav.stop();
  else veil.nav.reload(e.shiftKey);
});
$('new-tab').addEventListener('click', () => veil.tab.open());

$('menu').addEventListener('click', () => veil.menu());
els.shield.addEventListener('click', () => veil.shield());

$('win-min').addEventListener('click', () => veil.window.minimize());
$('win-max').addEventListener('click', () => veil.window.maximize());
$('win-close').addEventListener('click', () => veil.window.close());

els.tunnel.addEventListener('click', () => veil.tunnel.toggle());

/* --------------------------------------------------------------- tab drag */

let dragId = null;
els.tabs.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  dragId = Number(tab.dataset.id);
  tab.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', String(dragId)); } catch {}
});
els.tabs.addEventListener('dragend', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) tab.classList.remove('dragging');
  dragId = null;
});
els.tabs.addEventListener('dragover', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  const over = e.target.closest('.tab');
  if (!over) return;
  const overId = Number(over.dataset.id);
  if (overId === dragId) return;
  const index = state.tabs.findIndex(t => t.id === overId);
  const rect = over.getBoundingClientRect();
  const after = e.clientX > rect.left + rect.width / 2;
  veil.tab.move(dragId, index + (after ? 1 : 0));
});

/* ------------------------------------------------------------------- find */

let findOpen = false;

function openFind() {
  findOpen = true;
  els.findbar.hidden = false;
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) runFind(true);
}
function closeFind() {
  findOpen = false;
  els.findbar.hidden = true;
  els.findCount.textContent = '';
  veil.find.stop();
}
function runFind(forward = true, findNext = false) {
  const text = els.findInput.value;
  if (!text) { veil.find.stop(); els.findCount.textContent = ''; return; }
  veil.find.run(text, { forward, findNext });
}

els.findInput.addEventListener('input', () => runFind(true, false));
els.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runFind(!e.shiftKey, true); }
  if (e.key === 'Escape') closeFind();
});
$('find-next').addEventListener('click', () => runFind(true, true));
$('find-prev').addEventListener('click', () => runFind(false, true));
$('find-close').addEventListener('click', closeFind);

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function showToast(t) {
  if (!t || !t.text) return;
  els.toast.dataset.kind = t.kind || 'info';
  els.toastText.textContent = t.text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 5000);
}
$('toast-close').addEventListener('click', () => { clearTimeout(toastTimer); els.toast.hidden = true; });

/* -------------------------------------------------------------------- vpn */

const TUNNEL_LABEL = {
  off: 'Direct',
  downloading: 'Setting up',
  starting: 'Starting',
  bootstrapping: 'Connecting',
  on: 'Tunnel on',
  error: 'Tunnel off',
  blocked: 'Blocked'
};

function renderTunnel(s) {
  if (!s) return;
  els.tunnel.dataset.state = s.state;
  let label = TUNNEL_LABEL[s.state] || 'Tunnel';
  if (s.state === 'bootstrapping' && s.progress) label = s.progress + '%';
  // With the system VPN there is nothing for Veil to start; it is waiting on you.
  if (s.state === 'starting' && s.provider === 'system') label = 'Waiting';
  if (s.state === 'on' && s.provider === 'system') label = 'VPN on';
  els.tunnelLabel.textContent = label;

  const base = {
    off: 'Traffic goes out directly. Click to turn the tunnel on.',
    downloading: 'Setting up the tunnel',
    starting: 'Starting the tunnel',
    bootstrapping: 'Building a circuit',
    on: 'All browser traffic is going through the tunnel',
    error: 'The tunnel could not start',
    blocked: 'The tunnel dropped and the kill switch stopped all traffic'
  }[s.state] || '';
  els.tunnel.title = s.detail ? base + '\n' + s.detail : base;
}

/* ----------------------------------------------------------------- prompt */

function showPrompt(p) {
  if (!p) return;
  els.promptText.textContent = p.text;
  els.promptActions.replaceChildren();
  for (const c of p.choices || []) {
    const b = document.createElement('button');
    b.textContent = c.label;
    if (c.primary) b.className = 'primary';
    b.addEventListener('click', () => {
      els.prompt.hidden = true;
      veil.answerPrompt(p.id, c.id);
    });
    els.promptActions.append(b);
  }
  els.prompt.hidden = false;
}

/* ------------------------------------------------------------------ wiring */

veil.on('tabs', (s) => { state = s; render(); });
veil.on('tunnel', renderTunnel);
veil.on('toast', showToast);
veil.on('window', (w) => {
  const use = $('win-max').firstElementChild.firstElementChild;
  use.setAttribute('href', w.maximized ? '#i-win-restore' : '#i-win-max');
  $('win-max').title = w.maximized ? 'Restore' : 'Maximise';
});
veil.on('settings', (s) => { settings = s; VeilTheme.apply(s); applyLayout(s); });
veil.on('focusOmnibox', () => { els.url.focus(); els.url.select(); });
veil.on('openFind', openFind);
veil.on('findNext', (forward) => { if (findOpen) runFind(forward !== false, true); else openFind(); });
veil.on('prompt', showPrompt);
veil.on('promptClose', () => { els.prompt.hidden = true; });
veil.on('findResult', (r) => {
  els.findCount.textContent = r.total ? `${r.active} of ${r.total}` : 'No matches';
});

/* --------------------------------------------------------------- layout */

/**
 * Horizontal or vertical tabs.
 *
 * The tab list here is the horizontal strip only; vertical tabs are drawn by
 * the rail, which is a separate view so it can float over the page. All this
 * document has to say is how tall it wants to be.
 */
function applyLayout(s) {
  const a = (s && s.appearance) || {};
  const mode = a.tabLayout === 'side' ? 'side' : 'top';

  els.chrome.dataset.mode = mode;
  els.chrome.dataset.float = a.autoHideChrome ? '1' : '0';

  // The horizontal strip is the only tab host this document has now, and the
  // list must live inside it: left loose in #chrome it renders as an extra
  // row of its own, which both looks wrong and makes the chrome report a
  // height it does not need.
  if (els.tabs.parentElement !== els.topTabs) els.topTabs.append(els.tabs);

  // The window buttons ride on whichever row is the top one.
  const wcHost = mode === 'side' ? els.toolbar : els.tabstrip;
  if (els.wincontrols.parentElement !== wcHost) wcHost.append(els.wincontrols);

  reportLayout();
}

/** How tall the chrome wants to be. The main process decides where to put it. */
function reportLayout() {
  const mode = els.chrome.dataset.mode === 'side' ? 'side' : 'top';
  const top = Math.ceil(els.chrome.getBoundingClientRect().height);
  veil.reportLayout({ mode, top });
}

const layoutWatcher = new ResizeObserver(() => reportLayout());
layoutWatcher.observe(els.chrome);
layoutWatcher.observe(els.topbar);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && findOpen && document.activeElement !== els.findInput) closeFind();
});

veil.getSettings().then((s) => { settings = s; VeilTheme.apply(s); applyLayout(s); });
veil.ready();
