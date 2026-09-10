'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, dialog, shell, clipboard, nativeTheme, webContents, safeStorage, screen } = require('electron');

const { Settings } = require('./settings');
const { AdBlock } = require('./adblock');
const { NetPrivacy } = require('./net-privacy');
const { SearchEngine } = require('./search');
const { Vpn } = require('./vpn');
const { Tunnel } = require('./tunnel');
const { Vault } = require('./vault');
const { VPN_PICKER } = require('./platform');
const { edgesReached } = require('./hover');
const { computeLayout } = require('./layout');
const { Updater } = require('./updater');
const crypto = require('node:crypto');
const { TabManager } = require('./tabs');
const { registerScheme, registerHandler } = require('./protocol');
const { buildAppMenu, pageContextMenu, mainMenu } = require('./menus');

/* --------------------------------------------------------------- switches
   Everything Chromium does in the background that we do not want: prediction,
   telemetry, autofill, the whole ad-measurement Privacy Sandbox family. These
   must be set before the app is ready.                                     */

app.commandLine.appendSwitch('disable-features', [
  'Autofill', 'AutofillServerCommunication', 'AutofillEnableAccountWalletStorage',
  'PasswordManagerOnboarding', 'PasswordChangeInSettings', 'PasswordManagerEnableReceiverService',
  'InterestFeedContentSuggestions', 'Translate', 'MediaRouter', 'OptimizationHints',
  'PrivacySandboxSettings4', 'BrowsingTopics', 'InterestGroupStorage', 'Fledge',
  'AttributionReporting', 'PrivateAggregationApi', 'SharedStorageAPI', 'FirstPartySets',
  'TrustTokens', 'FedCm', 'IdleDetection', 'ComputePressure', 'WebOTP',
  'NetworkTimeServiceQuerying', 'SegmentationPlatform', 'HeavyAdIntervention'
].join(','));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('no-default-browser-check');
app.commandLine.appendSwitch('no-service-autorun');
app.commandLine.appendSwitch('dns-prefetch-disable');
app.commandLine.appendSwitch('disable-speech-api');

registerScheme();

const DEV = process.argv.includes('--dev');
const CHROME_MIN_H = 78;

let settings, adblock, netPrivacy, searchEngine, vpn, tunnel, vault, updater, tabs;
let win = null, chromeView = null, railView = null, browseSession = null, searchSession = null;

/* The chrome's shape and, when it floats, how much of it is out.
 *
 * toolbarShown and railShown run 0 (tucked away off-screen) to 1 (fully out)
 * and are animated here rather than in the renderers, because it is the view
 * rectangles that move - the documents inside them never change size. */
let chromeLayout = { mode: 'top', toolbarH: CHROME_MIN_H, railW: 0 };
let toolbarShown = 1, railShown = 1;
let holdToolbar = false;         // the address bar has focus; do not tuck it away
let chromeMode = 'bar';          // 'bar' along the top, or 'centre' for a minimal new tab
let downloads = [];              // this run only - nothing about them is written to disk

// Regenerated every launch, held only in memory: restarting Veil changes every
// fingerprinting answer it gives.
const fingerprintSecret = crypto.randomBytes(32).toString('hex');
let emitTimer = null;

/* ------------------------------------------------------------------ helpers */

function sendChrome(channel, payload) {
  // The toolbar and the tab rail are separate views but one piece of UI.
  for (const view of [chromeView, railView]) {
    if (view && !view.webContents.isDestroyed()) {
      try { view.webContents.send(channel, payload); } catch {}
    }
  }
}

/**
 * Remember a download for as long as the browser is open.
 *
 * In memory only, and never written anywhere: a list of what someone has
 * downloaded is exactly the sort of record this browser exists not to keep.
 * Closing Veil forgets it, which is the intended behaviour rather than a
 * missing feature.
 */
function noteDownload(entry) {
  downloads.unshift(entry);
  if (downloads.length > 100) downloads.length = 100;
  sendChrome('veil:downloads', downloads);
  broadcast('veil:downloads', downloads);
}

/** Send to the chrome strip and to every veil:// page that is open. */
function broadcast(channel, payload) {
  sendChrome(channel, payload);
  if (!tabs) return;
  for (const t of tabs.tabs.values()) {
    if (!t.url.startsWith('veil://')) continue;
    try { t.view.webContents.send(channel, payload); } catch {}
  }
}

function broadcastSettings() {
  broadcast('veil:settings', settings.all());
  watchHover(settings.get('appearance.autoHideChrome', false));
}

/* ------------------------------------------------- reaching for the chrome

   When the chrome is hidden it is behind the page, so it cannot be hovered:
   the page has every pixel and takes every mouse event. The only thing that
   still knows where the pointer is, is the OS.

   So while hiding is on, the cursor is polled and the chrome is told when the
   pointer reaches for it. That buys a band along the top *and* the left edge
   rather than a sliver of chrome the user has to hunt for, and it works the
   same whether the tabs are on top or down the side.                        */

const HOVER_BAND = 26;      // how near an edge counts as reaching
// How often the cursor is looked at. This is dead time before the chrome even
// begins to move, so it is the part a user feels as lag rather than as
// animation. 25ms costs nothing measurable and takes the delay below the
// threshold where it reads as a pause.
const HOVER_POLL = 25;
let hoverTimer = null;
let hoverState = null;

function cursorEdges() {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return { top: false, left: false };
  let p, b;
  try { p = screen.getCursorScreenPoint(); b = win.getContentBounds(); } catch { return { top: false, left: false }; }
  return edgesReached({
    x: p.x - b.x, y: p.y - b.y,
    width: b.width, height: b.height,
    // Once a part is out, resting anywhere on it holds it out.
    top: Math.round(chromeLayout.toolbarH * toolbarShown),
    left: chromeLayout.mode === 'side' ? Math.round(chromeLayout.railW * railShown) : 0,
    band: HOVER_BAND
  });
}

