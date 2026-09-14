'use strict';

const $ = (id) => document.getElementById(id);

const n = (v) => Number(v || 0).toLocaleString();

/** Say how it went, in the plainest terms available. */
function report(where, text, kind) {
  const row = $(where + '-result-row');
  const el = $(where + '-result');
  row.hidden = false;
  el.textContent = text;
  el.dataset.kind = kind || '';
}

/** What an import actually did, as a sentence rather than four numbers. */
function summarise(r, thing) {
  const parts = [];
  if (r.added) parts.push(n(r.added) + ' ' + thing + (r.added === 1 ? '' : 's') + ' added');
  if (r.already) parts.push(n(r.already) + ' already here');
  if (r.skipped) parts.push(n(r.skipped) + ' already here');
  if (r.rejected) parts.push(n(r.rejected) + ' skipped');
  if (r.unreadable) parts.push(n(r.unreadable) + ' rows Veil could not read');
  if (parts.length === 0) return 'Nothing to bring over — ' + (r.format || 'the file held none');
  return parts.join(', ') + '.';
}

/* ------------------------------------------------------------- bookmarks */

async function loadSources() {
  let found = [];
  try { found = await veil.importer.sources(); } catch {}

  const box = $('sources');
  box.replaceChildren();

  if (!found.length) {
    $('sources-note').textContent =
      'No other browser found on this machine. Use the file below instead.';
    return;
  }

  $('sources-note').textContent =
    'Veil can read these without anything being exported first.';

  for (const src of found) {
    const one = document.createElement('div');
    one.className = 'one';

    const what = document.createElement('div');
    what.className = 'what';
    const b = document.createElement('b');
    b.textContent = src.browser + (src.profile && src.profile !== 'Default' ? ' — ' + src.profile : '');
    const small = document.createElement('small');
    small.textContent = n(src.count) + ' bookmark' + (src.count === 1 ? '' : 's');
    what.append(b, small);

    const go = document.createElement('button');
    go.className = 'btn';
    go.textContent = 'Import';
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Importing…';
      try {
        const r = await veil.importer.bookmarksFrom(src.file);
        report('bookmarks', summarise(r, 'bookmark'), r.added ? 'good' : '');
      } catch (e) {
        report('bookmarks', String(e.message || e).replace(/^Error: /, ''), 'bad');
      } finally {
        go.disabled = false;
        go.textContent = 'Import';
      }
    });

    one.append(what, go);
    box.append(one);
  }
}

$('pick-bookmarks').addEventListener('click', async () => {
  try {
    const r = await veil.importer.bookmarksFile();
    if (r.cancelled) return;
    report('bookmarks', summarise(r, 'bookmark'), r.added ? 'good' : '');
  } catch (e) {
    report('bookmarks', String(e.message || e).replace(/^Error: /, ''), 'bad');
  }
});

/* ------------------------------------------------------------- passwords */

$('pick-passwords').addEventListener('click', async () => {
  try {
    const r = await veil.importer.passwordsFile();
    if (r.cancelled) return;

    if (r.locked) {
      report('passwords',
        'The vault is locked. Open Passwords and unlock it, then come back.', 'bad');
      return;
    }

    let text = summarise(r, 'login');
    if (r.added) {
      text += ' Now delete the CSV — it is every password you have, in plain text.';
    }
    report('passwords', text, r.added ? 'good' : '');
  } catch (e) {
    report('passwords', String(e.message || e).replace(/^Error: /, ''), 'bad');
  }
});

/* ---------------------------------------------------------------- start */

veil.getSettings().then((s) => VeilTheme.apply(s));
veil.onSettings((s) => VeilTheme.apply(s));
loadSources();
