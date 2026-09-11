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


/* -------------------------------------------------------- scriptlets

   Some adverts cannot be blocked by refusing a request or hiding an element.
   YouTube's are the standard case: the advert is described inside the same
   JSON the player needs to play the video, fetched from the same address as
   the video itself. There is no request to cancel that does not also cancel
   the video, and by the time there is an element to hide the advert is
   already playing.

   So the filter lists carry small functions - uBlock Origin calls them
   scriptlets - that run before the page's own scripts and change what the
   page's code sees. `+js(set, ytInitialPlayerResponse.adPlacements, undefined)`
   means: when YouTube's own code reads the list of adverts to play, it finds
   nothing there.

   These run in the page's own world, so like the fingerprinting defences they
   can only use what `args` hands them.                                      */

function runScriptlets(list) {
  if (window.__veilScriptlets) return;
  try { Object.defineProperty(window, '__veilScriptlets', { value: true, enumerable: false }); } catch {}

  /* ------------------------------------------------------------- helpers */

  const asRegex = (text, forceGlobal) => {
    const m = /^\/(.+)\/([a-z]*)$/s.exec(text || '');
    if (m) {
      let flags = m[2] || '';
      if (forceGlobal && !flags.includes('g')) flags += 'g';
      try { return new RegExp(m[1], flags); } catch { return null; }
    }
    const escaped = String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return new RegExp(escaped, forceGlobal ? 'g' : ''); } catch { return null; }
  };

  /** Does this request address match what the rule was written for? */
  const urlMatches = (url, pattern) => {
    if (!pattern || pattern === '*') return true;
    const re = /^\/.+\/[a-z]*$/s.test(pattern) ? asRegex(pattern, false) : null;
    if (re) return re.test(url);
    if (pattern.includes('*')) {
      const parts = pattern.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      try { return new RegExp(parts.join('.*')).test(url); } catch { return false; }
    }
    return String(url).includes(pattern);
  };

  /** The address a fetch() call is asking for, whatever shape it was given. */
  const urlOf = (input) => {
    try {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch {}
    return '';
  };

  /** A rule's url: argument, wherever it appears among the arguments. */
  const urlArg = (args, fallbackIndex) => {
    for (const a of args) {
      if (typeof a === 'string' && a.startsWith('url:')) return a.slice(4);
    }
    const f = args[fallbackIndex];
    return f && f !== 'propsToMatch' ? f : '';
  };

  const VALUES = {
    'undefined': undefined, 'false': false, 'true': true, 'null': null,
    'emptyStr': '', 'emptyObj': {}, 'emptyArr': [],
    'noopFunc': function () {}, 'trueFunc': function () { return true; },
    'falseFunc': function () { return false; }
  };

  const literal = (raw) => {
    if (raw in VALUES) return VALUES[raw];
    if (raw === '') return '';
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    return raw;
  };

  /* ------------------------------------------------------- set-constant

     Define a property that always reads as the given value. The hard part is
     that the property usually does not exist yet - YouTube assigns
     `ytInitialPlayerResponse` from an inline script further down the page - so
     where the chain is not there, the *assignment* is intercepted and the
     final property is pinned on whatever object the page puts there. */

  const pending = new WeakMap();      // owner -> Map(head -> { held, waiting })

  const pin = (owner, chain, value) => {
    const dot = chain.indexOf('.');

    if (dot === -1) {
      try {
        Object.defineProperty(owner, chain, {
          configurable: true,
          get: () => value,
          set: () => {}          // the page may try to put the adverts back
        });
      } catch {}
      return;
    }

    const head = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    const current = owner[head];

    if (current && (typeof current === 'object' || typeof current === 'function')) {
      pin(current, rest, value);
      return;
    }

    /* Three rules pin three different properties of the same object, and the
       object does not exist yet - so all three have to share one interceptor.
       Installing a fresh one per rule silently replaced the one before it, and
       only the last rule of the three survived: adSlots went and adPlacements
       stayed, which is most of an advert. */
    let table = pending.get(owner);
    if (!table) { table = new Map(); pending.set(owner, table); }

    const entry = table.get(head);
    if (entry) {
      entry.waiting.push({ rest, value });
      if (entry.held && (typeof entry.held === 'object' || typeof entry.held === 'function')) {
        try { pin(entry.held, rest, value); } catch {}
      }
      return;
    }

    const fresh = { held: current, waiting: [{ rest, value }] };
    table.set(head, fresh);
    try {
      Object.defineProperty(owner, head, {
        configurable: true,
        get: () => fresh.held,
        set: (v) => {
          fresh.held = v;
          if (v && (typeof v === 'object' || typeof v === 'function')) {
            for (const w of fresh.waiting) {
              try { pin(v, w.rest, w.value); } catch {}
            }
          }
        }
      });
    } catch {}
  };

  /* ----------------------------------------------------------- json-prune */

  const prunePath = (obj, path) => {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (cur == null) return;
      if (part === '[-]') {
        if (!Array.isArray(cur)) return;
        const rest = parts.slice(i + 1).join('.');
        for (const item of cur) prunePath(item, rest);
        return;
      }
      cur = cur[part];
    }
    const last = parts[parts.length - 1];
    if (cur && typeof cur === 'object') {
      if (last === '[-]' && Array.isArray(cur)) cur.length = 0;
      else delete cur[last];
    }
  };

  const pruneAll = (obj, paths) => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const p of paths) {
      try { prunePath(obj, p); } catch {}
    }
    return obj;
  };

  const pathList = (text) => String(text || '')
    .split(/\s+/)
    .map(p => p.trim())
    .filter(p => p && p !== 'important' && p !== 'legacyImportant');

  /* -------------------------------------------------------------- the set */

  const jsonPrunePaths = [];       // applied to every JSON.parse on the page
  const fetchRules = [];           // { kind, ... } applied to fetch responses
  const xhrRules = [];

  for (const sc of list) {
    const name = sc.name;
    const args = sc.args || [];
    try {
      if (name === 'set' || name === 'set-constant') {
        if (args[0]) pin(window, args[0], literal(args.length > 1 ? args[1] : 'undefined'));

      } else if (name === 'json-prune') {
        for (const p of pathList(args[0])) jsonPrunePaths.push(p);

      } else if (name === 'json-prune-fetch-response') {
        fetchRules.push({ kind: 'prune', paths: pathList(args[0]), url: urlArg(args, 2) });

      } else if (name === 'trusted-replace-fetch-response') {
        fetchRules.push({
          kind: 'replace',
          search: asRegex(args[0], true),
          replace: args.length > 1 ? args[1] : '',
          url: urlArg(args, 2)
        });

      } else if (name === 'trusted-replace-xhr-response') {
        xhrRules.push({
          search: asRegex(args[0], true),
          replace: args.length > 1 ? args[1] : '',
          url: urlArg(args, 2)
        });
      }
    } catch {}
  }

  /* ------------------------------------------------------------ JSON.parse */

  if (jsonPrunePaths.length) {
    const rawParse = JSON.parse;
    JSON.parse = function parse(text, reviver) {
      const out = rawParse.call(this, text, reviver);
      try { pruneAll(out, jsonPrunePaths); } catch {}
      return out;
    };

    const rawJson = Response.prototype.json;
    Response.prototype.json = function json() {
      return rawJson.call(this).then((out) => {
        try { pruneAll(out, jsonPrunePaths); } catch {}
        return out;
      });
    };
  }

  /* ----------------------------------------------------------------- fetch */

  if (fetchRules.length && typeof window.fetch === 'function') {
    const rawFetch = window.fetch;

    window.fetch = function fetch(input, init) {
      const url = urlOf(input);
      const rules = fetchRules.filter(r => urlMatches(url, r.url));
      const answer = rawFetch.call(this, input, init);
      if (!rules.length) return answer;

      return answer.then((res) => {
        // Only a readable body can be rewritten, and only once.
        if (!res || !res.body || res.bodyUsed) return res;

        return res.clone().text().then((text) => {
          let out = text;
          for (const r of rules) {
            try {
              if (r.kind === 'replace' && r.search) {
                out = out.replace(r.search, r.replace);
              } else if (r.kind === 'prune') {
                const data = JSON.parse(out);
                pruneAll(data, r.paths);
                out = JSON.stringify(data);
              }
            } catch {}
          }
          if (out === text) return res;

          const replaced = new Response(out, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers
          });
          // A constructed Response has no url of its own, and code that reads
          // it back would see an empty string where it expects an address.
          try { Object.defineProperty(replaced, 'url', { value: res.url }); } catch {}
          return replaced;
        }).catch(() => res);
      });
    };
  }

  /* ------------------------------------------------------------------- xhr */

  if (xhrRules.length && window.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const rawOpen = proto.open;

    proto.open = function open(method, url) {
      const rules = xhrRules.filter(r => urlMatches(String(url), r.url));
      if (rules.length) {
        // The listener goes on here rather than in send(), so that it runs
        // before the handlers the page attaches between open() and send().
        this.addEventListener('readystatechange', function () {
          if (this.readyState !== 4) return;
          let text;
          try { text = this.responseText; } catch { return; }
          if (typeof text !== 'string') return;

          let out = text;
          for (const r of rules) {
            try { if (r.search) out = out.replace(r.search, r.replace); } catch {}
          }
          if (out === text) return;
          try {
            Object.defineProperty(this, 'responseText', { value: out, configurable: true });
            Object.defineProperty(this, 'response', { value: out, configurable: true });
          } catch {}
        });
      }
      return rawOpen.apply(this, arguments);
    };
  }
}