function watchHover(on) {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
  hoverState = null;
  if (!on) {
    // Docked again: put everything back where it belongs.
    wantToolbar = wantRail = 1;
    toolbarShown = railShown = 1;
    relayout();
    return;
  }
  wantToolbar = wantRail = 0;
  toolbarShown = railShown = 0;
  relayout();
  hoverTimer = setInterval(() => {
    const e = cursorEdges();
    // The toolbar and the rail are separate things that open separately: the
    // top edge asks for one, the left edge for the other.
    showChrome('toolbar', e.top);
    if (chromeLayout.mode === 'side') showChrome('rail', e.left);
  }, HOVER_POLL);
}

function pushState() {
  clearTimeout(emitTimer);
  emitTimer = setTimeout(() => sendChrome('veil:tabs', tabs.state()), 16);
}

function floating() {
  return !!settings.get('appearance.autoHideChrome', false);
}

/** The centred search box of a minimal new tab, in window coordinates. */
function centreBox(w, h) {
  const width = Math.max(320, Math.min(620, Math.round(w * 0.52)));
  return { x: Math.round((w - width) / 2), y: Math.round(h * 0.30), width, height: 66 };
}

function relayout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const float = floating();

  const L = computeLayout({
    width: w, height: h,
    mode: chromeLayout.mode,
    toolbarH: chromeLayout.toolbarH,
    railW: chromeLayout.railW,
    floating: float,
    toolbarShown: float ? toolbarShown : 1,
    railShown: float ? railShown : 1
  });

  if (chromeView) {
    chromeView.setBounds(chromeMode === 'centre' ? centreBox(w, h) : L.chrome);
  }
  if (railView) {
    // An absent rail is parked at zero size rather than removed, so that
    // switching tab layouts does not tear down and rebuild its document.
    railView.setBounds(L.rail || { x: 0, y: 0, width: 0, height: 0 });
  }
  if (tabs) {
    tabs.inset = { top: L.page.y, left: L.page.x };
    tabs.peekBase = null;              // nothing slides the page any more
    tabs.layout();
  }
}

/**
 * Keep the chrome above the page.
 *
 * Views stack in the order they are added and TabManager adds a page view
 * whenever one is created or activated, so the chrome has to be lifted back on
 * top afterwards. Floating depends on it; docked does not care, since then
 * nothing overlaps.
 */
function raiseChrome() {
  if (!win || win.isDestroyed()) return;
  for (const view of [railView, chromeView]) {
    if (view) { try { win.contentView.addChildView(view); } catch {} }
  }
}

/* ---------------------------------------------------- sliding the chrome

   One timer moves both, because they are two rectangles rather than two
   documents: nothing here relayouts a page, so a frame costs almost nothing.
   The page is untouched throughout - that is what floating buys.           */

const SLIDE_MS = 130;       // long enough to read as motion, short enough not to wait on
let slideTimer = null;
let wantToolbar = 1, wantRail = 1;

function slideChrome() {
  if (slideTimer) return;
  const t0 = Date.now();
  const fromToolbar = toolbarShown, fromRail = railShown;
  slideTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / SLIDE_MS);
    const eased = 1 - Math.pow(1 - p, 3);
    toolbarShown = fromToolbar + (wantToolbar - fromToolbar) * eased;
    railShown = fromRail + (wantRail - fromRail) * eased;
    relayout();
    if (p >= 1) { clearInterval(slideTimer); slideTimer = null; }
  }, 8);       // ~120Hz: the views are rectangles, so frames are nearly free
}

function showChrome(part, on) {
  const want = on ? 1 : 0;
  if (part === 'toolbar') {
    if (holdToolbar && !on) return;
    if (wantToolbar === want) return;
    wantToolbar = want;
  } else {
    if (wantRail === want) return;
    wantRail = want;
  }
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  slideChrome();
}

/* ------------------------------------------------- the minimal new tab

   A search box in the middle of the window, with the page you were already
   on left visible behind it. The toolbar view is reused rather than a fourth
   view invented: it already owns the omnibox and everything the omnibox
   knows, so all that changes is its rectangle and how it draws itself.     */

function openCentreSearch() {
  if (!chromeView) return;
  chromeMode = 'centre';
  holdToolbar = true;
  wantToolbar = toolbarShown = 1;
  sendChrome('veil:chrome-mode', 'centre');
  relayout();
  raiseChrome();
  chromeView.webContents.focus();
  sendChrome('veil:focus-omnibox');
}

function closeCentreSearch() {
  if (chromeMode !== 'centre') return;
  chromeMode = 'bar';
  holdToolbar = false;
  sendChrome('veil:chrome-mode', 'bar');
  if (floating()) { wantToolbar = 0; toolbarShown = 0; }
  relayout();
  const t = tabs && tabs.active();
  if (t) t.view.webContents.focus();
}

/** Turn whatever the user typed into a URL: address, bang, or search. */
function resolveInput(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(https?|veil|file|about|mailto|tel):/i.test(t)) return t;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(t)) return 'http://' + t;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#]|$)/i.test(t)) {
    return 'https://' + t;
  }
  return searchEngine.urlForQuery(t);
}

/**
 * Only Veil's own pages may drive settings, dialogs or the clipboard. The
 * preload already withholds the bridge from web pages; this is the half that
 * does not depend on the renderer behaving.
 */
function isInternal(event) {
  try { return (event.sender.getURL() || '').startsWith('veil://'); } catch { return false; }
}

