'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { shell } = require('electron');

/**
 * Integration with the Tunnel VPN app that already lives on this machine.
 *
 * Tunnel VPN owns its own elevated session (Connect raises one UAC prompt), so
 * Veil deliberately does not try to drive the tunnel itself. It launches the
 * app, reports honest status by looking at which processes are actually
 * running, and surfaces the log directory.
 */

const CTRL_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'TunnelVPN', 'ctrl');

const STATES = {
  MISSING: 'missing',        // exe not found at the configured path
  STOPPED: 'stopped',        // app not running
  RUNNING: 'running',        // app open, tunnel down
  CONNECTING: 'connecting',  // tunnel process up, openvpn not yet
  CONNECTED: 'connected'     // openvpn running
};

function tasklist() {
  return new Promise(resolve => {
    execFile('tasklist', ['/NH', '/FO', 'CSV'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
      const ps = await tasklist();
      const has = name => ps.includes(name);
      const app = has('tunnelvpn.exe');
      const ovpn = has('openvpn.exe');
      const wst = has('wstunnel.exe');

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
      const child = spawn(exe, [], {
        cwd: path.dirname(exe),
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
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
