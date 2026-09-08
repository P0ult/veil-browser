'use strict';

const $ = (id) => document.getElementById(id);
let settings = null;

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/* ------------------------------------------------------------------ clock */

function tickClock() {
  const el = $('clock');
  if (el.hidden) return;
  const d = new Date();
  el.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 10000);

/* -------------------------------------------------------------- shortcuts */

function renderShortcuts() {
  const grid = $('shortcuts');
  const list = (settings.browser.shortcuts || []);
  grid.hidden = !settings.appearance.showShortcuts;
  if (grid.hidden) return;

  grid.replaceChildren();

  list.forEach((s, i) => {
    const host = hostOf(s.url);
    const el = document.createElement('div');
    el.className = 'shortcut';
    el.title = s.url;

    const glyph = document.createElement('div');
    glyph.className = 'glyph';
    glyph.style.background = `hsl(${hue(host)} 58% 64%)`;
    glyph.textContent = (s.title || host || '?').trim()[0].toUpperCase();

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = s.title || host;

    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.textContent = '×';
    kill.title = 'Remove';
    kill.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = list.slice();
      next.splice(i, 1);
      settings = await veil.setSettings({ browser: { shortcuts: next } });
      renderShortcuts();
    });

    el.append(glyph, label, kill);
    el.addEventListener('click', () => veil.go(s.url));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) veil.openTab(s.url); });
    grid.append(el);
  });

  const add = document.createElement('div');
  add.className = 'shortcut add';
  add.innerHTML = '<div class="glyph" style="background:var(--surface-3);color:var(--text-2)">+</div><div class="label">Add</div>';
  add.addEventListener('click', openAddDialog);
  grid.append(add);
}

function openAddDialog() {
  const dlg = $('dlg');
  $('dlg-name').value = '';
  $('dlg-url').value = '';
  dlg.showModal();
  setTimeout(() => $('dlg-name').focus(), 30);
}

$('dlg-form').addEventListener('submit', async (e) => {
  const value = e.submitter && e.submitter.value;
  if (value !== 'ok') return;
  const title = $('dlg-name').value.trim();
  const raw = $('dlg-url').value.trim();
  if (!title || !raw) { e.preventDefault(); return; }
  const url = /^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw;
  const next = (settings.browser.shortcuts || []).concat([{ title, url }]);
  settings = await veil.setSettings({ browser: { shortcuts: next } });
  renderShortcuts();
});

/* ------------------------------------------------------------------ stats */

let tunnelState = null;
let adStats = null;

const TUNNEL_TEXT = {
  off: 'Direct',
  downloading: 'Setting up',
  starting: 'Starting',
  bootstrapping: 'Connecting',
  on: 'Tunnel on',
  error: 'Tunnel off',
  blocked: 'Blocked'
};

function renderStats() {
  const el = $('stats');
  if (!settings.appearance.showStats) { el.hidden = true; return; }
  el.hidden = false;
  el.replaceChildren();

  const pill = document.createElement('button');
  pill.className = 'pill';
  pill.dataset.state = tunnelState ? tunnelState.state : 'off';
  pill.innerHTML = '<span class="dot"></span>';
  pill.append(document.createTextNode(tunnelState ? (TUNNEL_TEXT[tunnelState.state] || 'Tunnel') : 'Tunnel'));
  pill.addEventListener('click', () => veil.tunnel.toggle());
  el.append(pill);

  if (adStats && adStats.blockedTotal > 0) {
    const t = document.createElement('span');
    t.innerHTML = '<b>' + adStats.blockedTotal.toLocaleString() + '</b> blocked';
    el.append(t);
  }

  const link = document.createElement('a');
  link.textContent = 'Settings';
  link.addEventListener('click', () => veil.go('veil://settings/'));
  el.append(link);
}

/* ------------------------------------------------------------------ apply */

function applySettings(s) {
  settings = s;
  VeilTheme.apply(s);

  $('clock').hidden = !s.appearance.showClock;
  tickClock();

  const g = (s.appearance.greeting || '').trim();
  $('greeting').hidden = !g;
  $('greeting').textContent = g;
  $('mark').hidden = !!(s.appearance.showClock && g);

  const engine = s.search.engine;
  $('q').placeholder = engine === 'veil'
    ? 'Search the web privately'
    : 'Search with ' + engine.charAt(0).toUpperCase() + engine.slice(1);

  renderShortcuts();
  renderStats();
}

/* ----------------------------------------------------------------- wiring */

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) veil.go(q);
});

veil.onSettings(applySettings);
veil.onTunnel((s) => { tunnelState = s; renderStats(); });

veil.getSettings().then(applySettings);
veil.adblock.stats().then((s) => { adStats = s; renderStats(); });
veil.tunnel.status().then((s) => { tunnelState = s; renderStats(); });

$('q').focus();