function guard(fn) {
  return (event, ...args) => {
    if (!isInternal(event)) throw new Error('Veil: this API is only available to internal pages');
    return fn(event, ...args);
  };
}

function guardOn(fn) {
  return (event, ...args) => { if (isInternal(event)) fn(event, ...args); };
}

function tabForSender(sender) {
  if (!tabs) return null;
  for (const t of tabs.tabs.values()) {
    if (t.view.webContents.id === sender.id) return t;
  }
  return null;
}

/* ------------------------------------------------------------------ actions */

const actions = {
  newTab(url, background = false) {
    // Minimal mode: rather than open a blank page, put a search box over
    // whatever is already on screen. Nothing is created until it is used, so
    // backing out with Escape leaves no empty tab behind.
    if (!url && !background && settings.get('appearance.minimalNewTab', false)) {
      openCentreSearch();
      return;
    }
    tabs.create(url || settings.get('browser.newTabPage', 'veil://home/'), { background });
  },

  /** The address bar has focus: do not tuck the toolbar away underneath it. */
  holdChrome(on) {
    holdToolbar = !!on;
    if (holdToolbar) showChrome('toolbar', true);
  },
  closeTab(id) { tabs.close(id != null ? id : tabs.activeId); },
  openInternal(url) {
    // Reuse an existing tab already on that page instead of stacking duplicates.
    for (const t of tabs.tabs.values()) {
      if (t.url.startsWith(url.replace(/\/$/, ''))) { tabs.select(t.id); return; }
    }
    tabs.create(url);
  },
  go(text, sender) {
    const url = resolveInput(text);
    if (!url) return;
    const t = sender ? tabForSender(sender) : null;
    if (t) t.view.webContents.loadURL(url).catch(() => {});
    else tabs.navigate(url);
  },
  searchFor(query, newTab) {
    const url = searchEngine.urlForQuery(query);
    if (newTab) tabs.create(url); else tabs.navigate(url);
  },
  back() { const wc = tabs.activeContents(); if (!wc) return; wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack(); },
  forward() { const wc = tabs.activeContents(); if (!wc) return; wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward(); },
  reload(bypass) { const wc = tabs.activeContents(); if (wc) bypass ? wc.reloadIgnoringCache() : wc.reload(); },
  stop() { const wc = tabs.activeContents(); if (wc) wc.stop(); },
  home() { tabs.navigate(settings.get('browser.homepage', 'veil://home/')); },
  zoom(dir) {
    const wc = tabs.activeContents();
    if (!wc) return;
    const steps = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
    if (dir === 0) { wc.setZoomFactor(Number(settings.get('browser.defaultZoom', 1)) || 1); }
    else {
      const cur = wc.getZoomFactor();
      let i = steps.findIndex(s => Math.abs(s - cur) < 0.02);
      if (i < 0) i = steps.findIndex(s => s > cur) - (dir > 0 ? 1 : 0);
      i = Math.max(0, Math.min(steps.length - 1, (i < 0 ? 4 : i) + dir));
      wc.setZoomFactor(steps[i]);
    }
    pushState();
  },
  devtools() {
    const wc = tabs.activeContents();
    if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
  },
  focusOmnibox() { if (chromeView) { chromeView.webContents.focus(); sendChrome('veil:focus-omnibox'); } },
  openFind() { if (chromeView) { chromeView.webContents.focus(); sendChrome('veil:open-find'); } },
  findNext(forward) { sendChrome('veil:find-next', forward); },
  copyAddress() { const t = tabs.active(); if (t) clipboard.writeText(t.url); },
  toggleSiteBlocking() {
    const t = tabs.active();
    if (!t) return;
    let host = '';
    try { host = new URL(t.url).hostname; } catch { return; }
    if (!host) return;
    const on = adblock.isAllowedSite(host);      // currently paused -> turn back on
    adblock.toggleSite(host, on);
    t.view.webContents.reload();
    sendChrome('veil:toast', {
      kind: 'info',
      text: on ? 'Blocking resumed on ' + host : 'Blocking paused on ' + host
    });
    pushState();
  },
  async updateLists() {
    sendChrome('veil:toast', { kind: 'info', text: 'Updating blocklists…' });
    const r = await adblock.updateLists();
    const failed = r.results.filter(x => !x.ok);
    sendChrome('veil:toast', {
      kind: failed.length ? 'warn' : 'ok',
      text: failed.length
        ? 'Some lists failed: ' + failed.map(f => f.name).join(', ')
        : 'Blocklists updated — ' + r.total.toLocaleString() + ' domains'
    });
    pushState();
  },
  async clearData() {
    await browseSession.clearStorageData();
    await browseSession.clearCache();
    await browseSession.clearAuthCache();
    sendChrome('veil:toast', { kind: 'ok', text: 'Cookies, cache and site data cleared' });
  },
  async vpnLaunch() {
    const r = await vpn.launch();
    sendChrome('veil:toast', r.ok
      ? { kind: 'ok', text: 'Tunnel VPN opened — press Connect in its window' }
      : { kind: 'warn', text: r.error });
    setTimeout(pollVpn, 1500);
  },
  vpnLogs() { vpn.openLogs(); },
  async tunnelToggle() {
    applyTunnelSessions();
    await tunnel.toggle();
  },
  passwords() { actions.openInternal('veil://passwords/'); },
  quit() { app.quit(); }
};

/* ---------------------------------------------------------------- vpn poll */

let vpnTimer = null;
async function pollVpn() {
  if (!vpn) return;
  try {
    const s = await vpn.status();
    if (tunnel) tunnel.syncSystem(s);
    sendChrome('veil:vpn', s);
    if (tabs) {
      for (const t of tabs.tabs.values()) {
        if (t.url.startsWith('veil://')) { try { t.view.webContents.send('veil:vpn', s); } catch {} }
      }
    }
  } catch {}
}

