/**
 * uBlock Origin, running inside Veil.
 *
 * Veil has its own filter engine, and it is a good one for what it is: it
 * reads the same lists, blocks by the same rules, and collapses the same empty
 * boxes. What it does not have is the part of uBlock that is not a list at all
 * - the scriptlets, and the people who rewrite them every time YouTube changes
 * how it delivers an advert. That is a moving target, and keeping up with it
 * by hand is not work this browser can win. So uBlock is loaded as it is, and
 * its own maintainers keep it current.
 *
 * uBlock is written against a full Chrome. The differences that stops it
 * working in Electron are patched in assets/ubo/js/veil-chrome.js, which is
 * the whole of the fork besides one import line in each of two files. The
 * biggest of those differences is here rather than there, because it needs the
 * main process: Electron fires no tab events and reports tabId -1 on every
 * request, so uBlock is never told a page has loaded and never builds the
 * per-page state it answers content scripts from. Veil knows, and tells it -
 * see `navigated` below.
 *
 * uBlock Origin is GPLv3. Its source ships with this application, unmodified
 * except as described above, and the patch carries the same licence.
 * Home: https://github.com/gorhill/uBlock
 */

const path = require('node:path');
const { webContents } = require('electron');

/*
 * Chromium loads an extension from real files, and a packaged Veil lives
 * inside app.asar, which is an archive rather than a directory. So assets/ubo
 * is listed in `asarUnpack` and sits beside the archive instead of in it -
 * this rewrites the path to match. In a checkout there is no archive and the
 * replace does nothing.
 */
const DIR = path.join(__dirname, '..', '..', 'assets', 'ubo')
  .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

/**
 * The one rule uBlock's own lists cannot apply here.
 *
 * Clicking a video inside YouTube fetches /youtubei/v1/get_watch rather than
 * /player, and uBlock strips the advert data out of that response with
 * `$replace=` filters - which need webRequest.filterResponseData, which only
 * Firefox has. Its Chromium stand-in is a scriptlet covering "adSlots" alone,
 * and the one that would cover "adPlacements" ships commented out. So on
 * Chromium, and therefore in Chrome as much as in Veil, the video you click
 * through to still arrives with its advert breaks scheduled.
 *
 * This is that commented-out line, verbatim, enabled. Measured over three
 * videos reached by clicking: adPlacements present on two of three without it,
 * on none of three with it.
 */
const GET_WATCH_RULE = [
  '! Added by Veil: uBlock ships this line commented out, and without it a',
  '! video clicked inside YouTube still carries its advert breaks.',
  'www.youtube.com##+js(json-prune-fetch-response, ' +
    'playerAds adPlacements adSlots no_ads ' +
    'playerResponse.playerAds playerResponse.adPlacements playerResponse.adSlots ' +
    'playerResponse.no_ads ' +
    '[].playerResponse.adPlacements [].playerResponse.playerAds ' +
    '[].playerResponse.adSlots [].playerResponse.no_ads, , ' +
    'propsToMatch, /player\\?|get_watch|^\\W+$/)'
].join('\n');

const MARKER = 'Added by Veil';

class UBlockOrigin {
  constructor(settings) {
    this.settings = settings;
    this.extension = null;
    this.background = null;
    this.failure = '';
  }

  /** Loaded and answering. */
  get active() {
    return this.background !== null && !this.background.isDestroyed();
  }

  /**
   * Load it into a session.
   *
   * Electron refuses to load an extension into a session that is not on disk,
   * so a private profile goes without. Veil's own engine still runs there.
   */
  async load(session) {
    if (this.settings.get('adblock.ubo', true) !== true) return false;

    // "Forget everything on exit" is a RAM-only profile, and Chromium will not
    // load an extension into one. Say so rather than throwing at the user.
    if (typeof session.isPersistent === 'function' && session.isPersistent() === false) {
      this.failure = 'needs an on-disk profile';
      console.log('[ubo] not loaded: the profile is set to forget everything on exit');
      return false;
    }

    try {
      this.extension = await session.extensions.loadExtension(DIR, { allowFileAccess: true });
    } catch (e) {
      this.failure = e.message;
      console.error('[ubo] could not load:', e.message);
      return false;
    }

    // The background page is not up the moment loadExtension resolves; it is
    // spawned after, and everything Veil says to uBlock is said through it.
    this.background = await this.findBackground();

    if (this.background === null) {
      this.failure = 'no background page';
      console.error('[ubo] loaded but never got a background page');
      return false;
    }

    this.ensureRule().catch(() => {});
    return true;
  }

  /** Wait for the extension's background page to appear. */
  async findBackground(tries = 40) {
    const prefix = 'chrome-extension://' + this.extension.id;
    for (let i = 0; i < tries; i++) {
      const found = webContents.getAllWebContents()
        .find(wc => !wc.isDestroyed() && wc.getURL().startsWith(prefix));
      if (found) return found;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  /**
   * Add the get_watch rule, once, when uBlock is ready to be told.
   *
   * uBlock keeps user filters in its own storage, which survives restarts, so
   * this checks before writing rather than appending the same line every time
   * Veil starts.
   */
  async ensureRule(attempt = 0) {
    if (!this.active) return;

    const ready = await this.ask('(() => { const u = self.µBlock || self.uBlock; ' +
      'return u ? u.readyToFilter === true : false; })()');

    if (ready !== true) {
      if (attempt >= 30) {                       // 30 x 2s: uBlock never came up
        console.error('[ubo] never became ready; the YouTube rule was not added');
        return;
      }
      setTimeout(() => { this.ensureRule(attempt + 1).catch(() => {}); }, 2000);
      return;
    }

    const added = await this.ask(`(async () => {
      const u = self.µBlock || self.uBlock;
      if (!u || typeof u.createUserFilters !== 'function') { return 'no api'; }
      try {
        const current = await u.loadUserFilters();
        const text = (current && current.content) || '';
        if (text.includes(${JSON.stringify(MARKER)})) { return 'already there'; }
        u.createUserFilters({ filters: ${JSON.stringify(GET_WATCH_RULE)} });
        return 'added';
      } catch (e) { return 'threw ' + String(e && e.message || e); }
    })()`);

    if (added !== 'added' && added !== 'already there') {
      console.error('[ubo] the YouTube rule was not added:', added);
    }
  }

  /**
   * Tell uBlock a page is loading.
   *
   * This is the event Electron does not have. uBlock creates its page store
   * from a main frame commit, and answers a content script's request for
   * cosmetic filters and scriptlets only once that store exists - so without
   * this, uBlock loads every list and filters nothing on the page itself.
   *
   * An extension tab id is the id of its webContents, which is what makes this
   * possible to say from here at all.
   */
  navigated(tabId, url) {
    if (!this.active) return;
    if (typeof tabId !== 'number' || tabId < 0) return;
    if (/^(https?|file|ftp):/.test(String(url || '')) === false) return;
    this.background.executeJavaScript(
      `typeof veilNavigation === 'function' && veilNavigation(${tabId}, 0, ${JSON.stringify(url)})`
    ).catch(() => {});
  }

  /** Run something in the background page and get its value back. */
  ask(code) {
    if (!this.active) return Promise.resolve(null);
    return this.background.executeJavaScript(code).catch(() => null);
  }

  /** For the settings panel and the about box. */
  stats() {
    return {
      loaded: this.active,
      version: this.extension ? this.extension.version : '',
      failure: this.failure
    };
  }
}

module.exports = { UBlockOrigin, DIR };