/* ------------------------------------------------------- being a browser

   Veil is Chromium, but Electron leaves three tells that sites use to pick an
   embedded browser out of a line-up, and Google's sign-in page refuses all
   three: `navigator.userAgentData` lists Chromium without Google Chrome, the
   `window.chrome` object is empty where Chrome's carries app, csi, loadTimes
   and runtime, and the two together disagree with the user agent string.

   This is not a disguise. It is the same answer the main process already
   gives in the request headers, repeated where a page looks for it, so that
   every surface says the one true thing: recent Chromium, on this platform.

   Stringified into the page's own world, so it can only use what `args` hands
   it - the same constraint the fingerprinting defences run under.           */

function installIdentity(info) {
  if (window.__veilId) return;
  try {
    Object.defineProperty(window, '__veilId', { value: true, enumerable: false });
  } catch { return; }

  const define = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); }
    catch {}
  };

  /* ------------------------------------------------- navigator.userAgentData */

  const NP = window.Navigator && Navigator.prototype;
  const real = navigator.userAgentData || null;

  if (NP && 'userAgentData' in NP) {
    const brands = Object.freeze(info.brands.map(b => Object.freeze({ ...b })));
    const full = Object.freeze(info.brands.map(
      b => Object.freeze({ brand: b.brand, version: b.brand === 'Not?A_Brand' ? '24.0.0.0' : info.fullVersion })));

    const data = {
      get brands() { return brands; },
      get mobile() { return false; },
      get platform() { return info.platform; },
      toJSON() { return { brands, mobile: false, platform: info.platform }; },
      getHighEntropyValues(hints) {
        // Answer from the real object where it can, so anything not listed
        // here - architecture, bitness, model - stays truthful.
        const base = real && real.getHighEntropyValues
          ? real.getHighEntropyValues(hints)
          : Promise.resolve({});
        return base.then((v) => {
          const out = Object.assign({}, v, { brands, mobile: false, platform: info.platform });
          if (!hints || hints.includes('fullVersionList')) out.fullVersionList = full;
          if ((!hints || hints.includes('uaFullVersion')) && info.fullVersion) out.uaFullVersion = info.fullVersion;
          return out;
        });
      }
    };
    define(NP, 'userAgentData', data);
  }

  /* ------------------------------------------------------------ window.chrome

     Chrome's page-side object. An empty one is the single most quoted
     giveaway for an embedded or headless browser, so the members Chrome
     actually exposes are given plausible shapes rather than left missing. */

  const started = Date.now();
  const chrome = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};

  if (!chrome.app) {
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
      runningState: () => 'cannot_run'
    };
  }
  if (!chrome.csi) {
    chrome.csi = () => ({
      startE: started,
      onloadT: started + 300,
      pageT: Date.now() - started,
      tran: 15
    });
  }
  if (!chrome.loadTimes) {
    chrome.loadTimes = () => ({
      requestTime: started / 1000,
      startLoadTime: started / 1000,
      commitLoadTime: started / 1000,
      finishDocumentLoadTime: (started + 200) / 1000,
      finishLoadTime: (started + 300) / 1000,
      firstPaintTime: (started + 250) / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2'
    });
  }
  if (!chrome.runtime) {
    // What a page sees with no extension talking to it: the namespace exists,
    // the id does not.
    chrome.runtime = {
      id: undefined,
      connect: () => { throw new TypeError('Error in invocation of runtime.connect'); },
      sendMessage: () => { throw new TypeError('Error in invocation of runtime.sendMessage'); },
      OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', UPDATE: 'update' },
      PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', WIN: 'win' }
    };
  }
  try { window.chrome = chrome; } catch {}
}

