'use strict';

const $ = (id) => document.getElementById(id);
let settings = null;

/* ------------------------------------------------------------ path helpers */

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function patchFor(path, value) {
  const parts = path.split('.');
  const root = {};
  let cur = root;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else cur = (cur[p] = {});
  });
  return root;
}

let saveTimer = null;
let pending = {};

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepMerge(a[k] || {}, v);
    else a[k] = v;
  }
  return a;
}

function save(path, value) {
  deepMerge(pending, patchFor(path, value));
  deepMerge(settings, patchFor(path, value));
  VeilTheme.apply(settings);
  refreshConditionals();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = pending;
    pending = {};
    settings = await veil.setSettings(patch);
    hydrate(true);
  }, 160);
}

/* -------------------------------------------------------------- binding */

function controls() { return document.querySelectorAll('[data-bind]'); }

function hydrate(skipFocused) {
  for (const el of controls()) {
    if (skipFocused && el === document.activeElement) continue;
    const path = el.dataset.bind;
    const value = getPath(settings, path);

    if (el.classList.contains('switch')) {
      el.setAttribute('aria-checked', value ? 'true' : 'false');
    } else if (el.tagName === 'SELECT') {
      el.value = String(value);
    } else if (el.type === 'range' || el.type === 'number') {
      el.value = Number(value);
      showVal(el, path, value);
    } else if (el.type === 'color') {
      // Several of these mean "follow the theme" when they are blank, and a
      // colour input cannot hold blank - it rejects the value and complains.
      // The swatch shows what the theme is currently using; the text field
      // beside it is what stays empty.
      el.value = (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
        ? value : themeColourFor(path);
    } else {
      el.value = value == null ? '' : String(value);
    }
  }
  refreshConditionals();
}

/** What a blank colour setting is actually showing right now. */
function themeColourFor(path) {
  const token = {
    'appearance.linkColor': '--link',
    'appearance.textColor': '--text',
    'appearance.railColor': '--rail-bg',
    'appearance.bgColor': '--bg',
    'appearance.bgGradientA': '--bg',
    'appearance.bgGradientB': '--bg',
    'appearance.accent': '--accent'
  }[path];
  if (!token) return '#000000';
  const live = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  // Only hex is any use to a colour input; anything else falls back to black.
  return /^#[0-9a-f]{6}$/i.test(live) ? live : '#000000';
}

/* The readout beside a slider. This has to be driven from the input event as
   well as from hydrate(): hydrate deliberately skips whichever control has
   focus so it cannot fight the user mid-drag, and the slider being dragged is
   exactly that control - so the number sat still until the tab was reloaded. */
function showVal(el, path, value) {
  const val = el.parentElement && el.parentElement.querySelector('.val');
  if (val) val.textContent = formatVal(path, value);
}

function formatVal(path, v) {
  if (path === 'appearance.bgDim') return Math.round(v * 100) + '%';
  if (path === 'browser.defaultZoom') return Math.round(v * 100) + '%';
  if (path === 'appearance.bgBlur' || path === 'appearance.radius') return v + 'px';
  if (path === 'appearance.sidebarWidth') return v + 'px';
  if (path === 'appearance.glassLevel') return v + '%';
  if (path === 'vpn.pollSeconds') return v + 's';
  return String(v);
}

function refreshConditionals() {
  for (const el of document.querySelectorAll('[data-when]')) {
    const [path, expected] = el.dataset.when.split('=');
    const wanted = expected.split(',');
    el.hidden = !wanted.includes(String(getPath(settings, path)));
  }
}

function bindAll() {
  for (const el of controls()) {
    const path = el.dataset.bind;

    if (el.classList.contains('switch')) {
      el.addEventListener('click', () => {
        const next = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', next ? 'true' : 'false');
        save(path, next);
      });
      continue;
    }

    const event = (el.type === 'range' || el.type === 'color') ? 'input' : 'change';
    el.addEventListener(event, () => {
      let value = el.value;
      if (el.type === 'range' || el.type === 'number') {
        value = Number(value);
        showVal(el, path, value);
      }
      if (el.type === 'color' || el.type === 'text') {
        // Keep the paired colour picker and hex field in step.
        for (const twin of controls()) {
          if (twin !== el && twin.dataset.bind === path) twin.value = value;
        }
      }
      save(path, value);
    });
  }
}

/* ------------------------------------------------------------ navigation */

for (const a of document.querySelectorAll('#nav a')) {
  a.addEventListener('click', () => {
    const el = $('s-' + a.dataset.go);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = e.target.id.replace(/^s-/, '');
    for (const a of document.querySelectorAll('#nav a')) {
      a.classList.toggle('on', a.dataset.go === id);
    }
  }
}, { rootMargin: '-10% 0px -75% 0px' });
for (const s of document.querySelectorAll('section.card')) spy.observe(s);

/* --------------------------------------------------------------- images */

$('pick-image').addEventListener('click', async () => {
  const p = await veil.pickImage();
  if (p) { settings = await veil.getSettings(); hydrate(false); renderBgPath(); }
});
$('clear-image').addEventListener('click', () => {
  save('appearance.bgImage', '');
  renderBgPath();
});
function renderBgPath() {
  const p = settings.appearance.bgImage;
  $('bg-path').textContent = p ? p : 'No image chosen.';
}

/* ---------------------------------------------------------------- bangs */

function renderBangs() {
  const bangs = settings.search.bangs || {};
  $('bangs').value = Object.entries(bangs).map(([k, v]) => k + ' = ' + v).join('\n');
}

$('bangs').addEventListener('change', async () => {
  const out = {};
  let bad = 0;
  for (const line of $('bangs').value.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^!?([a-z0-9_+-]{1,16})\s*=\s*(\S+)$/i.exec(t);
    if (m) out[m[1].toLowerCase()] = m[2];
    else bad++;
  }
  settings = await veil.setSettings({ search: { bangs: out } });
  $('bangs-status').textContent = bad
    ? bad + ' line(s) ignored — expected "key = https://…/%s"'
    : Object.keys(out).length + ' bangs saved.';
});

/* -------------------------------------------------------------- adblock */

async function renderAdblock() {
  const s = await veil.adblock.stats();
  const r = s.rules || {};
  const n = (v) => Number(v || 0).toLocaleString();
  $('ab-stats').textContent = [
    n(r.network) + ' rules',
    n(r.hosts) + ' hostnames',
    n(r.cosmetic) + ' hiding rules',
    n(r.scriptlet) + ' page fixes',
    n(s.blockedTotal) + ' blocked this session'
  ].join('  ·  ');

  const box = $('ab-lists');
  box.replaceChildren();
  (settings.adblock.lists || []).forEach((l, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const info = document.createElement('div');
    info.className = 'info';
    const label = document.createElement('label');
    label.textContent = l.name;
    const small = document.createElement('small');
    // A shipped list is already inside the app; the address is where a newer
    // copy comes from, not where it has to be fetched before it works.
    small.textContent = (l.file ? 'Ships with Veil · ' : '') + (l.url || '');
    info.append(label, small);

    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', l.enabled ? 'true' : 'false');
    sw.addEventListener('click', async () => {
      const lists = settings.adblock.lists.slice();
      lists[i] = { ...lists[i], enabled: !lists[i].enabled };
      settings = await veil.setSettings({ adblock: { lists } });
      renderAdblock();
    });
    ctl.append(sw);
    row.append(info, ctl);
    box.append(row);
  });

  $('ab-custom').value = (settings.adblock.customBlock || []).join('\n');
  renderAllow();
}

$('ab-update').addEventListener('click', async () => {
  $('ab-update').disabled = true;
  $('ab-stats').textContent = 'Downloading…';
  await veil.adblock.update();
  settings = await veil.getSettings();
  $('ab-update').disabled = false;
  renderAdblock();
});

$('ab-custom').addEventListener('change', async () => {
  const list = $('ab-custom').value.split('\n').map(s => s.trim()).filter(Boolean);
  settings = await veil.setSettings({ adblock: { customBlock: list } });
  renderAdblock();
});

function renderAllow() {
  const box = $('ab-allow');
  box.replaceChildren();
  const list = settings.adblock.allowlist || [];
  if (!list.length) {
    const em = document.createElement('small');
    em.style.color = 'var(--text-3)';
    em.textContent = 'None. Use the shield in the toolbar to pause blocking on a site.';
    box.append(em);
    return;
  }
  list.forEach((d, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = d;
    const x = document.createElement('button');
    x.textContent = '×';
    x.addEventListener('click', async () => {
      const next = list.slice();
      next.splice(i, 1);
      settings = await veil.setSettings({ adblock: { allowlist: next } });
      renderAllow();
    });
    chip.append(x);
    box.append(chip);
  });
}

$('ab-allow-add').addEventListener('click', async () => {
  const v = $('ab-allow-input').value.trim().toLowerCase().replace(/^www\./, '');
  if (!v) return;
  const next = (settings.adblock.allowlist || []).concat([v]);
  settings = await veil.setSettings({ adblock: { allowlist: next } });
  $('ab-allow-input').value = '';
  renderAllow();
});

/* ------------------------------------------------------------------ vpn */

const VPN_TEXT = {
  missing: 'Not found. Set its path.',
  stopped: 'Closed.',
  running: 'Open, tunnel down — press Connect in its window.',
  connecting: 'Waiting for OpenVPN.',
  connected: 'Connected.'
};

function renderVpn(s) {
  if (!s) return;
  $('vpn-detail').textContent = VPN_TEXT[s.state] || '';
}

/* --------------------------------------------------------------- tunnel */

const TUNNEL_TEXT = {
  off: 'Off — traffic goes out directly.',
  downloading: 'Setting up',
  starting: 'Starting',
  bootstrapping: 'Connecting',
  on: 'On',
  error: 'Could not start',
  blocked: 'Dropped — kill switch is blocking traffic'
};

function renderTunnel(t) {
  if (!t) return;
  let text = TUNNEL_TEXT[t.state] || t.state;
  if (t.state === 'bootstrapping' && t.progress) text += ' ' + t.progress + '%';
  if (t.detail) text += '  ·  ' + t.detail;
  $('tunnel-detail').textContent = text;
  $('tunnel-toggle').textContent = (t.state === 'on' || t.state === 'bootstrapping') ? 'Turn off' : 'Turn on';

  $('cred-state').textContent = t.hasCredentials
    ? 'Saved. Stored with your Windows account, never in the settings file.'
    : 'Stored with your Windows account, never in the settings file. Most VPNs need service credentials, not your account login.';
  if (t.exit) {
    $('exit-info').textContent = t.exit.ip + (t.exit.loc ? '  ·  ' + t.exit.loc : '');
  }
}

$('proxy-save').addEventListener('click', async () => {
  const u = $('proxy-user').value.trim();
  const p = $('proxy-pass').value;
  try {
    renderTunnel(await veil.tunnel.setCredentials(u, p));
    $('proxy-user').value = '';
    $('proxy-pass').value = '';
    $('cred-state').textContent = 'Saved. Reconnect to use them.';
  } catch (err) {
    $('cred-state').textContent = err.message.replace(/^Error: /, '');
  }
});

$('proxy-clear').addEventListener('click', async () => {
  renderTunnel(await veil.tunnel.clearCredentials());
  $('proxy-user').value = '';
  $('proxy-pass').value = '';
});

$('exit-check').addEventListener('click', async () => {
  $('exit-info').textContent = 'Checking…';
  const info = await veil.tunnel.exitInfo();
  $('exit-info').textContent = info
    ? info.ip + (info.loc ? '  ·  ' + info.loc : '')
    : 'Could not reach the check service.';
});

$('tunnel-toggle').addEventListener('click', async () => {
  $('tunnel-toggle').disabled = true;
  try { renderTunnel(await veil.tunnel.toggle()); } finally { $('tunnel-toggle').disabled = false; }
  settings = await veil.getSettings();
  hydrate(true);
});

$('tunnel-reconnect').addEventListener('click', async () => {
  $('tunnel-reconnect').disabled = true;
  try { renderTunnel(await veil.tunnel.reconnect()); } finally { $('tunnel-reconnect').disabled = false; }
});

/* ---------------------------------------------------------------- vault */

async function renderVault() {
  const v = await veil.vault.state();
  $('vault-detail').textContent = !v.exists
    ? 'Not set up yet.'
    : (v.unlocked ? v.count + ' saved · unlocked' : 'Locked');
  $('open-vault').textContent = v.exists ? 'Open' : 'Set up';
}

$('open-vault').addEventListener('click', () => veil.go('veil://passwords/'));

$('vpn-open').addEventListener('click', () => veil.vpn.launch());
$('vpn-open-2').addEventListener('click', () => veil.vpn.launch());
$('vpn-logs').addEventListener('click', () => veil.vpn.logs());
$('vpn-pick').addEventListener('click', async () => {
  const p = await veil.pickExe();
  if (p) { settings = await veil.getSettings(); renderVpn(await veil.vpn.status()); }
});

/* ------------------------------------------------------------ shortcuts */

function renderShortcuts() {
  const box = $('sc-list');
  box.replaceChildren();
  const list = settings.browser.shortcuts || [];

  list.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'row';

    const info = document.createElement('div');
    info.className = 'info';
    info.style.display = 'flex';
    info.style.gap = '8px';

    const title = document.createElement('input');
    title.type = 'text';
    title.value = s.title;
    title.style.width = '150px';

    const url = document.createElement('input');
    url.type = 'text';
    url.value = s.url;
    url.className = 'grow';
    url.spellcheck = false;

    const commit = async () => {
      const next = list.slice();
      next[i] = { title: title.value.trim(), url: url.value.trim() };
      settings = await veil.setSettings({ browser: { shortcuts: next } });
    };
    title.addEventListener('change', commit);
    url.addEventListener('change', commit);
    info.append(title, url);

    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const kill = document.createElement('button');
    kill.className = 'btn';
    kill.textContent = 'Remove';
    kill.addEventListener('click', async () => {
      const next = list.slice();
      next.splice(i, 1);
      settings = await veil.setSettings({ browser: { shortcuts: next } });
      renderShortcuts();
    });
    ctl.append(kill);

    row.append(info, ctl);
    box.append(row);
  });
}