function startVpnPolling() {
  clearInterval(vpnTimer);
  const secs = Math.max(3, Number(settings.get('vpn.pollSeconds', 6)) || 6);
  vpnTimer = setInterval(pollVpn, secs * 1000);
  pollVpn();
}

/* ------------------------------------------------------------------ session */

function createSessions() {
  // 'keep' is a real on-disk profile: logins survive a restart and the HTTP
  // cache survives with them, which is also the single biggest speed win.
  const keep = settings.get('privacy.retention', 'keep') !== 'none';
  browseSession = session.fromPartition(keep ? 'persist:veil' : 'veil-private');
  searchSession = session.fromPartition('veil-search');   // always throwaway

  const chromeVersion = process.versions.chrome.split('.')[0];
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;
  app.userAgentFallback = ua;
  browseSession.setUserAgent(ua);
  searchSession.setUserAgent(ua);

  browseSession.setSpellCheckerEnabled(false);

  // Permissions: silence the noisy ones outright, ask about the meaningful ones.
  const ALWAYS_OK = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
  const ALWAYS_NO = new Set([
    'notifications', 'background-sync', 'idle-detection', 'midiSysex', 'midi',
    'hid', 'serial', 'usb', 'bluetooth', 'window-management', 'local-fonts',
    'storage-access', 'top-level-storage-access', 'payment-handler',
    'speaker-selection', 'display-capture', 'window-placement'
  ]);
  const ASKABLE = new Set(['media', 'geolocation', 'clipboard-read', 'openExternal']);

  browseSession.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (ALWAYS_OK.has(permission)) return callback(true);
    if (ALWAYS_NO.has(permission)) return callback(false);
    if (!settings.get('privacy.denyPermissions', true)) return callback(ASKABLE.has(permission));
    if (!ASKABLE.has(permission)) return callback(false);

    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Block', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      title: 'Permission request',
      message: `${origin || 'This site'} wants access to: ${permission}`,
      detail: 'Veil denies these by default. Allowing applies to this request only.'
    });
    callback(response === 1);
  });

  browseSession.setPermissionCheckHandler((wc, permission) => ALWAYS_OK.has(permission));

  // Downloads always ask where to go — nothing lands on disk silently.
  browseSession.on('will-download', (event, item) => {
    item.setSaveDialogOptions({ title: 'Save file', defaultPath: item.getFilename() });
    const name = item.getFilename();
    const size = item.getTotalBytes();
    item.once('done', (e, state) => {
      if (state === 'completed') {
        noteDownload({ name, path: item.getSavePath(), size, at: Date.now(), state: 'completed' });
        sendChrome('veil:toast', { kind: 'ok', text: 'Downloaded ' + name, path: item.getSavePath() });
      } else if (state === 'cancelled') {
        sendChrome('veil:toast', { kind: 'info', text: 'Download cancelled' });
      } else {
        noteDownload({ name, path: '', size, at: Date.now(), state: 'failed' });
        sendChrome('veil:toast', { kind: 'warn', text: 'Download failed: ' + name });
      }
    });
  });
}

/* ------------------------------------------------------------------ tunnel */

function applyTunnelSessions() {
  const list = [browseSession];
  if (settings.get('tunnel.routeSearch', true)) list.push(searchSession);
  tunnel.attach(list);
}

/**
 * Encrypted DNS. "automatic" upgrades to DoH where the resolver supports it and
 * falls back otherwise; "secure" refuses to fall back, which is stronger but
 * breaks browsing if the resolver is unreachable.
 */
function applySecureDns() {
  const mode = settings.get('dns.mode', 'automatic');
  const servers = String(settings.get('dns.servers', '') || '')
    .split(/[\s,]+/).filter(Boolean);
  try {
    app.configureHostResolver({
      secureDnsMode: mode === 'off' ? 'off' : mode,
      secureDnsServers: mode === 'off' ? [] : servers
    });
  } catch (e) {
    console.error('[dns] configureHostResolver failed:', e.message);
  }
}

/* ------------------------------------------------------------------- window */

