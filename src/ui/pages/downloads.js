'use strict';

const $ = (id) => document.getElementById(id);

function size(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
}

function when(at) {
  const d = new Date(Number(at) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function render(items) {
  const list = $('list');
  list.textContent = '';
  const any = items.length > 0;
  $('empty').hidden = any;
  $('clear-card').hidden = !any;

  for (const d of items) {
    const row = document.createElement('div');
    row.className = 'row';

    const info = document.createElement('div');
    info.className = 'info';
    const label = document.createElement('label');
    label.textContent = d.name;
    const small = document.createElement('small');
    const bits = [when(d.at), size(d.size)].filter(Boolean);
    small.textContent = d.state === 'failed'
      ? 'Failed' + (bits.length ? ' - ' + bits.join(' - ') : '')
      : bits.concat(d.path ? [d.path] : []).join(' - ');
    info.append(label, small);

    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    if (d.path) {
      const show = document.createElement('button');
      show.className = 'btn';
      show.textContent = 'Show in folder';
      show.addEventListener('click', () => veil.downloads.reveal(d.path));
      ctl.append(show);
    }

    row.append(info, ctl);
    list.append(row);
  }
}

async function load() {
  render(await veil.downloads.list());
}

$('clear').addEventListener('click', async () => { render(await veil.downloads.clear()); });

// Kept live, so a download finishing while this page is open shows up.
if (veil.onDownloads) veil.onDownloads((items) => render(Array.isArray(items) ? items : []));

load();