$('sc-add').addEventListener('click', async () => {
  const title = $('sc-title').value.trim();
  const raw = $('sc-url').value.trim();
  if (!title || !raw) return;
  const url = /^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw;
  const next = (settings.browser.shortcuts || []).concat([{ title, url }]);
  settings = await veil.setSettings({ browser: { shortcuts: next } });
  $('sc-title').value = '';
  $('sc-url').value = '';
  renderShortcuts();
});

/* ----------------------------------------------------------------- data */

$('export').addEventListener('click', () => veil.exportSettings());
$('import').addEventListener('click', async () => {
  const data = await veil.importSettings();
  if (data) { settings = data; hydrate(false); renderAll(); }
});
$('clear').addEventListener('click', () => veil.action('clearData'));
$('reset').addEventListener('click', async () => {
  settings = await veil.resetSettings();
  hydrate(false);
  renderAll();
});

/* ------------------------------------------------------------- updates */

const STALE_TEXT = {
  fresh: 'Up to date with the build it shipped as.',
  stale: 'This build is getting old. Chromium ships security fixes about monthly.',
  'very-stale': 'This build is well out of date and is missing browser security fixes.',
  unknown: ''
};

function renderUpdate(u) {
  if (!u) return;

  const bits = ['Veil ' + u.current, 'Chromium ' + u.chromium];
  if (u.ageDays != null) bits.push('built ' + u.ageDays + ' day' + (u.ageDays === 1 ? '' : 's') + ' ago');
  if (u.detail) bits.push(u.detail);
  $('update-detail').textContent = bits.join('  ·  ');

  const note = $('stale-note');
  if (u.staleness === 'stale' || u.staleness === 'very-stale') {
    note.hidden = false;
    note.className = 'note warn';
    note.textContent = STALE_TEXT[u.staleness] +
      (u.canSelfUpdate ? '' : ' No release feed is set for this build, so it cannot update itself.');
  } else {
    note.hidden = true;
  }

  const act = $('update-act');
  if (u.state === 'available') {
    act.hidden = false;
    act.textContent = 'Download ' + (u.available ? u.available.version : '');
    act.dataset.mode = 'download';
  } else if (u.state === 'ready') {
    act.hidden = false;
    act.textContent = 'Restart and install';
    act.dataset.mode = 'install';
  } else {
    act.hidden = true;
  }
}