function createWindow() {
  win = new BaseWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: settings.get('appearance.theme') === 'light' ? '#f4f5f7' : '#0b0e13',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    title: 'Veil'
  });
  try { win.setMenuBarVisibility(false); win.setAutoHideMenuBar(true); } catch {}

  chromeView = new WebContentsView({
    webPreferences: {
      session: browseSession,
      preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  win.contentView.addChildView(chromeView);
  chromeView.setBounds({ x: 0, y: 0, width: 1320, height: chromeLayout.toolbarH });
  chromeView.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[veil] chrome failed to load:', code, desc, url);
  });
  if (DEV) {
    chromeView.webContents.on('console-message', (e) => console.log('[chrome]', e.message));
  }
  chromeView.webContents.loadURL('veil://chrome/').catch((err) => {
    console.error('[veil] chrome loadURL rejected:', err.message);
  });
  chromeView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) tabs.create(url);
    return { action: 'deny' };
  });

  // The tab rail is a second view rather than part of the chrome document, so
  // that it can float over the page instead of pushing it aside. It exists in
  // both tab layouts and is simply given no size in the horizontal one.
  railView = new WebContentsView({
    webPreferences: {
      session: browseSession,
      preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  win.contentView.addChildView(railView);
  railView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  if (DEV) railView.webContents.on('console-message', (e) => console.log('[rail]', e.message));
  railView.webContents.loadURL('veil://rail/').catch((err) => {
    console.error('[veil] rail loadURL rejected:', err.message);
  });
  railView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  tabs = new TabManager({
    win,
    settings,
    session: browseSession,
    inset: { top: chromeLayout.toolbarH, left: chromeLayout.railW },
    onUpdate: () => { pushState(); raiseChrome(); },
    onContextMenu: (tab, params) => {
      pageContextMenu({ actions, settings, adblock, tabs }, tab, params).popup({ window: win });
    },
    onUpgradeFailed: (url) => netPrivacy.originalFor(url),
    blockedCount: (wcId) => adblock.countFor(wcId),
    resetBlocked: (wcId) => adblock.resetCount(wcId),
    onFindResult: (r) => sendChrome('veil:find-result', r)
  });

  win.on('resize', relayout);
  win.on('maximize', () => { relayout(); sendChrome('veil:window', { maximized: true }); });
  win.on('unmaximize', () => { relayout(); sendChrome('veil:window', { maximized: false }); });
  win.on('enter-full-screen', relayout);
  win.on('leave-full-screen', relayout);

  win.on('close', () => {
    settings.saveNow();
    clearInterval(vpnTimer);
    if (tabs) tabs.destroyAll();
  });
  win.on('closed', () => { win = null; app.quit(); });

  chromeView.webContents.once('did-finish-load', () => { if (win && !win.isVisible()) win.show(); });
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 1500);
}

/* ---------------------------------------------------------------------- ipc */

function wireIpc() {
  ipcMain.on('chrome:ready', guardOn((e) => {
    e.sender.send('veil:settings', settings.all());
    if (tunnel) e.sender.send('veil:tunnel', tunnel.status());
    e.sender.send('veil:tabs', tabs.state());
    e.sender.send('veil:downloads', downloads);
    e.sender.send('veil:chrome-mode', chromeMode);
    e.sender.send('veil:window', { maximized: win.isMaximized() });
    pollVpn();
    // The chrome may already be set to hide, in which case nothing has asked
    // for the cursor watch yet - broadcastSettings() only runs on a change.
    watchHover(settings.get('appearance.autoHideChrome', false));
  }));

  ipcMain.on('ui:layout', guardOn((e, l) => {
    // The chrome document reports how tall it wants to be; the rail reports
    // its own width separately, on 'ui:rail'.
    const mode = l && l.mode === 'side' ? 'side' : 'top';
    const raw = Number(l && l.top);
    const toolbarH = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : CHROME_MIN_H;
    if (mode === chromeLayout.mode && toolbarH === chromeLayout.toolbarH) return;
    chromeLayout = { mode, toolbarH, railW: chromeLayout.railW };
    relayout();
  }));

  ipcMain.on('ui:centre-close', guardOn(() => closeCentreSearch()));

  ipcMain.on('ui:rail', guardOn((e, r) => {
    const raw = Number(r && r.width);
    const railW = Number.isFinite(raw) ? Math.max(0, Math.min(600, Math.round(raw))) : 0;
    if (railW === chromeLayout.railW) return;
    chromeLayout = { mode: chromeLayout.mode, toolbarH: chromeLayout.toolbarH, railW };
    relayout();
  }));

  ipcMain.on('win:minimize', guardOn(() => win && win.minimize()));
  ipcMain.on('win:maximize', guardOn(() => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  }));
  ipcMain.on('win:close', guardOn(() => win && win.close()));

  ipcMain.on('tab:new', guardOn((e, url) => actions.newTab(url)));
  ipcMain.on('tab:close', guardOn((e, id) => actions.closeTab(id)));
  ipcMain.on('tab:select', guardOn((e, id) => tabs.select(id)));
  ipcMain.on('tab:move', guardOn((e, id, index) => tabs.move(id, index)));

  ipcMain.on('nav:back', guardOn(() => actions.back()));
  ipcMain.on('nav:forward', guardOn(() => actions.forward()));
  ipcMain.on('nav:reload', guardOn((e, bypass) => actions.reload(!!bypass)));
  ipcMain.on('nav:stop', guardOn(() => actions.stop()));
  ipcMain.on('nav:home', guardOn(() => actions.home()));
  ipcMain.on('nav:go', guardOn((e, text) => actions.go(text, e.sender)));
  ipcMain.on('nav:newtab', guardOn((e, text) => {
    const url = resolveInput(text);
    if (url) tabs.create(url);
  }));

  ipcMain.on('menu:main', guardOn(() => {
    mainMenu({ actions, adblock, tabs, settings }).popup({ window: win });
  }));

  ipcMain.on('shield:toggle', guardOn(() => actions.toggleSiteBlocking()));

  // find in page
  ipcMain.on('find:run', guardOn((e, text, opts) => {
    const wc = tabs.activeContents();
    if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); return; }
    wc.findInPage(text, opts || {});
  }));
  ipcMain.on('find:stop', guardOn(() => {
    const wc = tabs.activeContents();
    if (wc) wc.stopFindInPage('clearSelection');
  }));

  /* ---- invoke handlers ------------------------------------------------
     Everything below is reachable only from veil:// pages. The preload keeps
     the bridge away from web pages; `guard` is the half that does not rely on
     the renderer behaving. The one exception is page:cosmetic, a single
     boolean that ordinary pages need so the ad-slot collapser knows whether
     to run.                                                              */

  /**
   * One secret per run, never stored. Mixed with the page's own origin so each
   * site sees stable readings that no other site can line up against.
   */
  ipcMain.handle('page:fingerprint', (event, claimedOrigin) => {
    if (!settings.get('privacy.antiFingerprint', true)) return { enabled: false };

    // A preload runs before the navigation has settled, so the webContents URL
    // is often still the previous page or blank. The sending frame knows, and
    // the page itself is asked as a last resort - it can only ever change its
    // own noise, which gains it nothing.
    let origin = '';
    try {
      const frame = event.senderFrame;
      if (frame && frame.url) origin = new URL(frame.url).origin;
    } catch {}
    if (!origin || origin === 'null') {
      origin = (typeof claimedOrigin === 'string' && /^https?:\/\//.test(claimedOrigin))
        ? claimedOrigin.slice(0, 200) : '';
    }
    const digest = crypto.createHash('sha256').update(fingerprintSecret + '|' + origin).digest();
    return {
      enabled: true,
      seed: digest.readUInt32BE(0),
      canvas: true,
      webgl: true,
      audio: true,
      navigator: settings.get('privacy.normaliseNavigator', true)
    };
  });

  ipcMain.handle('page:cosmetic', () =>
    !!(settings.get('privacy.blockAds', true) && settings.get('privacy.cosmeticFiltering', true)));

  ipcMain.handle('settings:get', guard(() => settings.all()));

  ipcMain.handle('settings:set', guard((e, patch) => {
    const before = settings.get('privacy.retention');
    const data = settings.update(patch || {});
    adblock.rebuild();
    broadcastSettings();
    startVpnPolling();
    if (before !== settings.get('privacy.retention')) {
      sendChrome('veil:toast', { kind: 'info', text: 'Restart Veil for the profile change to take effect' });
    }
    return data;
  }));

  ipcMain.handle('settings:reset', guard(() => {
    const data = settings.reset();
    adblock.rebuild();
    broadcastSettings();
    return data;
  }));

  ipcMain.handle('settings:pick-image', guard(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a background image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.update({ appearance: { bgImage: r.filePaths[0], bgType: 'image' } });
    broadcastSettings();
    return r.filePaths[0];
  }));

  ipcMain.handle('settings:pick-exe', guard(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: VPN_PICKER.title,
      properties: ['openFile'],
      filters: VPN_PICKER.filters
    });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.update({ vpn: { exePath: r.filePaths[0] } });
    broadcastSettings();
    pollVpn();
    return r.filePaths[0];
  }));

  ipcMain.handle('settings:export', guard(async () => {
    const r = await dialog.showSaveDialog(win, { title: 'Export settings', defaultPath: 'veil-settings.json' });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, JSON.stringify(settings.all(), null, 2), 'utf8');
    return true;
  }));

  ipcMain.handle('settings:import', guard(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import settings', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      const data = settings.replace(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
      adblock.rebuild();
      broadcastSettings();
      return data;
    } catch (err) {
      dialog.showErrorBox('Import failed', err.message);
      return null;
    }
  }));

  ipcMain.handle('search:run', guard(async (e, q, page) => {
    try {
      return await searchEngine.run(String(q || '').slice(0, 400), page);
    } catch (err) {
      return {
        query: q, page: 1, hasNext: false, results: [], answer: null,
        errors: [err.message], took: 0, fallbackUrl: searchEngine.externalUrl(q)
      };
    }
  }));

  ipcMain.handle('search:images', guard(async (e, q, page) => {
    return searchEngine.images(String(q || ''), Math.max(1, Number(page) || 1));
  }));

  ipcMain.handle('search:url-for', guard((e, q) => searchEngine.urlForQuery(String(q || ''))));

  ipcMain.handle('adblock:stats', guard(() => ({
    domains: adblock.size(),
    builtin: adblock.builtinCount,
    blockedTotal: adblock.total,
    lastUpdated: settings.get('adblock.lastUpdated', 0),
    lists: settings.get('adblock.lists', [])
  })));

  ipcMain.handle('adblock:update', guard(() => adblock.updateLists()));

  ipcMain.handle('vpn:status', guard(() => vpn.status()));
  ipcMain.handle('vpn:launch', guard(() => actions.vpnLaunch()));
  ipcMain.on('vpn:logs', guardOn(() => vpn.openLogs()));

  ipcMain.handle('app:info', guard(() => ({
    versions: {
      veil: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    },
    paths: { settings: path.join(app.getPath('userData'), 'settings.json'), userData: app.getPath('userData') },
    retention: settings.get('privacy.retention', 'keep')
  })));

  ipcMain.on('open:external', guardOn((e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  }));
  ipcMain.on('clipboard:write', guardOn((e, text) => clipboard.writeText(String(text || ''))));
  ipcMain.on('action', guardOn((e, name, arg) => {
    if (Object.prototype.hasOwnProperty.call(actions, name) && typeof actions[name] === 'function') {
      actions[name](arg);
    }
  }));

  /* ---- tunnel ---- */

  ipcMain.handle('httpsonly:allow', guard((e, url) => netPrivacy.allowInsecure(url)));

  ipcMain.handle('downloads:list', guard(() => downloads));
  ipcMain.handle('downloads:clear', guard(() => {
    downloads = [];
    sendChrome('veil:downloads', downloads);
    broadcast('veil:downloads', downloads);
    return downloads;
  }));
  ipcMain.handle('downloads:reveal', guard((e, p) => {
    // Only ever a path this process recorded itself, never one from a page.
    if (typeof p !== 'string' || !downloads.some(d => d.path === p)) return false;
    shell.showItemInFolder(p);
    return true;
  }));

  ipcMain.handle('update:status', guard(() => updater.status()));
  ipcMain.handle('update:check', guard(() => updater.check()));
  ipcMain.handle('update:download', guard(() => updater.download()));
  ipcMain.handle('update:install', guard(() => updater.install()));

  ipcMain.handle('tunnel:status', guard(() => tunnel.status()));
  ipcMain.handle('tunnel:set-credentials', guard((e, user, pass) => {
    tunnel.setCredentials(user, pass);
    return tunnel.status();
  }));
  ipcMain.handle('tunnel:clear-credentials', guard(() => {
    tunnel.clearCredentials();
    return tunnel.status();
  }));
  ipcMain.handle('tunnel:exit-info', guard(() => tunnel.exitInfo()));
  ipcMain.handle('tunnel:toggle', guard(async () => { await tunnel.toggle(); return tunnel.status(); }));
  ipcMain.handle('tunnel:reconnect', guard(async () => {
    applyTunnelSessions();
    await tunnel.disable();
    await tunnel.enable();
    return tunnel.status();
  }));

  /* ---- prompts raised from the main process ---- */

  ipcMain.on('prompt:answer', guardOn((e, id, choice) => {
    const resolve = pendingPrompts.get(id);
    if (resolve) { pendingPrompts.delete(id); resolve(choice); }
  }));
}

