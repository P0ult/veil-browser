'use strict';

veil.appInfo().then((info) => {
  const rows = [
    ['Version', info.versions.veil],
    ['Chromium', info.versions.chromium],
    ['Electron', info.versions.electron],
    ['Node', info.versions.node],
    ['Profile', info.retention === 'none' ? 'In memory only' : 'On disk'],
    ['Settings', info.paths.settings]
  ];
  const dl = document.getElementById('about');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
});

veil.onSettings((s) => VeilTheme.apply(s));
veil.getSettings().then((s) => VeilTheme.apply(s));
