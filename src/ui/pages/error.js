'use strict';

const params = new URL(location.href).searchParams;
const target = params.get('url') || '';
const code = Number(params.get('code') || 0);
const desc = params.get('desc') || '';

const REASONS = {
  '-105': ['Server not found', 'That address does not resolve. Check the spelling, or the site may no longer exist.'],
  '-106': ['No internet connection', 'Your machine is offline. If the VPN is mid-handshake, wait a moment and try again.'],
  '-109': ['Server unreachable', 'The address resolved but nothing answered.'],
  '-118': ['Timed out', 'The server took too long to respond.'],
  '-200': ['Certificate error', 'The site presented a certificate that could not be trusted. Veil will not continue past this.'],
  '-201': ['Certificate expired', 'The site’s certificate is out of date.'],
  '-202': ['Certificate not trusted', 'Nothing vouches for this certificate.'],
  '-501': ['Insecure response', 'The response failed a security check.'],
  '-7':   ['Timed out', 'The operation ran out of time.'],
  '-2':   ['Request failed', 'The network request could not be completed.']
};

const [head, why] = REASONS[String(code)] || ['This page did not load', desc || 'The request failed.'];

document.getElementById('head').textContent = head;
document.getElementById('why').textContent = why + (desc && !REASONS[String(code)] ? '' : desc ? '  (' + desc + ')' : '');
document.getElementById('url').textContent = target;
document.title = head;

document.getElementById('retry').addEventListener('click', () => { if (target) veil.go(target); });
document.getElementById('back').addEventListener('click', () => history.back());
document.getElementById('search').addEventListener('click', () => {
  let q = target;
  try { q = new URL(target).hostname; } catch {}
  veil.go(q.replace(/^www\./, ''));
});

veil.onSettings((s) => VeilTheme.apply(s));
veil.getSettings().then((s) => VeilTheme.apply(s));
