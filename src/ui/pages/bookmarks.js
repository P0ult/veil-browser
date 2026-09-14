'use strict';

const $ = (id) => document.getElementById(id);

let all = [];
let folders = [];

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function hue(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
  return h;
}

function matches(b, needle) {
  if (!needle) return true;
  return (b.title + ' ' + b.url + ' ' + b.folder).toLowerCase().includes(needle);
}

function render() {
  const needle = $('filter').value.trim().toLowerCase();
  const want = $('folder').value;
  const list = $('list');
  list.replaceChildren();

  const shown = all.filter(b => matches(b, needle) && (!want || b.folder === want));

  if (shown.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = all.length === 0
      ? 'Nothing here yet. Bookmark a page, or import from another browser.'
      : 'Nothing matches that.';
    list.append(p);
    return;
  }

  // Grouped by the folder they came from, so an imported collection still
  // looks like the one you had.
  const groups = new Map();
  for (const b of shown) {
    const key = b.folder || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  for (const [folder, items] of groups) {
    const group = document.createElement('div');
    group.className = 'group';

    const h = document.createElement('h3');
    h.textContent = folder || 'No folder';
    group.append(h);

    const box = document.createElement('div');
    box.className = 'mark-list';

    for (const b of items) {
      const row = document.createElement('div');
      row.className = 'bm';

      const host = hostOf(b.url);
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = (host[0] || '?').toUpperCase();
      dot.style.background = 'hsl(' + hue(host) + ' 58% 62%)';

      const text = document.createElement('div');
      text.className = 'text';
      const title = document.createElement('b');
      title.textContent = b.title || host;
      const url = document.createElement('small');
      url.textContent = b.url;
      text.append(title, url);
      text.addEventListener('click', () => veil.go(b.url));

      const kill = document.createElement('button');
      kill.className = 'kill';
      kill.textContent = 'Remove';
      kill.title = 'Remove this bookmark';
      kill.addEventListener('click', async () => {
        all = await veil.bookmarks.remove(b.id);
        render();
      });

      row.append(dot, text, kill);
      box.append(row);
    }

    group.append(box);
    list.append(group);
  }
}

function fillFolders() {
  const select = $('folder');
  const current = select.value;
  select.replaceChildren();

  const any = document.createElement('option');
  any.value = '';
  any.textContent = 'All folders';
  select.append(any);

  for (const f of folders) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f;
    select.append(o);
  }
  select.value = folders.includes(current) ? current : '';
}

async function load() {
  try {
    const r = await veil.bookmarks.list();
    all = r.items || [];
    folders = r.folders || [];
  } catch {
    all = [];
    folders = [];
  }
  fillFolders();
  render();
}

$('filter').addEventListener('input', render);
$('folder').addEventListener('change', render);
$('go-import').addEventListener('click', () => veil.go('veil://import/'));

veil.getSettings().then((s) => VeilTheme.apply(s));
veil.onSettings((s) => VeilTheme.apply(s));
load();
