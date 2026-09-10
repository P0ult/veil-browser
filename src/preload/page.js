'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const isInternal = location.protocol === 'veil:';
const isWeb = /^https?:$/.test(location.protocol);


/* ------------------------------------------------------ fingerprinting

   This lives inline rather than in its own module on purpose: tab preloads run
   sandboxed, and a sandboxed preload can only require 'electron'. A relative
   require here fails at load and takes the whole bridge down with it.

   The honest framing: this is Brave-style *randomisation*, not Tor-style
   *uniformity*. It makes the readings a site takes unstable across sites so
   they cannot be joined into one identity. It does not make you look like
   everybody else - only Tor Browser and Mullvad Browser attempt that, and it
   costs a great deal of usability to do properly.

   The noise is seeded per site and per run, so reading the same canvas twice
   on one page agrees (a script cannot average it away), the same canvas on
   another site does not, and restarting Veil changes every answer again.

   The function is stringified into the page's own JavaScript world, so it can
   only use what it is handed in `args`.                                     */

function installDefences(seed, cfg) {
  if (window.__veilFp) return;
  Object.defineProperty(window, '__veilFp', { value: true, enumerable: false });

  /**
   * Deterministic per-seed noise. This uses the murmur3 finaliser rather than a
   * plain xorshift: with xorshift the index dominated the high bits, so every
   * seed produced the same pattern of +1/-1 decisions and the "noise" was the
   * same on every site. A proper avalanche makes one changed seed bit flip
   * roughly half the output bits.
   */
  const rand = (n) => {
    let x = (seed + Math.imul(n, 0x9E3779B1)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x85EBCA6B) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35) >>> 0;
    x ^= x >>> 16;
    // ^= yields a signed int: without this the result can be negative, and
    // every comparison against 0.5 then answers the same way.
    return (x >>> 0) / 4294967296;
  };

  /* ------------------------------------------------------------- canvas */

  const CtxProto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  const CanvasProto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
  const rawGetImageData = CtxProto && CtxProto.getImageData;

  // Nudge a sparse, fixed set of colour channels by one step. Invisible to a
  // person, fatal to a hash.
  const addNoise = (data) => {
    const len = data.length;
    if (len < 8) return;

    // One channel of every eighth pixel. Dense enough that any hash over the
    // bitmap changes - sparse sampling let identical hashes slip through - and
    // still a single step of one colour channel, which no eye can see.
    let step = 32;
    const MAX_TOUCHES = 60000;                // keep very large canvases cheap
    if (len / step > MAX_TOUCHES) step = Math.ceil(len / MAX_TOUCHES / 4) * 4;

    for (let i = 0, k = 0; i + 3 < len; i += step, k++) {
      const channel = i + (k % 3);            // never the alpha channel
      const v = data[channel] + (rand(k) < 0.5 ? -1 : 1);
      if (v >= 0 && v <= 255) data[channel] = v;
    }
  };

  if (CtxProto && rawGetImageData && cfg.canvas) {
    CtxProto.getImageData = function getImageData() {
      const out = rawGetImageData.apply(this, arguments);
      try { addNoise(out.data); } catch {}
      return out;
    };

    // Serialising goes through a noised copy so the visible canvas is untouched.
    const noisedCopy = (canvas) => {
      const w = canvas.width | 0;
      const h = canvas.height | 0;
      if (!w || !h) return null;
      const copy = document.createElement('canvas');
      copy.width = w; copy.height = h;
      const c = copy.getContext('2d');
      c.drawImage(canvas, 0, 0);
      const img = rawGetImageData.call(c, 0, 0, w, h);
      addNoise(img.data);
      c.putImageData(img, 0, 0);
      return copy;
    };

    if (CanvasProto) {
      const rawToDataURL = CanvasProto.toDataURL;
      CanvasProto.toDataURL = function toDataURL() {
        try {
          const copy = noisedCopy(this);
          if (copy) return rawToDataURL.apply(copy, arguments);
        } catch {}
        return rawToDataURL.apply(this, arguments);
      };

      const rawToBlob = CanvasProto.toBlob;
      if (rawToBlob) {
        CanvasProto.toBlob = function toBlob() {
          try {
            const copy = noisedCopy(this);
            if (copy) return rawToBlob.apply(copy, arguments);
          } catch {}
          return rawToBlob.apply(this, arguments);
        };
      }
    }
  }

  /* -------------------------------------------------------------- webgl */

  if (cfg.webgl) {
    // A very ordinary integrated-graphics string: blending in beats standing out.
    const VENDOR = 'Google Inc. (Intel)';
    const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';

    for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
      const proto = window[name] && window[name].prototype;
      if (!proto || !proto.getParameter) continue;
      const raw = proto.getParameter;
      proto.getParameter = function getParameter(p) {
        if (p === 37445) return VENDOR;      // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return RENDERER;    // UNMASKED_RENDERER_WEBGL
        return raw.call(this, p);
      };
    }
  }

  /* -------------------------------------------------------------- audio */

  if (cfg.audio) {
    const AP = window.AnalyserNode && AnalyserNode.prototype;
    if (AP && AP.getFloatFrequencyData) {
      const raw = AP.getFloatFrequencyData;
      AP.getFloatFrequencyData = function getFloatFrequencyData(arr) {
        raw.call(this, arr);
        try {
          for (let i = 0; i < arr.length; i += 16) arr[i] += (rand(i) - 0.5) * 0.001;
        } catch {}
      };
    }
  }

  /* ---------------------------------------------------------- navigator */

  if (cfg.navigator) {
    const fix = (proto, prop, value) => {
      try {
        if (!proto || !(prop in proto)) return;
        Object.defineProperty(proto, prop, { get: () => value, configurable: true });
      } catch {}
    };
    const NP = window.Navigator && Navigator.prototype;
    fix(NP, 'hardwareConcurrency', 8);
    fix(NP, 'deviceMemory', 8);
    fix(NP, 'languages', Object.freeze(['en-US', 'en']));
  }
}

