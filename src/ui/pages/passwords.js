'use strict';

const $ = (id) => document.getElementById(id);
let settings = null;
let entries = [];
let editingId = null;

function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function show(which) {
  for (const id of ['setup', 'locked', 'open']) $(id).hidden = id !== which;
}

/* ------------------------------------------------------------------ state */

async function refresh() {
  const st = await veil.vault.state();
  document.title = st.unlocked ? 'Passwords' : 'Passwords — locked';

  if (!st.exists) { show('setup'); setTimeout(() => $('new-master').focus(), 40); return; }

  if (!st.unlocked) {
    // A vault with no master password opens with the Windows account, so open
    // it rather than presenting a box for a password that does not exist.
    if (!st.hasMaster && st.quickUnlock) {
      try { await veil.vault.quickUnlock(); return refresh(); } catch {}
    }
    show('locked');
    $('master-row').hidden = !st.hasMaster;
    $('do-quick').hidden = !st.quickUnlock;
    if (st.hasMaster) setTimeout(() => $('master').focus(), 40);
    return;
  }

  show('open');
  $('quick-switch').setAttribute('aria-checked', st.quickUnlock ? 'true' : 'false');
  $('autolock').value = settings ? settings.passwords.autoLockMinutes : 15;

  // Without a master password the OS keystore is the only key, so it cannot be
  // turned off, and the "change" form becomes an "add" form.
  $('quick-note').textContent = st.hasMaster
    ? 'Opens without the master password. Anyone who can sign in as you can then read it.'
    : 'This vault has no master password, so the Windows account is the only key.';
  $('change-label').textContent = st.hasMaster ? 'Change master password' : 'Add a master password';
  $('cur-master').hidden = !st.hasMaster;
  $('do-change').textContent = st.hasMaster ? 'Change' : 'Add';

  entries = await veil.vault.list();
  renderList();
}

/* ------------------------------------------------------------------- list */

function renderList() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = entries.filter(e =>
    !q || (e.title + ' ' + e.origin + ' ' + e.username).toLowerCase().includes(q));

  $('count').textContent = entries.length
    ? `${entries.length} saved${q ? ` · ${shown.length} shown` : ''}`
    : 'Nothing saved yet.';

  const box = $('list');
  box.replaceChildren();

  for (const e of shown) {
    const row = document.createElement('div');
    row.className = 'row';

    const glyph = document.createElement('div');
    glyph.className = 'glyph';
    const host = hostOf(e.origin);
    glyph.style.cssText = `width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
      font-size:13px;font-weight:650;color:#0b0e13;flex:none;background:hsl(${hue(host)} 58% 64%)`;
    glyph.textContent = (e.title || host || '?')[0].toUpperCase();

    const info = document.createElement('div');
    info.className = 'info';
    const label = document.createElement('label');
    label.textContent = e.title || host;
    const small = document.createElement('small');
    small.textContent = (e.username || 'no username') + ' · ' + host;
    info.append(label, small);

    const ctl = document.createElement('div');
    ctl.className = 'ctl';

    const copyUser = document.createElement('button');
    copyUser.className = 'btn';
    copyUser.textContent = 'User';
    copyUser.title = 'Copy username';
    copyUser.addEventListener('click', () => { veil.copy(e.username || ''); flash(copyUser, 'Copied'); });

    const copyPass = document.createElement('button');
    copyPass.className = 'btn';
    copyPass.textContent = 'Password';
    copyPass.title = 'Copy password';
    copyPass.addEventListener('click', async () => {
      veil.copy(await veil.vault.reveal(e.id));
      flash(copyPass, 'Copied');
    });

    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openDialog(e));

    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = 'Sure?';
        setTimeout(() => { del.dataset.armed = '0'; del.textContent = 'Delete'; }, 3000);
        return;
      }
      entries = await veil.vault.remove(e.id);
      renderList();
    });

    ctl.append(copyUser, copyPass, edit, del);
    row.append(glyph, info, ctl);
    box.append(row);
  }
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

/* ----------------------------------------------------------------- dialog */

async function openDialog(entry) {
  editingId = entry ? entry.id : null;
  $('dlg-title').textContent = entry ? 'Edit login' : 'Add login';
  $('f-origin').value = entry ? entry.origin : '';
  $('f-user').value = entry ? entry.username : '';
  $('f-pass').value = entry ? await veil.vault.reveal(entry.id) : '';
  $('dlg').showModal();
  setTimeout(() => $(entry ? 'f-pass' : 'f-origin').focus(), 40);
}

$('do-add').addEventListener('click', () => openDialog(null));
$('f-gen').addEventListener('click', async () => {
  $('f-pass').value = await veil.vault.generate({ length: 20, symbols: true });
});

$('dlg-form').addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'ok') return;
  let origin = $('f-origin').value.trim();
  if (!origin) { e.preventDefault(); return; }
  if (!/^[a-z]+:\/\//i.test(origin)) origin = 'https://' + origin;
  entries = await veil.vault.save({
    id: editingId || undefined,
    origin,
    username: $('f-user').value.trim(),
    password: $('f-pass').value
  });
  renderList();
});

/* ------------------------------------------------------------- lock/unlock */

$('do-create-auto').addEventListener('click', async () => {
  try { await veil.vault.createAuto(); refresh(); }
  catch (err) { $('setup-error').textContent = err.message.replace(/^Error: /, ''); }
});

$('do-create').addEventListener('click', async () => {
  const a = $('new-master').value;
  const b = $('new-master2').value;
  if (a !== b) { $('setup-error').textContent = 'Those do not match.'; return; }
  try {
    await veil.vault.create(a);
    $('new-master').value = $('new-master2').value = '';
    refresh();
  } catch (err) { $('setup-error').textContent = err.message.replace(/^Error: /, ''); }
});

async function tryUnlock() {
  try {
    await veil.vault.unlock($('master').value);
    $('master').value = '';
    $('unlock-error').textContent = '';
    refresh();
  } catch (err) { $('unlock-error').textContent = err.message.replace(/^Error: /, ''); }
}

$('do-unlock').addEventListener('click', tryUnlock);
$('master').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
$('do-quick').addEventListener('click', async () => {
  try { await veil.vault.quickUnlock(); refresh(); }
  catch (err) { $('unlock-error').textContent = err.message.replace(/^Error: /, ''); }
});
$('do-lock').addEventListener('click', async () => { await veil.vault.lock(); refresh(); });

$('quick-switch').addEventListener('click', async () => {
  const on = $('quick-switch').getAttribute('aria-checked') === 'true';
  try {
    if (on) await veil.vault.disableQuick();
    else await veil.vault.enableQuick();
    $('quick-note').textContent = '';
  } catch (err) {
    $('quick-note').textContent = err.message.replace(/^Error: /, '');
  }
  refresh();
});

$('autolock').addEventListener('change', async () => {
  settings = await veil.setSettings({ passwords: { autoLockMinutes: Number($('autolock').value) || 0 } });
});

$('do-change').addEventListener('click', async () => {
  try {
    await veil.vault.changeMaster($('cur-master').value, $('next-master').value);
    $('cur-master').value = $('next-master').value = '';
    $('change-error').textContent = 'Saved.';
    refresh();
  } catch (err) { $('change-error').textContent = err.message.replace(/^Error: /, ''); }
});

$('filter').addEventListener('input', renderList);

/* ------------------------------------------------------------------ start */

veil.onSettings((s) => { settings = s; VeilTheme.apply(s); });
veil.getSettings().then((s) => { settings = s; VeilTheme.apply(s); refresh(); });