$('update-check').addEventListener('click', async () => {
  $('update-check').disabled = true;
  $('update-detail').textContent = 'Checking…';
  try { renderUpdate(await veil.update.check()); }
  finally { $('update-check').disabled = false; }
});

$('update-act').addEventListener('click', async () => {
  const mode = $('update-act').dataset.mode;
  $('update-act').disabled = true;
  try {
    if (mode === 'install') await veil.update.install();
    else renderUpdate(await veil.update.download());
  } finally { $('update-act').disabled = false; }
});

async function renderAbout() {
  const info = await veil.appInfo();
  const dl = $('about');
  dl.replaceChildren();
  const rows = [
    ['Veil', info.versions.veil],
    ['Chromium', info.versions.chromium],
    ['Electron', info.versions.electron],
    ['Node', info.versions.node],
    ['Profile', info.retention === 'none' ? 'In memory only' : 'On disk']
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $('paths').textContent = info.paths.settings;
}

/* ---------------------------------------------------------------- start */

function renderAll() {
  VeilTheme.apply(settings);
  renderBgPath();
  renderBangs();
  renderShortcuts();
  renderAdblock();
  renderVault();
}

veil.onSettings((s) => { settings = s; VeilTheme.apply(s); hydrate(true); });
veil.onVpn(renderVpn);
veil.onTunnel(renderTunnel);
veil.onUpdate(renderUpdate);

veil.getSettings().then(async (s) => {
  settings = s;
  bindAll();
  hydrate(false);
  renderAll();
  renderAbout();
  renderVpn(await veil.vpn.status());
  renderTunnel(await veil.tunnel.status());
  renderUpdate(await veil.update.status());
});