/* ------------------------------------------------- cosmetic ad filtering
   Network blocking removes the ad, but the empty box it leaves behind is
   still there. These rules collapse the containers. They are deliberately
   conservative: only selectors ad tech uses and ordinary pages do not.     */

const COSMETIC_RULES = [
  'ins.adsbygoogle', '.adsbygoogle',
  '[id^="google_ads_"]', '[id^="div-gpt-ad"]', '[id^="gpt-ad"]',
  '[id^="taboola-"]', '[id^="outbrain_widget"]', '.OUTBRAIN', '.trc_related_container',
  'iframe[src*="doubleclick.net"]', 'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]', 'iframe[src*="adnxs.com"]',
  'iframe[id^="google_ads_iframe"]', 'iframe[name^="google_ads_iframe"]',
  '[data-ad-slot]', '[data-ad-client]', '[data-adunit]', '[data-google-query-id]',
  '[class^="ad-slot"]', '[class*=" ad-slot"]', '[id^="ad-slot"]',
  '.ad-container', '.ad-wrapper', '.ad-banner', '.ad-placeholder',
  '.advertisement', '.advertisment', '.sponsored-content-wrapper',
  '#adsense', '#ad-container', '#banner-ad', '#sidebar-ad',
  'aside[aria-label="Advertisement" i]', 'div[aria-label="Advertisement" i]',
  'div[aria-label="Ads" i]', 'section[aria-label="Advertisement" i]'
].join(',');

