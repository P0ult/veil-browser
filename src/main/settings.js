'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');
const { firstExisting, vpnCandidates } = require('./platform');

// Tunnel VPN ships for both Windows and macOS and lands in different places on
// each. Nothing is hardcoded to one machine: the browser takes the first of
// the usual locations that exists, and the settings page has a picker for
// everything else. The lists live in ./platform.
function findVpn() {
  return firstExisting(vpnCandidates());
}

const DEFAULTS = {
  version: 4,
  appearance: {
    accent: '#7dd3a0',
    bgType: 'gradient',            // solid | gradient | image
    // Blank means "whatever the theme says". Storing the dark hexes here was
    // what broke light mode: the theme switched but the background did not,
    // because a value was always set and it was always the dark one.
    bgColor: '',
    bgGradientA: '',
    bgGradientB: '',
    bgGradientAngle: 160,
    bgImage: '',                   // absolute file path or https URL
    bgFit: 'cover',                // cover | contain | tile | center
    bgDim: 0.45,                   // 0..1 overlay darkness
    bgBlur: 0,                     // px
    font: 'system',                // system | serif | mono | rounded
    radius: 12,
    density: 'comfortable',        // compact | comfortable
    tabLayout: 'top',              // top | side (a vertical rail of tabs)
    sidebarWidth: 220,
    sidebarCollapsed: false,
    autoHideChrome: false,         // the whole chrome slides away until hovered
    minimalNewTab: false,          // a new tab is a search box over the page you were on
    chromeOpacity: 0.72,
    greeting: '',
    showClock: true,
    showStats: true,
    showShortcuts: false,          // they live in the tab rail now; this is the start page's copy
    linkColor: '',                 // blank = the theme's blue
    railColor: '',                 // blank = the same surface as the rest of the chrome
    outline: true,                 // a hard edge on controls, so any background stays usable
    glass: false                   // frosted, translucent surfaces
  },
  search: {
    engine: 'veil',                // veil | duckduckgo | mojeek | startpage | brave | wikipedia | custom
    customUrl: 'https://searxng.site/search?q=%s',
    backends: { duckduckgo: true, marginalia: true, wikipedia: true, mojeek: false },
    resultCount: 20,
    hideAiImages: true,            // drop image results that look model-generated
    stripTrackingParams: true,
    openResultsInNewTab: false,
    bangs: {
      w: 'https://en.wikipedia.org/wiki/Special:Search?search=%s',
      yt: 'https://www.youtube.com/results?search_query=%s',
      gh: 'https://github.com/search?q=%s',
      ddg: 'https://duckduckgo.com/?q=%s',
      so: 'https://stackoverflow.com/search?q=%s',
      npm: 'https://www.npmjs.com/search?q=%s',
      mdn: 'https://developer.mozilla.org/en-US/search?q=%s',
      r: 'https://www.reddit.com/search/?q=%s',
      map: 'https://www.openstreetmap.org/search?query=%s',
      a: 'https://archive.org/search?query=%s'
    }
  },
  privacy: {
    // 'keep' stores cookies and cache on disk, so accounts survive a restart
    // and pages load from cache. 'none' is a RAM-only profile that forgets
    // everything, including every login, the moment Veil closes.
    retention: 'keep',
    blockAds: true,
    cosmeticFiltering: true,
    blockThirdPartyCookies: true,
    trimReferrer: true,
    httpsOnly: true,
    sendDnt: true,
    blockWebRTCLeak: true,
    antiFingerprint: true,         // per-site noise on canvas, WebGL and audio
    normaliseNavigator: true,      // report common CPU/memory/language values
    denyPermissions: true,
    spoofUserAgent: false,
    userAgent: ''
  },
  adblock: {
    customBlock: [],
    allowlist: [],
    lists: [
      { name: 'StevenBlack unified hosts', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts', enabled: false },
      { name: 'AdGuard DNS filter', url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt', enabled: false },
      { name: 'Peter Lowe ad servers', url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext', enabled: false }
    ],
    lastUpdated: 0
  },
  // The in-browser tunnel. Everything the browsing session sends goes through
  // it, which needs no driver and no elevation - unlike a system-wide VPN.
  tunnel: {
    enabled: true,
    // tor      - Veil fetches and runs Tor itself
    // wstunnel - browser-only tunnel through your own wstunnel server
    // system   - the Tunnel VPN app carries the whole machine
    // socks/http - any other proxy endpoint
    provider: 'tor',               // tor | wstunnel | system | socks | http | off
    host: '',
    port: 0,
    tls: false,                    // for the http provider: speak https to it
    torPath: '',                   // point at an existing tor.exe instead of downloading
    killSwitch: true,              // block traffic if an established tunnel drops
    routeSearch: true,             // send search queries through it too

    // wstunnel provider: where the endpoint is published, and what to ask the
    // far side for. Leave remoteSocks blank to request a dynamic SOCKS5 tunnel,
    // which only works if the server does not restrict destinations.
    wstunnelPath: '',              // blank = look in %LOCALAPPDATA%\\TunnelVPN\\bin
    wsGistId: 'dd9367f161b28ac2c1beeba90a3e15c3',
    wsEndpoint: '',                // set this to skip the gist lookup
    wsRemoteSocks: '127.0.0.1:1080' // a SOCKS server on the far side; blank asks for a dynamic tunnel
  },
  dns: {
    mode: 'automatic',             // off | automatic | secure
    servers: 'https://dns.quad9.net/dns-query'
  },
  updates: {
    checkOnStart: true
  },
  passwords: {
    autofill: true,
    autoSave: true,                // save new logins with no prompt
    offerToSave: true,             // used only when autoSave is off
    requireHttps: true,            // never fill into a plain-http page
    autoLockMinutes: 15
  },
  // The separate, system-wide VPN app. Optional, and needs its own UAC prompt.
  vpn: {
    exePath: '',                  // blank = look in the usual places on first run
    autoLaunch: false,
    pollSeconds: 6
  },
  browser: {
    homepage: 'veil://home',
    newTabPage: 'veil://home',
    defaultZoom: 1,
    shortcuts: [
      { title: 'Wikipedia', url: 'https://en.wikipedia.org' },
      { title: 'GitHub', url: 'https://github.com' },
      { title: 'YouTube', url: 'https://youtube.com' },
      { title: 'Reddit', url: 'https://reddit.com' },
      { title: 'Hacker News', url: 'https://news.ycombinator.com' },
      { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org' }
    ]
  }
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(base[k])) out[k] = merge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }

/**
 * Version 1 kept nothing on disk at all, which signed you out of every account
 * on every launch. Version 2 replaces that pair of switches with one retention
 * setting and defaults it to keeping logins.
 */
/**
 * Bring an older settings file up to date.
 *
 * The steps run oldest first and each one hands over to the next, so a profile
 * written by any past version walks the whole chain in a single load. Running
 * them newest first - which this used to do - advanced a file by exactly one
 * step per launch, and quietly stranded anything more than one version behind.
 */
function migrate(data) {
  let changed = false;

  if (!data.version || data.version < 2) {
    const p = data.privacy || (data.privacy = {});
    if (p.retention === undefined) p.retention = 'keep';
    delete p.ephemeral;
    delete p.clearOnExit;
    data.version = 2;
    changed = true;
  }

  if (data.version === 2) {
    // The dark background hexes used to be written into every profile, which
    // meant switching to the light theme changed the text and left the page
    // black. Clearing the ones that match the old defaults hands them back to
    // the theme; anything the user actually chose is left alone.
    const a = data.appearance || (data.appearance = {});
    if (a.bgColor === '#0b0e13') a.bgColor = '';
    if (a.bgGradientA === '#0b0e13') a.bgGradientA = '';
    if (a.bgGradientB === '#131b26') a.bgGradientB = '';
    data.version = 3;
    changed = true;
  }

  if (data.version === 3) {
    // The light/dark switch is gone. Dark is the only starting point, and a
    // light interface is made by choosing a light background - the text and
    // surfaces follow whatever colour is set. A profile that was on the light
    // theme keeps looking light, by being given the background that theme
    // used to paint.
    const a = data.appearance || (data.appearance = {});
    if (a.theme === 'light' && !a.bgColor) a.bgColor = '#f2f4f7';
    delete a.theme;
    data.version = 4;
    changed = true;
  }

  return { data, changed };
}

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = clone(DEFAULTS);
    this._listeners = new Set();
    this._saveTimer = null;
    this.load();
  }

  load() {
    let migrated = false;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const result = migrate(merge(clone(DEFAULTS), JSON.parse(raw)));
      this.data = result.data;
      migrated = result.changed;
    } catch {
      this.data = clone(DEFAULTS);
    }
    if (!this.data.vpn.exePath) this.data.vpn.exePath = findVpn();
    // Write an upgraded config out straight away, so the file on disk always
    // describes what the running browser is actually doing.
    if (migrated) this.saveNow();
    return this.data;
  }

  all() { return this.data; }

  get(pathStr, fallback) {
    let cur = this.data;
    for (const part of String(pathStr).split('.')) {
      if (cur == null) return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }

  /** Deep-merge a patch and notify listeners. */
  update(patch) {
    this.data = merge(this.data, patch);
    this.save();
    this.emit();
    return this.data;
  }

  /** Replace whole config (used by import). */
  replace(obj) {
    this.data = merge(clone(DEFAULTS), obj || {});
    this.save();
    this.emit();
    return this.data;
  }

  reset() { return this.replace({}); }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      } catch (e) {
        console.error('[settings] save failed:', e.message);
      }
    }, 120);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {}
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { for (const fn of this._listeners) { try { fn(this.data); } catch {} } }
}

/**
 * Whether a background colour wants dark text on it.
 *
 * The interface has no light/dark setting any more: it reads the background
 * and dresses itself accordingly, so that picking a pale colour cannot leave
 * pale text on top of it.
 */
function isLightColour(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || ''));
  if (!m) return false;
  const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255).map(
    v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.4;
}

/** The colour the window and any new view should start out painted. */
function baseBackground(appearance) {
  const a = appearance || {};
  return a.bgColor || (a.bgType === 'gradient' && a.bgGradientA) || '#0b0e13';
}

module.exports = { Settings, DEFAULTS, findVpn, isLightColour, baseBackground };
