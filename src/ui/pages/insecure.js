'use strict';

const params = new URL(location.href).searchParams;
const target = params.get('url') || '';

let host = '';
try { host = new URL(target).hostname; } catch {}

document.title = host ? 'Not encrypted · ' + host : 'Not encrypted';
document.getElementById('head').textContent = host
  ? host + ' will not load securely'
  : 'This site will not load securely';
document.getElementById('url').textContent = target;

document.getElementById('back').addEventListener('click', () => history.back());

document.getElementById('continue').addEventListener('click', async (e) => {
  const btn = e.currentTarget;

  // Two presses. The whole point of an interstitial is that carrying on is a
  // decision, not a reflex.
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Really continue unencrypted?';
    btn.classList.add('danger');
    setTimeout(() => {
      btn.dataset.armed = '0';
      btn.textContent = 'Continue unencrypted';
      btn.classList.remove('danger');
    }, 6000);
    return;
  }

  await veil.allowInsecure(target);
  veil.go(target);
});

veil.onSettings((s) => VeilTheme.apply(s));
veil.getSettings().then((s) => VeilTheme.apply(s));
