'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { shell } = require('electron');
const { MAC, VPN_CTRL_DIR, VPN_PROCESS_MARKS, PROCESS_LIST_CMD } = require('./platform');

/**
 * Integration with the Tunnel VPN app that already lives on this machine.
 *
 * Tunnel VPN owns its own elevated session (Connect raises one prompt - UAC on
 * Windows, an administrator password on macOS), so Veil deliberately does not
 * try to drive the tunnel itself. It launches the app, reports honest status
 * by looking at which processes are actually running, and surfaces the log
 * directory.
 *
 * Both builds of Tunnel VPN behave the same way from here: a supervisor holds
 * the elevated session, writes session.log, and watches for a stop-file. Only
 * the paths and the process names differ, and those live in ./platform.
 */

const CTRL_DIR = VPN_CTRL_DIR;

const STATES = {
  MISSING: 'missing',        // exe not found at the configured path
  STOPPED: 'stopped',        // app not running
  RUNNING: 'running',        // app open, tunnel down
  CONNECTING: 'connecting',  // tunnel process up, openvpn not yet
  CONNECTED: 'connected'     // openvpn running
};

/** Everything currently running, lower-cased, as one blob to search. */
function processList() {
  const [exe, args] = PROCESS_LIST_CMD;
  return new Promise(resolve => {
    execFile(exe, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout).toLowerCase()));
  });
}

class Vpn {
  constructor(settings) {
    this.settings = settings;
    this.last = { state: STATES.STOPPED, detail: '', at: 0 };
    this._checking = null;
  }

  exePath() {
    return this.settings.get('vpn.exePath', '') || '';
  }

  installed() {
    const p = this.exePath();
    try { return !!p && fs.existsSync(p); } catch { return false; }
  }

  /** Last meaningful line the VPN wrote, for the tooltip. */
  logTail() {
    try {
      const f = path.join(CTRL_DIR, 'session.log');
      const raw = fs.readFileSync(f, 'utf8');
      const lines = raw.trim().split(/\r?\n/).filter(Boolean);
      return lines.length ? lines[lines.length - 1].slice(0, 160) : '';
    } catch { return ''; }
  }

  async status() {
    if (this._checking) return this._checking;
    this._checking = (async () => {
      if (!this.installed()) {
        this.last = { state: STATES.MISSING, detail: 'Tunnel VPN not found at the configured path', at: Date.now() };
        return this.last;
      }
      const ps = await processList();
      const has = name => ps.includes(name);
      const app = has(VPN_PROCESS_MARKS.app);
      const ovpn = has(VPN_PROCESS_MARKS.openvpn);
      const wst = has(VPN_PROCESS_MARKS.wstunnel);

      let state = STATES.STOPPED;
      if (ovpn) state = STATES.CONNECTED;
      else if (wst) state = STATES.CONNECTING;
      else if (app) state = STATES.RUNNING;

      this.last = {
        state,
        detail: this.logTail(),
        appRunning: app,
        tunnel: wst,
        openvpn: ovpn,
        at: Date.now()
      };
      return this.last;
    })().finally(() => { this._checking = null; });
    return this._checking;
  }

  /** Bring the Tunnel VPN window up; it handles its own elevation on Connect. */
  async launch() {
    if (!this.installed()) {
      return { ok: false, error: 'Tunnel VPN was not found. Set its path in Settings > VPN.' };
    }
    const exe = this.exePath();
    try {
      // On macOS the path names an .app bundle, which is a directory: it has
      // to be handed to `open` rather than executed. `open` also brings an
      // already-running copy to the front, which is what the user means by
      // clicking this a second time.
      const child = MAC
        ? spawn('open', ['-a', exe], { detached: true, stdio: 'ignore' })
        : spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  openLogs() {
    try {
      fs.mkdirSync(CTRL_DIR, { recursive: true });
      shell.openPath(CTRL_DIR);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
}

module.exports = { Vpn, STATES, CTRL_DIR };