function injectCosmetics() {
  try {
    const style = document.createElement('style');
    style.setAttribute('data-veil', 'cosmetic');
    style.textContent = COSMETIC_RULES + '{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  } catch {}
}

function onReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

/* Fingerprinting defences go in before any page script runs. The seed comes
   from the main process: one secret per run, mixed with this page's origin, so
   the readings a site takes are stable for it and different for everyone else. */
if (!isInternal && isWeb) {
  ipcRenderer.invoke('page:fingerprint', location.origin).then((cfg) => {
    if (!cfg || !cfg.enabled) return;
    contextBridge.executeInMainWorld({
      func: installDefences,
      args: [cfg.seed, cfg]
    });
  }).catch(() => {});
}

if (!isInternal && isWeb) {
  ipcRenderer.invoke('page:cosmetic').then((on) => {
    if (!on) return;
    if (document.documentElement) injectCosmetics();
    else onReady(injectCosmetics);
  }).catch(() => {});
}

/* ------------------------------------------------------------------ autofill
   Runs only in the top frame of an ordinary web page. Passwords arrive from the
   main process one at a time and are written straight into the field; they are
   never placed on `window`, so page scripts cannot read them from us.        */

const USERNAME_HINTS = /user|email|login|account|identifier|phone/i;

function visible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

/** Set a value the way a person would, so framework-controlled inputs notice. */
function setValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The username box that belongs to a given password box. */
function usernameFor(pw) {
  const scope = pw.form || document;
  const inputs = [...scope.querySelectorAll('input')].filter(visible);
  const idx = inputs.indexOf(pw);

  const explicit = inputs.find(i => /username|email/i.test(i.autocomplete || ''));
  if (explicit) return explicit;

  // The nearest sensible text field above the password box.
  for (let i = idx - 1; i >= 0; i--) {
    const el = inputs[i];
    const t = (el.type || 'text').toLowerCase();
    if (t === 'email') return el;
    if (t === 'text' || t === 'tel') {
      if (USERNAME_HINTS.test(el.name + ' ' + el.id + ' ' + (el.placeholder || ''))) return el;
      return el;
    }
  }
  return inputs.find(i => ['text', 'email', 'tel'].includes((i.type || 'text').toLowerCase())) || null;
}

function passwordFields() {
  return [...document.querySelectorAll('input[type="password"]')].filter(visible);
}

/* ---- the account picker, isolated from the page's own styling ---- */

let picker = null;

function closePicker() {
  if (picker) { picker.remove(); picker = null; }
}

function openPicker(anchor, items) {
  closePicker();
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  const r = anchor.getBoundingClientRect();
  host.style.left = (window.scrollX + r.left) + 'px';
  host.style.top = (window.scrollY + r.bottom + 4) + 'px';
  host.style.width = Math.max(220, r.width) + 'px';

  const style = document.createElement('style');
  style.textContent = `
    .box{font:13px system-ui,Segoe UI,sans-serif;background:#12161d;color:#e9edf3;
         border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden;
         box-shadow:0 10px 30px rgba(0,0,0,.45)}
    .hd{padding:7px 11px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
        color:#7d8a99;border-bottom:1px solid rgba(255,255,255,.08)}
    .it{padding:9px 11px;cursor:pointer;display:block;width:100%;text-align:left;
        background:none;border:0;color:inherit;font:inherit}
    .it:hover{background:rgba(255,255,255,.08)}
    .sub{color:#7d8a99;font-size:11.5px}`;
  root.append(style);

  const box = document.createElement('div');
  box.className = 'box';
  const hd = document.createElement('div');
  hd.className = 'hd';
  hd.textContent = 'Veil passwords';
  box.append(hd);

  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'it';
    b.type = 'button';
    b.textContent = it.username || '(no username)';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = it.title || it.origin;
    b.append(sub);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillWith(it.id, anchor);
      closePicker();
    });
    box.append(b);
  }

  root.append(box);
  document.body.appendChild(host);
  picker = host;
}

async function fillWith(id, nearField) {
  try {
    const cred = await ipcRenderer.invoke('autofill:fill', id);
    const pw = passwordFields()[0] ||
      (nearField && nearField.type === 'password' ? nearField : null);
    if (!pw) return;
    const user = usernameFor(pw);
    if (user && cred.username) setValue(user, cred.username);
    setValue(pw, cred.password);
    lastFilled = { username: cred.username, password: cred.password };
  } catch { /* the main process refused; nothing to show */ }
}

