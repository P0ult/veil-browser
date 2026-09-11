'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net_ = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { app, net, safeStorage } = require('electron');
const { SocksRelay } = require('./socks-relay');
const { MAC, WINDOWS, firstExisting, wstunnelCandidates, TOR_BUNDLE_PLATFORM, TOR_BINARY } = require('./platform');

/**
 * The in-browser tunnel.
 *
 * A system VPN needs a virtual network adapter and route-table edits, which
 * need Administrator. Veil runs unelevated, so instead of pretending, it
 * tunnels at the layer it genuinely controls: every request the browsing
 * session makes goes through a proxy. That covers all browser traffic without a
 * driver, a UAC prompt, or anything for you to launch.
 *
 * Providers:
 *   tor    - Veil fetches, verifies and runs Tor itself; nothing to configure
 *   socks  - your own SOCKS5 endpoint (Mullvad, Proton, IVPN, self-hosted)
 *   http   - your own HTTP/HTTPS proxy, with optional credentials
 *   off    - direct
 */

const STATE = {
  OFF: 'off',
  DOWNLOADING: 'downloading',
  STARTING: 'starting',
  BOOTSTRAPPING: 'bootstrapping',
  ON: 'on',
  ERROR: 'error',
  BLOCKED: 'blocked'        // kill-switch engaged: an established tunnel dropped
};

// Where Tor publishes builds. Kept explicit so it is obvious what Veil talks to.
const TOR_VERSION_URL = 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json';
const TOR_ARCHIVE_BASE = 'https://archive.torproject.org/tor-package-archive/torbrowser';
const TOR_FALLBACK_VERSION = '14.5.1';

// Blank setting means "look wherever this platform usually keeps it". The
// macOS Tunnel VPN installs wstunnel with Homebrew; the Windows build ships it
// beside the app.
const DEFAULT_WSTUNNEL = firstExisting(wstunnelCandidates()) || wstunnelCandidates()[0] || '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net_.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function fetchBuffer(url, ms = 60000) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  try {
    const res = await net.fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Veil/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}

class Tunnel {
  /**
   * @param {object} settings
   * @param {Function} onUpdate called with the public status whenever it changes
   */
  constructor(settings, onUpdate, vpn) {
    this.settings = settings;
    this.onUpdate = onUpdate || (() => {});
    this.vpn = vpn || null;          // the system Tunnel VPN app, when present
    this.sessions = [];
    this.state = STATE.OFF;
    this.detail = '';
    this.progress = 0;
    this.socksPort = 0;
    this.proc = null;
    this.established = false;   // the tunnel reached "on" at least once this run
    this.stopping = false;
    this.dir = path.join(app.getPath('userData'), 'tor');
    this.credFile = path.join(app.getPath('userData'), 'proxy.cred');
    this.relay = null;
    this.exit = null;          // { ip, loc } once verified through the tunnel
  }

  /* ------------------------------------------------------- credentials
     Proxy logins never go into settings.json. They are sealed with the OS
     keystore, the same way the password vault's quick-unlock key is.        */

  hasCredentials() { try { return fs.existsSync(this.credFile); } catch { return false; } }