/* ------------------------------------------------- cosmetic ad filtering

   Network blocking removes the advert; the empty box it was sitting in stays
   behind unless something hides it. The rules for that come from the filter
   lists in the main process, in two parts:

     - the ones written for this site by name, which arrive immediately and
       go in before the page has painted
     - the generic ones, which number in the tens of thousands. Sending them
       all to every page would cost more than the adverts do, so this tells
       the main process which class and id names the page actually contains
       and gets back only the rules that could match one. The page is surveyed
       again as it changes, because most of it arrives after the first paint.

   The short hand-written list below stays as the floor: it applies before the
   first answer comes back, and it covers the case where the lists are off. */

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
];

let cosmeticSheet = null;
const cosmeticSeen = new Set();     // selectors already in the sheet
let cosmeticExcepted = [];          // rules this site is exempt from

function cosmeticStyle() {
  if (cosmeticSheet && cosmeticSheet.isConnected) return cosmeticSheet;
  cosmeticSheet = document.createElement('style');
  cosmeticSheet.setAttribute('data-veil', 'cosmetic');
  (document.head || document.documentElement).appendChild(cosmeticSheet);
  return cosmeticSheet;
}

/** Add selectors to the page's hiding sheet, skipping ones already there. */
function hide(selectors) {
  const fresh = [];
  for (const s of selectors || []) {
    if (!s || cosmeticSeen.has(s)) continue;
    cosmeticSeen.add(s);
    fresh.push(s);
  }
  if (!fresh.length) return;
  try {
    // One rule per selector rather than one long comma-separated rule: a
    // single selector the browser cannot parse would throw the whole rule
    // away, and these lists are written for several browsers.
    const style = cosmeticStyle();
    for (const s of fresh) {
      try { style.sheet.insertRule(s + '{display:none !important;}', style.sheet.cssRules.length); }
      catch {}
    }
  } catch {}
}