/* ---- wiring ---- */

let lastFilled = null;
let wired = new WeakSet();

async function offerFill() {
  const fields = passwordFields();
  if (!fields.length) return;

  let info;
  try { info = await ipcRenderer.invoke('autofill:candidates'); } catch { return; }
  if (!info || !info.items || !info.items.length) return;

  for (const pw of fields) {
    if (wired.has(pw)) continue;
    wired.add(pw);
    const user = usernameFor(pw);
    const anchor = user || pw;
    anchor.addEventListener('focus', () => openPicker(anchor, info.items));
    pw.addEventListener('focus', () => openPicker(anchor, info.items));
  }

  // One saved login for this site and nothing typed yet: just fill it.
  if (info.items.length === 1) {
    const pw = fields[0];
    const user = usernameFor(pw);
    if (!pw.value && (!user || !user.value)) await fillWith(info.items[0].id, pw);
  }
}

/**
 * Which password box actually holds the credential worth keeping. A sign-in
 * form has one; a change-password form has the old one first, and saving that
 * would overwrite a good entry with a stale value.
 */
function credentialField() {
  const filled = passwordFields().filter(p => p.value);
  if (!filled.length) return null;

  const declared = filled.find(p => /new-password/i.test(p.autocomplete || ''));
  if (declared) return declared;

  // Sign-up forms repeat the same new password in a confirm box.
  if (filled.length >= 2) {
    const last = filled[filled.length - 1];
    const prev = filled[filled.length - 2];
    if (last.value === prev.value) return last;
    return last;                       // old/new pairs: the new one is later
  }
  return filled[0];
}

let lastOffered = '';

function captureAndOffer() {
  const pw = credentialField();
  if (!pw) return;

  const user = usernameFor(pw);
  const username = user ? user.value : '';
  const password = pw.value;

  // Nothing changed since Veil filled it, so there is nothing to save.
  if (lastFilled && lastFilled.username === username && lastFilled.password === password) return;

  const key = username + '\u0000' + password;
  if (key === lastOffered) return;
  lastOffered = key;

  ipcRenderer.invoke('autofill:offer-save', { username, password }).catch(() => {});
}

if (!isInternal && isWeb) {
  onReady(() => {
    offerFill();

    // Login forms often appear after the first paint.
    const mo = new MutationObserver(() => offerFill());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 20000);

    // Capture straight away, because a submit can navigate the page out from
    // under us, and again shortly after for frameworks that update on a tick.
    const capture = () => { captureAndOffer(); setTimeout(captureAndOffer, 120); };

    document.addEventListener('submit', capture, true);
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('button,input[type="submit"],[role="button"]')) capture();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') capture();
    }, true);
    window.addEventListener('pagehide', captureAndOffer, true);
    document.addEventListener('click', (e) => {
      if (picker && !picker.contains(e.target)) closePicker();
    }, true);
    window.addEventListener('scroll', closePicker, true);
  });
}

/* ------------------------------------------------------------- internal API */