  credentials() {
    try {
      if (!fs.existsSync(this.credFile)) return null;
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(this.credFile)));
    } catch { return null; }
  }

  setCredentials(username, password) {
    if (!username && !password) return this.clearCredentials();
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The OS keystore is unavailable');
    fs.writeFileSync(this.credFile,
      safeStorage.encryptString(JSON.stringify({ username: username || '', password: password || '' })));
    return true;
  }

  clearCredentials() {
    try { fs.unlinkSync(this.credFile); } catch {}
    return true;
  }

  attach(sessions) { this.sessions = sessions.filter(Boolean); }

  status() {
    return {
      state: this.state,
      detail: this.detail,
      progress: this.progress,
      provider: this.settings.get('tunnel.provider', 'tor'),
      enabled: !!this.settings.get('tunnel.enabled', true),
      port: this.socksPort,
      hasCredentials: this.hasCredentials(),
      exit: this.exit
    };
  }

  set(state, detail = '', progress = this.progress) {
    this.state = state;
    this.detail = detail;
    this.progress = progress;
    this.onUpdate(this.status());
  }

  /* ------------------------------------------------------------ proxying */

  async applyProxy(rules) {
    for (const ses of this.sessions) {
      try {
        // No rules means "off": back to whatever the user's proxy setting
        // says, which is direct unless they asked for the system's.
        const off = this.settings.get('tunnel.systemProxy', false) ? { mode: 'system' } : { mode: 'direct' };
        await ses.setProxy(rules ? { proxyRules: rules, proxyBypassRules: '<local>' } : off);
        await ses.forceReloadProxyConfig();
      } catch (e) {
        console.error('[tunnel] setProxy failed:', e.message);
      }
    }
  }

  /**
   * Kill switch. Pointing at a dead local port makes every request fail rather
   * than silently falling back to the naked connection. Only ever used after a
   * tunnel that was actually up goes away - a tunnel that never started leaves
   * browsing working, because bricking a fresh install helps nobody.
   */
  async engageKillSwitch(reason) {
    if (!this.settings.get('tunnel.killSwitch', true) || !this.established) {
      await this.applyProxy(null);
      this.set(STATE.ERROR, reason);
      return;
    }
    await this.applyProxy('socks5://127.0.0.1:1');
    this.set(STATE.BLOCKED, reason + ' - traffic blocked by the kill switch');
  }

  /* --------------------------------------------------------------- entry */

  async enable() {
    const provider = this.settings.get('tunnel.provider', 'tor');
    this.stopping = false;
    try {
      if (provider === 'socks' || provider === 'http') return await this.startCustom(provider);
      if (provider === 'tor') return await this.startTor();
      if (provider === 'wstunnel') return await this.startWstunnel();
      if (provider === 'system') return await this.startSystem();
      await this.disable();
    } catch (e) {
      await this.applyProxy(null);
      this.set(STATE.ERROR, e.message);
    }
  }

  async disable() {
    this.stopping = true;
    this.established = false;
    this.exit = null;
    this.stopTor();
    this.stopWs();
    this.stopRelay();
    await this.applyProxy(null);
    this.set(STATE.OFF, '');
  }

  stopRelay() {
    if (this.relay) { this.relay.close(); this.relay = null; }
  }

  async toggle() {
    const on = this.state === STATE.ON || this.state === STATE.BOOTSTRAPPING ||
               this.state === STATE.STARTING || this.state === STATE.DOWNLOADING;
    this.settings.update({ tunnel: { enabled: !on } });
    if (on) await this.disable();
    else await this.enable();
  }

  /* ------------------------------------------------------------- custom */

  async startCustom(kind) {
    const host = (this.settings.get('tunnel.host', '') || '').trim();
    const port = Number(this.settings.get('tunnel.port', 0)) || 0;
    if (!host || !port) throw new Error('Set the proxy host and port in Settings > Tunnel');

    const cred = this.credentials();
    this.stopRelay();
    this.set(STATE.STARTING, `Connecting to ${host}:${port}`);

    let rules;
    let label;
    if (kind === 'socks') {
      if (cred && cred.username) {
        // Chromium cannot authenticate to a SOCKS5 proxy, so Veil runs a
        // loopback relay that does the authenticating on its behalf.
        this.relay = new SocksRelay({ host, port, username: cred.username, password: cred.password });
        const local = await this.relay.listen();
        rules = 'socks5://127.0.0.1:' + local;
      } else {
        rules = `socks5://${host}:${port}`;
      }
      label = `SOCKS5 via ${host}:${port}`;
    } else {
      const scheme = this.settings.get('tunnel.tls', false) ? 'https' : 'http';
      rules = `${scheme}://${host}:${port}`;      // credentials answered by app.on('login')
      label = `${scheme.toUpperCase()} via ${host}:${port}`;
    }

    await this.applyProxy(rules);

    const ok = await this.probe();
    if (!ok) {
      this.established = false;
      this.stopRelay();
      throw new Error(
        cred ? `No answer from ${host}:${port} - check the address and credentials`
             : `No answer from ${host}:${port}`);
    }

    this.established = true;
    this.set(STATE.ON, label, 100);
    this.verifyExit(label);
  }

  /**
   * Ask the far end who it thinks we are. This is the honest answer to "am I
   * actually protected" - it goes through the tunnel, so it reveals nothing the
   * tunnel was not already carrying.
   */
  async verifyExit(label) {
    const info = await this.exitInfo();
    if (!info) return;
    this.exit = info;
    if (this.state === STATE.ON) {
      this.set(STATE.ON, (label ? label + ' · ' : '') + info.ip + (info.loc ? ' (' + info.loc + ')' : ''), 100);
    }
  }

  exitInfo() {
    const ses = this.sessions[0];
    if (!ses) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      let req;
      const timer = setTimeout(() => { try { if (req) req.abort(); } catch {} done(null); }, 12000);

      try {
        req = net.request({ url: 'https://www.cloudflare.com/cdn-cgi/trace', session: ses });
      } catch { return done(null); }

      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', () => done(null));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const ip = /^ip=(.+)$/m.exec(text);
          const loc = /^loc=(.+)$/m.exec(text);
          done(ip ? { ip: ip[1].trim(), loc: loc ? loc[1].trim() : '' } : null);
        });
      });
      req.on('error', () => done(null));
      req.end();
    });
  }

  /**
   * Confirm the proxy actually carries traffic before calling it connected.
   * net.request, not net.fetch: fetch ignores the session proxy, so it would
   * report success by going round the very thing being tested.
   */
  probe() {
    const ses = this.sessions[0];
    if (!ses) return Promise.resolve(false);

    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };

      let req;
      const timer = setTimeout(() => {
        try { if (req) req.abort(); } catch {}
        done(false);
      }, 15000);

      try {
        req = net.request({ url: 'https://example.com/', session: ses });
      } catch { return done(false); }

      req.on('response', (res) => {
        res.on('data', () => {});
        res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 400));
        res.on('error', () => done(false));
      });
      req.on('error', () => done(false));
      req.end();
    });
  }

  /* ------------------------------------------------------------- system

     The Tunnel VPN app already carries every packet on the machine, so the
     browser must not proxy on top of it. What Veil adds is a kill switch: if
     a VPN that was up goes away, browser traffic stops rather than quietly
     continuing in the clear.                                               */

  async startSystem() {
    if (!this.vpn) throw new Error('The system VPN is not available');
    await this.applyProxy(null);

    const s = await this.vpn.status();
    if (s.state === 'missing') {
      throw new Error('Tunnel VPN was not found - set its path in Settings');
    }
    if (s.state === 'connected') {
      this.established = true;
      this.set(STATE.ON, 'System VPN - the whole machine is covered', 100);
      this.verifyExit('System VPN');
    } else {
      this.established = false;
      this.set(STATE.STARTING, 'Waiting for Tunnel VPN - press Connect in its window', 0);
      // Only open its window uninvited if the user asked for that.
      if (this.settings.get('vpn.autoLaunch', false)) this.vpn.launch().catch(() => {});
    }
  }

  /** Called from the VPN poller so the pill tracks the app's real state. */
  syncSystem(s) {
    if (this.settings.get('tunnel.provider') !== 'system') return;
    if (this.state === STATE.OFF || !s) return;

    if (s.state === 'connected') {
      if (this.state !== STATE.ON) {
        this.established = true;
        this.set(STATE.ON, 'System VPN - the whole machine is covered', 100);
        this.verifyExit('System VPN');
      }
      return;
    }

    if (this.established) {
      this.exit = null;
      this.engageKillSwitch('The system VPN disconnected');
      return;
    }
    if (this.state !== STATE.STARTING) {
      this.set(STATE.STARTING, 'Waiting for Tunnel VPN - press Connect in its window', 0);
    }
  }

  /* ----------------------------------------------------------- wstunnel

     A browser-only tunnel through your own wstunnel server: no OpenVPN, no
     virtual adapter, no elevation. It needs the server to be willing to relay
     somewhere other than the OpenVPN port, which is a server-side setting.  */

  wstunnelExe() {
    const custom = (this.settings.get('tunnel.wstunnelPath', '') || '').trim();
    return custom || DEFAULT_WSTUNNEL;
  }

  /** The current endpoint, from the gist unless one is pinned in settings. */
  async wsEndpoint() {
    const pinned = (this.settings.get('tunnel.wsEndpoint', '') || '').trim();
    if (pinned) return pinned.replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '');

    const gist = (this.settings.get('tunnel.wsGistId', '') || '').trim();
    if (!gist) throw new Error('Set either an endpoint or a gist id in Settings > Tunnel');

    const buf = await fetchBuffer('https://api.github.com/gists/' + gist, 20000);
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf.toString('utf8'));
    if (!m) throw new Error('The gist did not contain a tunnel address');
    return m[0].replace(/^https:\/\//, '');
  }

  async startWstunnel() {
    const exe = this.wstunnelExe();
    if (!fs.existsSync(exe)) {
      throw new Error('wstunnel was not found. Open Tunnel VPN once so it installs, or set the path in Settings.');
    }

    this.set(STATE.STARTING, 'Looking up the tunnel address', 0);
    const host = await this.wsEndpoint();

    const local = await freePort();
    const remoteSocks = (this.settings.get('tunnel.wsRemoteSocks', '') || '').trim();
    const spec = remoteSocks
      ? 'tcp://127.0.0.1:' + local + ':' + remoteSocks
      : 'socks5://127.0.0.1:' + local;

    this.set(STATE.STARTING, 'Connecting to ' + host, 0);
    this.stopWs();

    const proc = spawn(exe, ['client', '-L', spec, 'wss://' + host], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NO_COLOR: 'true' })
    });
    this.wsProc = proc;
    this.wsRefused = false;

    const watch = (chunk) => {
      const text = String(chunk);
      // The server answers 400 to any destination outside its allowlist.
      if (/Invalid status code: 400/.test(text)) this.wsRefused = true;
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', watch);
    proc.stderr.on('data', watch);
    proc.on('error', () => {});
    proc.on('exit', () => {
      this.wsProc = null;
      if (!this.stopping) this.engageKillSwitch('wstunnel stopped');
    });

    await new Promise(r => setTimeout(r, 1500));
    if (proc.exitCode !== null) throw new Error('wstunnel exited immediately (code ' + proc.exitCode + ')');

    // Chromium cannot authenticate to SOCKS5, so a far-side SOCKS server that
    // wants a login goes through the same loopback relay the VPN providers use.
    const cred = this.credentials();
    let rules = 'socks5://127.0.0.1:' + local;
    if (remoteSocks && cred && cred.username) {
      this.relay = new SocksRelay({
        host: '127.0.0.1', port: local, username: cred.username, password: cred.password
      });
      rules = 'socks5://127.0.0.1:' + (await this.relay.listen());
    }

    await this.applyProxy(rules);

    const ok = await this.probe();
    if (!ok) {
      this.established = false;
      this.stopWs();
      this.stopRelay();
      if (this.wsRefused) {
        throw new Error(
          'Your wstunnel server refused the destination (HTTP 400). It is started with ' +
          '--restrict-to for the OpenVPN port only, so it will not relay web traffic. ' +
          'Allow a SOCKS port on the server and set it under "Server-side SOCKS".');
      }
      throw new Error('The tunnel came up but no traffic came back');
    }

    this.established = true;
    this.set(STATE.ON, 'Your VPN server via wstunnel', 100);
    this.verifyExit('Your VPN server');
  }

  stopWs() {
    if (this.wsProc) { try { this.wsProc.kill(); } catch {} this.wsProc = null; }
  }

  /* ---------------------------------------------------------------- tor */

  torExe() {
    const custom = (this.settings.get('tunnel.torPath', '') || '').trim();
    if (custom) return custom;
    return path.join(this.dir, 'tor', TOR_BINARY);
  }

  async startTor() {
    let exe = this.torExe();
    if (!fs.existsSync(exe)) {
      await this.downloadTor();
      exe = this.torExe();
      if (!fs.existsSync(exe)) throw new Error('Tor was not found after installing');
    }

    this.socksPort = await freePort();
    const dataDir = path.join(this.dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const torrc = path.join(this.dir, 'torrc');
    fs.writeFileSync(torrc, [
      'SocksPort 127.0.0.1:' + this.socksPort,
      'DataDirectory ' + dataDir,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      'Log notice stdout'
    ].join('\n'), 'utf8');

    this.set(STATE.STARTING, 'Starting Tor', 0);
    this.stopTor();

    const proc = spawn(exe, ['-f', torrc], {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.onTorOutput(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => this.onTorOutput(chunk));

    proc.on('error', (e) => {
      this.proc = null;
      this.engageKillSwitch('Tor failed to start: ' + e.message);
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopping) return;
      this.engageKillSwitch('Tor stopped (exit ' + code + ')');
    });
  }

  onTorOutput(chunk) {
    const m = /Bootstrapped (\d+)%(?:\s*\(([^)]*)\))?/.exec(chunk);
    if (!m) return;
    const pct = Number(m[1]);
    if (pct >= 100) {
      this.applyProxy('socks5://127.0.0.1:' + this.socksPort).then(() => {
        this.established = true;
        this.set(STATE.ON, 'Connected through Tor', 100);
      });
    } else {
      this.set(STATE.BOOTSTRAPPING, m[2] ? m[2].replace(/_/g, ' ') : 'Connecting', pct);
    }
  }

  stopTor() {
    if (!this.proc) return;
    try { this.proc.kill(); } catch {}
    this.proc = null;
  }

  /* ------------------------------------------------------ tor installer */

  async torVersion() {
    try {
      const buf = await fetchBuffer(TOR_VERSION_URL, 20000);
      const json = JSON.parse(buf.toString('utf8'));
      const v = json && json.version;
      if (v && /^[\d.a-z]+$/i.test(v)) return v;
    } catch {}
    return TOR_FALLBACK_VERSION;
  }

  /**
   * Fetch the official Tor expert bundle for this platform and architecture,
   * check it against the published SHA-256, and unpack it. Windows, macOS and
   * Linux all ship tar, so there is no archive dependency to add.
   */
  async downloadTor() {
    this.set(STATE.DOWNLOADING, 'Looking up the current Tor release', 0);
    const version = await this.torVersion();
    const name = `tor-expert-bundle-${TOR_BUNDLE_PLATFORM}-${version}.tar.gz`;
    const url = `${TOR_ARCHIVE_BASE}/${version}/${name}`;

    fs.mkdirSync(this.dir, { recursive: true });

    this.set(STATE.DOWNLOADING, `Downloading Tor ${version}`, 10);
    let archive;
    try {
      archive = await fetchBuffer(url, 180000);
    } catch (e) {
      throw new Error(
        'Could not reach torproject.org (' + e.message + '). ' +
        'Tor may be blocked on this network. Point Veil at an existing Tor ' +
        'binary in Settings > Tunnel, or switch the provider to your own ' +
        'SOCKS5 endpoint.'
      );
    }

    this.set(STATE.DOWNLOADING, 'Verifying the download', 70);
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    const expected = await this.publishedDigest(version, name);
    if (expected && expected !== digest) {
      throw new Error('Tor download failed its SHA-256 check and was discarded');
    }

    const tmp = path.join(this.dir, name);
    fs.writeFileSync(tmp, archive);

    this.set(STATE.DOWNLOADING, 'Unpacking', 85);
    await new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', tmp, '-C', this.dir], { windowsHide: true },
        (err) => (err ? reject(new Error('Unpacking failed: ' + err.message)) : resolve()));
    });
    try { fs.unlinkSync(tmp); } catch {}

    // tar preserves the executable bit, but the archive is not ours to trust
    // on that point and a Tor that cannot be executed fails later as a
    // confusing ENOENT rather than a permissions error.
    if (!WINDOWS) { try { fs.chmodSync(this.torExe(), 0o755); } catch {} }
  }

  /** The checksum file the Tor Project publishes beside each build. */
  async publishedDigest(version, name) {
    try {
      const buf = await fetchBuffer(`${TOR_ARCHIVE_BASE}/${version}/sha256sums-unsigned-build.txt`, 30000);
      for (const line of buf.toString('utf8').split('\n')) {
        const [hash, file] = line.trim().split(/\s+/);
        if (file && file.endsWith(name) && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
      }
    } catch {}
    return null;   // no checksum published we could read; do not block on it
  }

  /* ---------------------------------------------------------- shutdown */

  async shutdown() {
    this.stopping = true;
    this.stopTor();
    this.stopWs();
    this.stopRelay();
  }
}

module.exports = { Tunnel, STATE };
