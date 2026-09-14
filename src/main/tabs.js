'use strict';
const path = require('node:path');
const { WebContentsView } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'page.js');

let nextId = 1;

/**
 * Owns every page view. The chrome UI is a separate view pinned to the top of
 * the window; each tab is a WebContentsView positioned underneath it, and only
 * the active one is visible.
 */
class TabManager {
  constructor(opts) {
    this.win = opts.win;
    this.settings = opts.settings;
    this.session = opts.session;
    // How much of the window the chrome occupies: a strip on top, and in
    // vertical-tab mode a rail down the left as well.
    this.inset = opts.inset || { top: 0, left: 0 };
    this.peekBase = null;      // see contentBounds()
    this.onUpdate = opts.onUpdate || (() => {});
    this.onContextMenu = opts.onContextMenu || (() => {});
    this.onUpgradeFailed = opts.onUpgradeFailed || (() => null);
    this.onDownload = opts.onDownload || (() => {});
    this.onFindResult = opts.onFindResult || (() => {});
    this.blockedCount = opts.blockedCount || (() => 0);
    this.resetBlocked = opts.resetBlocked || (() => {});
    // Told a main frame is on its way, before the document is parsed. uBlock
    // needs this: Electron has no navigation event of its own to give it.
    this.onNavigate = opts.onNavigate || (() => {});

    this.tabs = new Map();     // id -> tab
    this.order = [];           // tab ids, left to right
    this.activeId = null;
    this.closedStack = [];     // in-memory only, cleared on quit
    this.closing = false;      // true once the window is going away
  }

  /**
   * The webContents of a tab, or null if it no longer has one.
   *
   * A page can end its own view: `window.close()` from a popup does it, which
   * is exactly how Google's sign-in flow finishes. Electron then leaves
   * `view.webContents` undefined, and every later read of it - redrawing the
   * tab strip, answering an IPC message - threw
   * `Cannot read properties of undefined (reading 'id')` until the browser had
   * thrown a dialog for each one. Nothing reaches into `view.webContents`
   * directly any more; it comes through here.
   */
  static contentsOf(tab) {
    if (!tab || !tab.view) return null;
    const wc = tab.view.webContents;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  }

  /** The webContents of a tab by id, or null. */
  contents(id) { return TabManager.contentsOf(this.tabs.get(id)); }

  get(id) { return this.tabs.get(id); }
  active() { return this.tabs.get(this.activeId); }
  activeContents() { return TabManager.contentsOf(this.active()); }

  /** The site a URL belongs to, as zoom and mute are both remembered by site. */
  static siteOf(url) {
    try {
      const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return h || '';
    } catch { return ''; }
  }

  /** Put back whatever zoom this site was last read at. */
  applyZoom(wc) {
    if (!wc || wc.isDestroyed()) return;
    const site = TabManager.siteOf(wc.getURL());
    const saved = site ? this.settings.get('browser.zoomSites', {})[site] : null;
    const factor = Number(saved) || Number(this.settings.get('browser.defaultZoom', 1)) || 1;
    try { wc.setZoomFactor(factor); } catch {}
  }

  /**
   * Remember the zoom for the site in this tab.
   *
   * A factor equal to the default is removed rather than written, so the file
   * does not fill up with every site you ever pressed Ctrl+0 on.
   */
  rememberZoom(wc, factor) {
    const site = TabManager.siteOf(wc.getURL());
    if (!site) return;
    const sites = Object.assign({}, this.settings.get('browser.zoomSites', {}));
    const base = Number(this.settings.get('browser.defaultZoom', 1)) || 1;
    if (Math.abs(factor - base) < 0.01) delete sites[site];
    else sites[site] = factor;
    // set, not update: update merges, so a site removed here would come back.
    this.settings.set('browser.zoomSites', sites);
  }

  /** Silence a tab, or let it speak again. */
  toggleMute(id) {
    const tab = this.tabs.get(id != null ? id : this.activeId);
    const wc = TabManager.contentsOf(tab);
    if (!wc) return false;
    tab.muted = !wc.isAudioMuted();
    wc.setAudioMuted(tab.muted);
    this.emit();
    return tab.muted;
  }

  /** Top-level URL for a given webContents id — used by the privacy layer. */
  topUrlFor(wcId) {
    for (const t of this.tabs.values()) {
      const wc = TabManager.contentsOf(t);
      if (wc && wc.id === wcId) return t.url;
    }
    return '';
  }

  /**
   * Where the page sits.
   *
   * `peekBase` is what makes the chrome's hover animations smooth. Resizing a
   * WebContentsView relayouts the entire document inside it, and doing that on
   * every frame of an animation is what turns a short slide into a stutter.
   * So while anything is sliding - the tab rail opening, or the whole chrome
   * coming back from hiding - the page keeps the size it had in the resting
   * state and only its x and y move: a translation repaints, it does not
   * reflow. It overhangs the window by however far the chrome has opened,
   * which nobody notices for the moment a pointer rests there, and it is sized
   * properly again the moment things settle back.
   */
  contentBounds() {
    const [w, h] = this.win.getContentSize();
    const { top, left } = this.inset;
    const base = this.peekBase;
    const widthFrom = (base && base.left != null) ? base.left : left;
    const heightFrom = (base && base.top != null) ? base.top : top;
    return {
      x: left,
      y: top,
      width: Math.max(0, w - widthFrom),
      height: Math.max(0, h - heightFrom)
    };
  }

