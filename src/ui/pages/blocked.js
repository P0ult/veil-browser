'use strict';

const params = new URL(location.href).searchParams;
const target = params.get('url') || '';
let host = '';
try { host = new URL(target).hostname; } catch {}

document.getElementById('url').textContent = target;
document.title = host ? 'Blocked · ' + host : 'Blocked';

document.getElementById('back').addEventListener('click', () => history.back());

document.getElementById('allow').addEventListener('click', async () => {
  if (!host) return;
  const s = await veil.getSettings();
  const base = host.replace(/^www\./, '');
  const custom = (s.adblock.customBlock || []).filter(d => d !== base && d !== host);
  const allow = (s.adblock.allowlist || []).concat([base]);
  await veil.setSettings({ adblock: { customBlock: custom, allowlist: allow } });
  veil.go(target);
});

veil.onSettings((s) => VeilTheme.apply(s));
veil.getSettings().then((s) => VeilTheme.apply(s));