/* ------------------------------------------------------------------ prompts */

const pendingPrompts = new Map();
let promptSeq = 1;

/** Ask a question in the chrome strip and wait for the answer. */
function ask(text, choices, timeoutMs = 45000) {
  const id = promptSeq++;
  sendChrome('veil:prompt', { id, text, choices });
  return new Promise((resolve) => {
    pendingPrompts.set(id, resolve);
    setTimeout(() => {
      if (pendingPrompts.has(id)) {
        pendingPrompts.delete(id);
        sendChrome('veil:prompt-close', id);
        resolve(null);
      }
    }, timeoutMs);
  });
}

/* -------------------------------------------------------------------- vault */

/**
 * Password channels are reachable from ordinary web pages, so none of them use
 * `guard`. Each one instead derives the site from the sending frame and refuses
 * anything that does not line up: a page can only ask about itself, and only
 * from the top frame, so a cross-origin iframe cannot fish for the parent
 * site's logins.
 */
function topFrameUrl(event) {
  try {
    const frame = event.senderFrame;
    if (frame && frame.parent) return null;      // sub-frames need not apply
    return (frame && frame.url) || event.sender.getURL() || null;
  } catch { return event.sender.getURL() || null; }
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function wireVaultIpc() {
  // Vault management is Veil's own business: internal pages only.
  ipcMain.handle('vault:state', guard(() => vault.state()));
  ipcMain.handle('vault:create', guard((e, master) => vault.create(master)));
  ipcMain.handle('vault:create-auto', guard(() => vault.createAuto()));
  ipcMain.handle('vault:unlock', guard((e, master) => vault.unlock(master)));
  ipcMain.handle('vault:quick-unlock', guard(() => vault.quickUnlock()));
  ipcMain.handle('vault:lock', guard(() => vault.lock()));
  ipcMain.handle('vault:enable-quick', guard(() => vault.enableQuickUnlock()));
  ipcMain.handle('vault:disable-quick', guard(() => vault.disableQuickUnlock()));
  ipcMain.handle('vault:change-master', guard((e, a, b) => vault.changeMaster(a, b)));
  ipcMain.handle('vault:list', guard(() => vault.list()));
  ipcMain.handle('vault:reveal', guard((e, id) => vault.reveal(id)));
  ipcMain.handle('vault:save', guard((e, entry) => vault.save(entry)));
  ipcMain.handle('vault:delete', guard((e, id) => vault.remove(id)));
  ipcMain.handle('vault:generate', guard((e, opts) => Vault.generate(opts)));

  // Autofill is reachable from web pages, scoped to the asking page.
  ipcMain.handle('autofill:candidates', (event) => {
    if (!settings.get('passwords.autofill', true)) return { locked: false, items: [] };
    const url = topFrameUrl(event);
    if (!url || !/^https?:/i.test(url)) return { locked: false, items: [] };
    if (settings.get('passwords.requireHttps', true) && !url.startsWith('https:')) {
      return { locked: false, items: [], insecure: true };
    }
    // Auto-lock should not mean "type your master password again on every
    // login form". If the user opted into Windows unlock, reopen quietly.
    if (!vault.unlocked() && vault.hasQuickUnlock()) {
      try { vault.quickUnlock(); } catch {}
    }
    if (!vault.unlocked()) return { locked: vault.exists(), items: [] };
    return { locked: false, items: vault.candidates(url) };
  });

  ipcMain.handle('autofill:fill', (event, id) => {
    const url = topFrameUrl(event);
    if (!url || !/^https?:/i.test(url)) throw new Error('not a web page');
    if (settings.get('passwords.requireHttps', true) && !url.startsWith('https:')) {
      throw new Error('refusing to put a password into a plain-http page');
    }
    return vault.credentialFor(id, url);       // re-checks the site itself
  });

  ipcMain.handle('autofill:offer-save', async (event, payload) => {
    const url = topFrameUrl(event);
    if (!url || !/^https?:/i.test(url)) return false;

    const username = String((payload && payload.username) || '').slice(0, 200);
    const password = String((payload && payload.password) || '');
    if (!password) return false;

    const host = hostLabel(url);
    if (!host) return false;

    let origin = url;
    try { origin = new URL(url).origin; } catch {}

    /** Write it down and say so, without asking anything. */
    const store = () => {
      const existing = vault.findByLogin(url, username);
      if (existing && vault.reveal(existing.id) === password) return true;   // unchanged
      vault.save({ id: existing ? existing.id : undefined, origin, username, password });
      sendChrome('veil:toast', {
        kind: 'ok',
        text: (existing ? 'Updated password for ' : 'Saved login for ') + host
      });
      return true;
    };

    // Automatic: no prompt, and no vault setup to do first.
    if (settings.get('passwords.autoSave', true)) {
      try {
        if (!vault.exists() && safeStorage.isEncryptionAvailable()) vault.createAuto();
        if (!vault.unlocked() && vault.hasQuickUnlock()) vault.quickUnlock();
        if (vault.unlocked()) return store();
      } catch (e) {
        console.error('[vault] automatic save failed:', e.message);
      }
      // Falls through to asking when the vault is locked behind a master
      // password, or the OS keystore is unavailable.
    }

    if (!settings.get('passwords.offerToSave', true)) return false;

    if (!vault.exists()) {
      const choice = await ask('Save the login for ' + host + '? Veil needs a master password first.',
        [{ id: 'setup', label: 'Set up', primary: true }, { id: 'no', label: 'Not now' }]);
      if (choice === 'setup') actions.openInternal('veil://passwords/');
      return false;
    }
    if (!vault.unlocked()) {
      const choice = await ask('Unlock the vault to save the login for ' + host + '?',
        [{ id: 'unlock', label: 'Unlock', primary: true }, { id: 'no', label: 'Not now' }]);
      if (choice === 'unlock') actions.openInternal('veil://passwords/');
      return false;
    }

    const existing = vault.findByLogin(url, username);
    const verb = existing ? 'Update' : 'Save';
    const choice = await ask(verb + ' the password for ' + (username || 'this login') + ' on ' + host + '?',
      [{ id: 'yes', label: verb, primary: true }, { id: 'no', label: 'Never mind' }]);
    if (choice !== 'yes') return false;

    return store();
  });
}

/* -------------------------------------------------------------------- start */

/*
 * One instance per profile, rather than one instance per machine.
 *
 * The lock exists so that two copies cannot share - and corrupt - one profile
 * directory. A run given its own --user-data-dir is not sharing anything, so
 * holding it to the same rule only means a second profile silently refuses to
 * start, with no window and no message to say why.
 */
const ownProfile = process.argv.some(a => a.startsWith('--user-data-dir'));
const gotLock = ownProfile || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    settings = new Settings();
    nativeTheme.themeSource = settings.get('appearance.theme') === 'light' ? 'light' : 'dark';

    createSessions();
    registerHandler(settings, browseSession);
    if (browseSession !== session.defaultSession) registerHandler(settings, session.defaultSession);

    adblock = new AdBlock(settings);
    netPrivacy = new NetPrivacy(browseSession, {
      settings,
      adblock,
      getTopUrl: (wcId) => (tabs ? tabs.topUrlFor(wcId) : ''),
      onBlocked: () => pushState(),
      onMainFrameBlocked: (wcId, url) => {
        pushState();
        setImmediate(() => {
          const wc = webContents.fromId(wcId);
          if (wc && !wc.isDestroyed()) {
            wc.loadURL('veil://blocked/?url=' + encodeURIComponent(url)).catch(() => {});
          }
        });
      }
    });
    searchEngine = new SearchEngine(settings, searchSession);
    searchEngine.warmUp();

    vault = new Vault(settings);
    vpn = new Vpn(settings);

    updater = new Updater(settings, (status) => {
      broadcast('veil:update', status);
      if (status.warn) {
        sendChrome('veil:toast', {
          kind: 'warn',
          text: 'This build is ' + status.ageDays + ' days old. Chromium security fixes ship monthly - update Veil.'
        });
      }
    });

    // The tunnel can be backed by the system VPN app, so it needs that first.
    tunnel = new Tunnel(settings, (status) => {
      broadcast('veil:tunnel', status);
      if (status.state === 'blocked') {
        sendChrome('veil:toast', { kind: 'warn', text: status.detail });
      }
    }, vpn);
    applyTunnelSessions();
    applySecureDns();

    createWindow();
    wireIpc();
    wireVaultIpc();
    Menu.setApplicationMenu(buildAppMenu({ tabs, actions, settings }));

    tabs.create(settings.get('browser.homepage', 'veil://home/'));
    relayout();
    startVpnPolling();

    // On by default: bring the tunnel up as soon as the window exists, without
    // making the user wait for it before the browser is usable.
    if (settings.get('tunnel.enabled', true) && settings.get('tunnel.provider', 'tor') !== 'off') {
      setTimeout(() => tunnel.enable().catch(() => {}), 300);
    }
    if (settings.get('vpn.autoLaunch', false)) setTimeout(() => actions.vpnLaunch(), 900);

    // Say something if this build has gone stale, and look for a newer one if
    // a release feed exists. Both are quiet when there is nothing to report.
    setTimeout(() => {
      updater.warnIfStale();
      if (settings.get('updates.checkOnStart', true)) updater.check({ silent: true }).catch(() => {});
    }, 4000);
    if (DEV) chromeView.webContents.openDevTools({ mode: 'detach' });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', async () => {
    settings.saveNow();
    if (vault) vault.lock();
    if (tunnel) await tunnel.shutdown();
    if (browseSession && settings.get('privacy.retention', 'keep') === 'none') {
      try { await browseSession.clearStorageData(); await browseSession.clearCache(); } catch {}
    }
  });

  /**
   * Proxy authentication. Deliberately scoped to `isProxy`: a site asking for
   * HTTP basic auth must never be handed the VPN credentials, so anything that
   * is not the proxy itself is left for the normal prompt.
   */
  app.on('login', (event, webContents, details, authInfo, callback) => {
    if (!authInfo || !authInfo.isProxy || !tunnel) return;
    const cred = tunnel.credentials();
    if (!cred || !cred.username) return;
    event.preventDefault();
    callback(cred.username, cred.password);
  });

  // Nothing in Veil should ever open a real Chromium window on its own.
  app.on('web-contents-created', (e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (tabs && /^https?:/i.test(url)) tabs.create(url);
      return { action: 'deny' };
    });
  });
}
