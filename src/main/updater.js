'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, net, shell } = require('electron');

/**
 * Updates.
 *
 * A browser that never updates becomes the least safe program on the machine,
 * because Chromium ships security fixes roughly monthly and this one is frozen
 * at whatever Electron it was built against. So Veil does two things:
 *
 *   1. If a release feed is configured, it checks it and can download and
 *      install a new build (electron-updater, loaded only if present).
 *   2. Whether or not that is configured, it always knows how old its own
 *      Chromium is and says so plainly, because "no update server" must not
 *      silently become "no idea I am out of date".
 *
 * Nothing is ever installed without the user agreeing to it.
 */

// Roughly how often upstream Chromium ships security fixes.
const STALE_DAYS = 45;
const VERY_STALE_DAYS = 90;

// Anything older than this is a bad timestamp, not a real build date.
// Electron's own zip carries 1980 mtimes, which would otherwise read as
// "built 17000 days ago".
const EARLIEST_PLAUSIBLE = Date.parse('2020-01-01');

function plausible(date) {
  return date && date.getTime() > EARLIEST_PLAUSIBLE && date.getTime() <= Date.now() + 86400000
    ? date : null;
}

function buildDate() {
  // Written by scripts/stamp-build.js when the app is packaged.
  try {
    const stamped = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'build-info.json'), 'utf8'));
    const d = plausible(new Date(stamped.builtAt));
    if (d) return d;
  } catch {}

  // Running from source: the manifest's own timestamp is close enough.
  try {
    const d = plausible(fs.statSync(path.join(__dirname, '..', '..', 'package.json')).mtime);
    if (d) return d;
  } catch {}

  return null;
}

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

class Updater {
  constructor(settings, onStatus) {
    this.settings = settings;
    this.onStatus = onStatus || (() => {});
    this.state = 'idle';        // idle | checking | available | downloading | ready | current | error | unconfigured
    this.detail = '';
    this.progress = 0;
    this.available = null;      // { version, notes, url }
    this.autoUpdater = null;
  }

  /** electron-updater is optional; a source checkout will not have it. */
  load() {
    if (this.autoUpdater) return this.autoUpdater;
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;             // never download unasked
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on('update-available', (info) => {
        this.available = { version: info.version, notes: String(info.releaseNotes || '').slice(0, 2000) };
        this.set('available', 'Version ' + info.version + ' is available');
      });
      autoUpdater.on('update-not-available', () => this.set('current', 'You are on the newest build'));
      autoUpdater.on('download-progress', (p) => {
        this.progress = Math.round(p.percent || 0);
        this.set('downloading', 'Downloading ' + this.progress + '%');
      });
      autoUpdater.on('update-downloaded', () => this.set('ready', 'Ready to install - restart to finish'));
      autoUpdater.on('error', (e) => this.set('error', String((e && e.message) || e).slice(0, 300)));
      this.autoUpdater = autoUpdater;
      return autoUpdater;
    } catch {
      return null;
    }
  }

  set(state, detail) {
    this.state = state;
    this.detail = detail || '';
    this.onStatus(this.status());
  }

  status() {
    const built = buildDate();
    const age = daysSince(built);
    return {
      state: this.state,
      detail: this.detail,
      progress: this.progress,
      available: this.available,
      current: app.getVersion(),
      chromium: process.versions.chrome,
      electron: process.versions.electron,
      builtAt: built ? built.toISOString() : null,
      ageDays: age,
      staleness: age == null ? 'unknown'
        : age >= VERY_STALE_DAYS ? 'very-stale'
        : age >= STALE_DAYS ? 'stale'
        : 'fresh',
      packaged: app.isPackaged,
      canSelfUpdate: !!this.load() && app.isPackaged && process.platform !== 'linux'
    };
  }

  async check({ silent } = {}) {
    const updater = this.load();
    if (!updater || !app.isPackaged) {
      this.set('unconfigured',
        !app.isPackaged
          ? 'Running from source - update it with git and npm'
          : 'No release feed is configured for this build');
      return this.status();
    }
    // Linux has no update feed. electron-updater can only replace an AppImage,
    // and a .deb install is the one worth recommending on Ubuntu - so rather
    // than let it fail with something about a missing AppImage path, this says
    // what is actually true.
    if (process.platform === 'linux') {
      this.set('unconfigured',
        'Veil cannot update itself on Linux - download the new version from the releases page');
      return this.status();
    }
    try {
      this.set('checking', 'Checking for a newer build');
      await updater.checkForUpdates();
    } catch (e) {
      this.set('error', String((e && e.message) || e).slice(0, 300));
    }
    return this.status();
  }

  async download() {
    const updater = this.load();
    if (!updater) return this.status();
    try {
      this.set('downloading', 'Starting download');
      await updater.downloadUpdate();
    } catch (e) {
      this.set('error', String((e && e.message) || e).slice(0, 300));
    }
    return this.status();
  }

  install() {
    const updater = this.load();
    if (!updater || this.state !== 'ready') return false;
    updater.quitAndInstall(false, true);
    return true;
  }

  /**
   * The fallback that matters when there is no release feed: tell the user how
   * old their Chromium is, once, rather than letting it rot quietly.
   */
  warnIfStale() {
    const s = this.status();
    if (s.staleness === 'stale' || s.staleness === 'very-stale') {
      this.onStatus(Object.assign({}, s, { warn: true }));
    }
    return s;
  }
}

module.exports = { Updater, STALE_DAYS, VERY_STALE_DAYS };