if (isInternal) {
  const listeners = { settings: new Set(), vpn: new Set(), tunnel: new Set(), update: new Set(), downloads: new Set() };
  const relay = (channel, key) =>
    ipcRenderer.on(channel, (_e, data) => listeners[key].forEach(fn => { try { fn(data); } catch {} }));
  relay('veil:settings', 'settings');
  relay('veil:vpn', 'vpn');
  relay('veil:tunnel', 'tunnel');
  relay('veil:update', 'update');
  relay('veil:downloads', 'downloads');

  contextBridge.exposeInMainWorld('veil', {
    internal: true,

    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    resetSettings: () => ipcRenderer.invoke('settings:reset'),
    pickImage: () => ipcRenderer.invoke('settings:pick-image'),
    pickExe: () => ipcRenderer.invoke('settings:pick-exe'),
    exportSettings: () => ipcRenderer.invoke('settings:export'),
    importSettings: () => ipcRenderer.invoke('settings:import'),

    search: (q, page) => ipcRenderer.invoke('search:run', q, page),
    searchImages: (q, page) => ipcRenderer.invoke('search:images', q, page),
    searchUrlFor: (q) => ipcRenderer.invoke('search:url-for', q),

    adblock: {
      stats: () => ipcRenderer.invoke('adblock:stats'),
      update: () => ipcRenderer.invoke('adblock:update')
    },

    tunnel: {
      status: () => ipcRenderer.invoke('tunnel:status'),
      toggle: () => ipcRenderer.invoke('tunnel:toggle'),
      reconnect: () => ipcRenderer.invoke('tunnel:reconnect'),
      setCredentials: (u, p) => ipcRenderer.invoke('tunnel:set-credentials', u, p),
      clearCredentials: () => ipcRenderer.invoke('tunnel:clear-credentials'),
      exitInfo: () => ipcRenderer.invoke('tunnel:exit-info')
    },

    vault: {
      state: () => ipcRenderer.invoke('vault:state'),
      create: (m) => ipcRenderer.invoke('vault:create', m),
      createAuto: () => ipcRenderer.invoke('vault:create-auto'),
      unlock: (m) => ipcRenderer.invoke('vault:unlock', m),
      quickUnlock: () => ipcRenderer.invoke('vault:quick-unlock'),
      lock: () => ipcRenderer.invoke('vault:lock'),
      enableQuick: () => ipcRenderer.invoke('vault:enable-quick'),
      disableQuick: () => ipcRenderer.invoke('vault:disable-quick'),
      changeMaster: (a, b) => ipcRenderer.invoke('vault:change-master', a, b),
      list: () => ipcRenderer.invoke('vault:list'),
      reveal: (id) => ipcRenderer.invoke('vault:reveal', id),
      save: (entry) => ipcRenderer.invoke('vault:save', entry),
      remove: (id) => ipcRenderer.invoke('vault:delete', id),
      generate: (opts) => ipcRenderer.invoke('vault:generate', opts)
    },

    vpn: {
      status: () => ipcRenderer.invoke('vpn:status'),
      launch: () => ipcRenderer.invoke('vpn:launch'),
      logs: () => ipcRenderer.send('vpn:logs')
    },

    update: {
      status: () => ipcRenderer.invoke('update:status'),
      check: () => ipcRenderer.invoke('update:check'),
      download: () => ipcRenderer.invoke('update:download'),
      install: () => ipcRenderer.invoke('update:install')
    },

    onDownloads: (fn) => { listeners.downloads.add(fn); return () => listeners.downloads.delete(fn); },

    downloads: {
      list: () => ipcRenderer.invoke('downloads:list'),
      clear: () => ipcRenderer.invoke('downloads:clear'),
      reveal: (path) => ipcRenderer.invoke('downloads:reveal', path)
    },

    appInfo: () => ipcRenderer.invoke('app:info'),

    allowInsecure: (url) => ipcRenderer.invoke('httpsonly:allow', url),

    go: (url) => ipcRenderer.send('nav:go', url),
    openTab: (url) => ipcRenderer.send('tab:new', url),
    openExternal: (url) => ipcRenderer.send('open:external', url),
    copy: (text) => ipcRenderer.send('clipboard:write', text),
    action: (name, arg) => ipcRenderer.send('action', name, arg),

    onSettings: (fn) => { listeners.settings.add(fn); return () => listeners.settings.delete(fn); },
    onVpn: (fn) => { listeners.vpn.add(fn); return () => listeners.vpn.delete(fn); },
    onTunnel: (fn) => { listeners.tunnel.add(fn); return () => listeners.tunnel.delete(fn); },
    onUpdate: (fn) => { listeners.update.add(fn); return () => listeners.update.delete(fn); }
  });
}
