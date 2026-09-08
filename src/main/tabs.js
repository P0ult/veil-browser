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
    this.onUpdate = opts.onUpdate || (() => {});
    this.onContextMenu = opts.onContextMenu || (() => {});
    this.onUpgradeFailed = opts.onUpgradeFailed || (() => null);
    this.onDownload = opts.onDownload || (() => {});
    this.onFindResult = opts.onFindResult || (() => {});
    this.blockedCount = opts.blockedCount || (() => 0);
    this.resetBlocked = opts.resetBlocked || (() => {});

    this.tabs = new Map();     // id -> tab
    this.order = [];           // tab ids, left to right
    this.activeId = null;
    this.closedStack = [];     // in-memory only, cleared on quit
  }

  get(id) { return this.tabs.get(id); }
  active() { return this.tabs.get(this.activeId); }
  activeContents() { const t = this.active(); return t && t.view.webContents; }

  /** Top-level URL for a given webContents id — used by the privacy layer. */
  topUrlFor(wcId) {
    for (const t of this.tabs.values()) {
      if (t.view.webContents.id === wcId) return t.url;
    }
    return '';
  }

  contentBounds() {
    const [w, h] = this.win.getContentSize();
    const { top, left } = this.inset;
    return {
      x: left,
      y: top,
      width: Math.max(0, w - left),
      height: Math.max(0, h - top)
    };
  }

  layout() {
    const b = this.contentBounds();
    const t = this.active();
    if (t) t.view.setBounds(b);
  }

  create(url, { background = false, insertAfterActive = true } = {}) {
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
        backgroundThrottling: true
      }
    });

    const wc = view.webContents;
    const tab = {
      id, view,
      url: url || 'veil://home/',
      title: 'New tab',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      failed: null
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
      if (e.isMainFrame) this.resetBlocked(wc.id);
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
    t.view.setBounds(this.contentBounds());
    t.view.setVisible(true);
    this.win.contentView.addChildView(t.view);     // keep above the chrome strip
    t.view.webContents.focus();
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
      tab.view.webContents.close();
    } catch {}

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[Math.min(idx, this.order.length - 1)];
      if (next != null) this.select(next);
      else this.create(this.settings.get('browser.newTabPage', 'veil://home/'));
    } else {
      this.emit();
    }
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
    const t = this.active();
    if (t) t.view.webContents.loadURL(url).catch(() => {});
  }

  /** Serialisable state for the chrome UI. */
  state() {
    return {
      activeId: this.activeId,
      tabs: this.order.map(id => {
        const t = this.tabs.get(id);
        if (!t) return null;
        return {
          id: t.id,
          title: t.title,
          url: t.url,
          loading: t.loading,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          blocked: this.blockedCount(t.view.webContents.id),
          zoom: Math.round(t.view.webContents.getZoomFactor() * 100)
        };
      }).filter(Boolean)
    };
  }

  emit() { this.onUpdate(this.state()); }

  destroyAll() {
    for (const t of this.tabs.values()) {
      try { t.view.webContents.close(); } catch {}
    }
    this.tabs.clear();
    this.order = [];
  }
}

module.exports = { TabManager };