function injectCosmetics() {
  hide(COSMETIC_RULES);
}

/* The survey: every class and id the page contains, as the filter lists spell
   them. Only names not asked about before are sent. */
const askedTokens = new Set();

function newTokens(root) {
  const out = [];
  const add = (prefix, name) => {
    const token = prefix + String(name).toLowerCase();
    if (token.length < 2 || askedTokens.has(token)) return;
    askedTokens.add(token);
    out.push(token);
  };

  let nodes;
  try { nodes = (root || document).querySelectorAll('[class],[id]'); } catch { return out; }
  for (const el of nodes) {
    const cls = el.getAttribute && el.getAttribute('class');
    if (cls && typeof cls === 'string') {
      for (const c of cls.split(/\s+/)) if (c) add('.', c);
    }
    if (el.id) add('#', el.id);
    if (out.length > 3000) break;        // a pathological page; the rest waits
  }
  return out;
}

async function survey() {
  const tokens = newTokens(document);
  if (!tokens.length) return;
  try {
    const selectors = await ipcRenderer.invoke('page:cosmetic-generic', tokens, cosmeticExcepted);
    hide(selectors);
  } catch {}
}

/** Survey again as the page fills in, but never more than twice a second. */
function watchForMore() {
  let timer = null;
  const later = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; survey(); }, 500);
  };
  try {
    new MutationObserver(later).observe(document.documentElement, {
      childList: true, subtree: true, attributeFilter: ['class', 'id']
    });
  } catch {}
}

async function startCosmetics() {
  let rules = null;
  try { rules = await ipcRenderer.invoke('page:cosmetic'); } catch {}
  if (!rules) return;                   // blocking off, or paused on this site

  injectCosmetics();
  cosmeticExcepted = rules.excepted || [];
  hide(rules.specific);
  hide(rules.complex);

  onReady(() => { survey(); watchForMore(); });
}

function onReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
  else fn();
}

/* Fingerprinting defences go in before any page script runs. The seed comes
   from the main process: one secret per run, mixed with this page's origin, so
   the readings a site takes are stable for it and different for everyone else. */
if (!isInternal && isWeb) {
  try {
    const scriptlets = ipcRenderer.sendSync('page:scriptlets', location.hostname);
    if (Array.isArray(scriptlets) && scriptlets.length) {
      contextBridge.executeInMainWorld({ func: runScriptlets, args: [scriptlets] });
    }
  } catch {}
}

if (!isInternal && isWeb) {
  ipcRenderer.invoke('page:identity').then((info) => {
    if (!info || !Array.isArray(info.brands)) return;
    contextBridge.executeInMainWorld({ func: installIdentity, args: [info] });
  }).catch(() => {});
}

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
  if (document.documentElement) startCosmetics();
  else onReady(startCosmetics);
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
    searchVideos: (q, page) => ipcRenderer.invoke('search:videos', q, page),
    searchNews: (q, page) => ipcRenderer.invoke('search:news', q, page),
    searchShopping: (q, page) => ipcRenderer.invoke('search:shopping', q, page),
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