  /** The colour a view should paint before its document has loaded. */
  baseColour() {
    const { baseBackground } = require('./settings');
    return baseBackground((this.settings && this.settings.get('appearance', {})) || {});
  }

  layout() {
    const b = this.contentBounds();
    const t = this.active();
    if (t) t.view.setBounds(b);
  }

  /**
   * A new tab goes at the end of the list.
   *
   * Chromium opens a tab next to its parent, which suits a tab strip that
   * grows sideways. A vertical list is read top to bottom, and having new
   * tabs appear in the middle of it loses your place - so every tab now goes
   * on the end, links from a page included. The old behaviour is still here
   * behind `insertAfterActive` for any caller that wants it.
   */
  create(url, { background = false, insertAfterActive = false } = {}) {
    const id = nextId++;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        enableWebSQL: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        backgroundThrottling: true,
        /* Chromium's own PDF viewer. `plugins` reads like a hole and is not
           one any more: NPAPI and PPAPI are long gone from Chromium, and the
           flag now gates the built-in PDF reader and nothing else. Without it
           a PDF link downloads instead of opening, which is the one thing
           people expect a browser to do with a PDF. */
        plugins: this.settings.get('browser.openPdf', true) !== false
      }
    });

    // Chromium paints a new view white until the document says otherwise,
    // which reads as a frame of flash when a tab opens over a dark UI. The
    // view is told the theme's own colour up front so there is nothing to see.
    try { view.setBackgroundColor(this.baseColour()); } catch {}

    const wc = view.webContents;
    const tab = {
      id, view,
      url: url || 'veil://home/',
      title: 'New tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      favicon: '',
      failed: null,
      muted: false,
      audible: false
    };

    this.tabs.set(id, tab);
    const at = insertAfterActive && this.activeId != null
      ? this.order.indexOf(this.activeId) + 1
      : this.order.length;
    this.order.splice(at, 0, id);

    this.win.contentView.addChildView(view);
    view.setBounds(this.contentBounds());
    view.setVisible(false);

    this.wire(tab);

    if (this.settings.get('privacy.blockWebRTCLeak', true)) {
      try { wc.setWebRTCIPHandlingPolicy('default_public_interface_only'); } catch {}
    }
    const zoom = Number(this.settings.get('browser.defaultZoom', 1)) || 1;
    wc.setZoomFactor(zoom);

    wc.loadURL(tab.url).catch(() => {});

    if (!background || this.activeId == null) this.select(id);
    else this.emit();
    return id;
  }

  wire(tab) {
    const wc = tab.view.webContents;
    const push = () => {
      tab.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack();
      tab.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward();
      this.emit();
    };

    wc.on('page-title-updated', (e, title) => {
      e.preventDefault();
      tab.title = title || tab.title;
      this.emit();
    });
    wc.on('did-start-loading', () => { tab.loading = true; tab.failed = null; this.emit(); });
    wc.on('did-stop-loading', () => { tab.loading = false; push(); });
    wc.on('did-start-navigation', (e) => {
      if (!e.isMainFrame) return;
      if (e.isSameDocument !== true) this.onNavigate(wc.id, e.url);
      this.resetBlocked(wc.id);
      // Drop the old site's icon straight away rather than showing it against
      // the new one's title for however long the next page takes to load.
      if (tab.favicon) { tab.favicon = ''; this.emit(); }
    });

    /* Something started making noise, or stopped. Watched so the tab can say
       so, and so the mute button has a reason to appear. */
    wc.on('media-started-playing', () => {
      const audible = wc.isCurrentlyAudible();
      if (audible === tab.audible) return;
      tab.audible = audible;
      this.emit();
    });
    wc.on('media-paused', () => {
      // isCurrentlyAudible is still true for a moment after the pause.
      setTimeout(() => {
        if (wc.isDestroyed()) return;
        const audible = wc.isCurrentlyAudible();
        if (audible === tab.audible) return;
        tab.audible = audible;
        this.emit();
      }, 250);
    });

    /* Zoom, put back for the site you are returning to.
       Chromium keeps a zoom level per origin but only for as long as the
       session lives, so a site you always read at 125% is back at 100% after
       a restart. The factor is applied on commit rather than on load finishing,
       so the page is never painted at the wrong size first. */
    wc.on('did-navigate', () => this.applyZoom(wc));
    wc.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) this.applyZoom(wc); });

    wc.on('page-favicon-updated', (e, icons) => {
      const next = (Array.isArray(icons) ? icons : []).find(u => /^https?:/i.test(u)) || '';
      if (next === tab.favicon) return;
      tab.favicon = next;
      this.emit();
    });
    wc.on('did-navigate', (e, url) => { tab.url = url; push(); });
    wc.on('did-navigate-in-page', (e, url, isMain) => { if (isMain) { tab.url = url; push(); } });

    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;                 // -3 = user aborted
      if (url.startsWith('veil://')) return;                   // never loop on our own pages

      // An address Veil upgraded to https that will not load that way. Never
      // drop back to plaintext on its own - say so and let the user decide.
      if (url.startsWith('https://')) {
        const original = this.onUpgradeFailed(url);
        if (original) {
          tab.loading = false;
          wc.loadURL('veil://insecure/?url=' + encodeURIComponent(original) +
                     '&code=' + encodeURIComponent(code)).catch(() => {});
          this.emit();
          return;
        }
      }
      tab.failed = { code, desc, url };
      tab.loading = false;
      wc.loadURL('veil://error/?url=' + encodeURIComponent(url) +
                 '&code=' + encodeURIComponent(code) +
                 '&desc=' + encodeURIComponent(desc || '')).catch(() => {});
      this.emit();
    });

    // The page ended its own view - a popup calling window.close(), most often.
    wc.on('destroyed', () => this.gone(tab.id));

    wc.on('render-process-gone', () => {
      tab.loading = false;
      tab.title = 'Page crashed';
      this.emit();
    });

    wc.setWindowOpenHandler(({ url }) => {
      if (/^(https?|veil):/i.test(url)) this.create(url, { background: false });
      return { action: 'deny' };
    });

    wc.on('context-menu', (e, params) => this.onContextMenu(tab, params));
    wc.on('found-in-page', (e, r) => this.onFindResult({ active: r.activeMatchOrdinal, total: r.matches }));
  }

  select(id) {
    if (!this.tabs.has(id)) return;
    const prev = this.active();
    if (prev && prev.id !== id) prev.view.setVisible(false);
    this.activeId = id;
    const t = this.active();
    if (!t) return;
    t.view.setBounds(this.contentBounds());
    t.view.setVisible(true);
    this.win.contentView.addChildView(t.view);     // keep above the chrome strip
    const wc = TabManager.contentsOf(t);
    if (wc) wc.focus();
    this.emit();
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);

    if (tab.url && !tab.url.startsWith('veil://')) {
      this.closedStack.push(tab.url);
      if (this.closedStack.length > 15) this.closedStack.shift();
    }

    try {
      this.win.contentView.removeChildView(tab.view);
      const wc = TabManager.contentsOf(tab);
      if (wc) wc.close();
    } catch {}

    this.afterRemoved(id, idx);
  }

  /**
   * A tab whose page ended itself.
   *
   * `window.close()` from a popup destroys the view without anything here
   * being asked to close it - Google's sign-in window does precisely that when
   * it is finished. The entry has to go the same way it would have on a close,
   * or the strip keeps drawing a tab whose contents no longer exist.
   */
  gone(id) {
    // On the way out every view is destroyed at once, and replacing them as
    // they go would open a new tab during shutdown.
    if (this.closing) return;
    if (!this.tabs.has(id)) return;
    const idx = this.order.indexOf(id);
    if (idx !== -1) this.order.splice(idx, 1);
    this.tabs.delete(id);
    this.afterRemoved(id, idx === -1 ? 0 : idx);
  }

  /** Pick what to show once a tab has left, and say so. */
  afterRemoved(id, idx) {
    if (this.activeId !== id) { this.emit(); return; }
    this.activeId = null;
    const next = this.order[Math.min(idx, this.order.length - 1)];
    if (next != null) this.select(next);
    else this.create(this.settings.get('browser.newTabPage', 'veil://home/'));
  }

  reopenClosed() {
    const url = this.closedStack.pop();
    if (url) this.create(url);
  }

  move(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(this.order.length, toIndex)), 0, id);
    this.emit();
  }

  cycle(delta) {
    if (this.order.length < 2) return;
    const i = this.order.indexOf(this.activeId);
    const next = (i + delta + this.order.length) % this.order.length;
    this.select(this.order[next]);
  }

  navigate(url) {
    const wc = this.activeContents();
    if (wc) wc.loadURL(url).catch(() => {});
  }

  /** Serialisable state for the chrome UI. */
  state() {
    return {
      activeId: this.activeId,
      tabs: this.order.map(id => {
        const t = this.tabs.get(id);
        if (!t) return null;
        const wc = TabManager.contentsOf(t);
        return {
          id: t.id,
          title: t.title,
          url: t.url,
          favicon: t.favicon,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          blocked: wc ? this.blockedCount(wc.id) : 0,
          zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
          muted: t.muted,
          audible: t.audible
        };
      }).filter(Boolean)
    };
  }

  emit() { this.onUpdate(this.state()); }

  destroyAll() {
    this.closing = true;
    for (const t of this.tabs.values()) {
      try {
        const wc = TabManager.contentsOf(t);
        if (wc) wc.close();
      } catch {}
    }
    this.tabs.clear();
    this.order = [];
  }
}

module.exports = { TabManager };
