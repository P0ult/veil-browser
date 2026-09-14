'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The handful of facts that differ between Windows, macOS and Linux.
 *
 * They live together here rather than as `process.platform` checks sprinkled
 * through the modules that need them, so that adding a platform is a matter of
 * editing one file and so that it is possible to read, in one place, exactly
 * what Veil assumes about the machine it is running on.
 */

const MAC = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';
const LINUX = process.platform === 'linux';
const UNIX = MAC || LINUX;

const HOME = os.homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || HOME;
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');

/** The first of these paths that exists, or '' if none do. */
function firstExisting(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return '';
}

/* ------------------------------------------------------------ Tunnel VPN */

/**
 * Where Tunnel VPN keeps its control files - the session log Veil tails for
 * status, and the stop-file its supervisor watches. Both builds of the app
 * agree on the layout; only the root differs.
 */
const VPN_CTRL_DIR = MAC
  ? path.join(HOME, 'Library', 'Application Support', 'TunnelVPN', 'ctrl')
  : LINUX
    ? path.join(XDG_CONFIG, 'TunnelVPN', 'ctrl')
    : path.join(LOCAL_APP_DATA, 'TunnelVPN', 'ctrl');

/** Where the app itself usually ends up, most likely first. */
function vpnCandidates() {
  // Tunnel VPN is published for Windows and macOS. On Linux there is nothing
  // to find, and the settings page says so rather than hunting for a file that
  // was never built - the in-browser tunnel is the one that matters there.
  if (LINUX) return [];
  if (MAC) {
    return [
      '/Applications/Tunnel VPN.app',
      path.join(HOME, 'Applications', 'Tunnel VPN.app'),
      path.join(HOME, 'Downloads', 'Tunnel VPN.app')
    ];
  }
  return [
    path.join(HOME, 'Downloads', 'TunnelVPN-win', 'Tunnel VPN', 'TunnelVPN.exe'),
    path.join(HOME, 'Downloads', 'Tunnel VPN', 'TunnelVPN.exe'),
    path.join(LOCAL_APP_DATA, 'TunnelVPN', 'TunnelVPN.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tunnel VPN', 'TunnelVPN.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tunnel VPN', 'TunnelVPN.exe')
  ];
}

/**
 * How to recognise the VPN's processes in a process listing.
 *
 * On Windows these are image names as `tasklist` prints them. On macOS they
 * are fragments of the full command line as `ps -Axo command=` prints it,
 * which is why they carry their arguments: `openvpn` on its own would also
 * match an unrelated `man openvpn`, whereas the supervisor always launches it
 * as `openvpn --config`.
 */
const VPN_PROCESS_MARKS = MAC
  ? { app: 'tunnelvpn.app/contents/macos/tunnelvpn', openvpn: 'openvpn --config', wstunnel: 'wstunnel client' }
  : LINUX
    ? { app: 'tunnelvpn', openvpn: 'openvpn --config', wstunnel: 'wstunnel client' }
    : { app: 'tunnelvpn.exe', openvpn: 'openvpn.exe', wstunnel: 'wstunnel.exe' };

/** The command that lists running processes, as [exe, args]. */
const PROCESS_LIST_CMD = UNIX
  ? ['ps', ['-Axo', 'command=']]
  : ['tasklist', ['/NH', '/FO', 'CSV']];

/* ------------------------------------------------------------------ Tor */

/**
 * The Tor Project publishes one expert bundle per platform and architecture.
 * Apple Silicon takes the aarch64 build; Rosetta is not worth relying on for
 * something that has to open sockets reliably.
 */
const TOR_BUNDLE_PLATFORM = MAC
  ? 'macos-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64')
  : LINUX
    ? 'linux-' + (process.arch === 'arm64' ? 'aarch64' : 'x86_64')
    : 'windows-x86_64';

const TOR_BINARY = WINDOWS ? 'tor.exe' : 'tor';

/* ------------------------------------------------------------- wstunnel */

/**
 * Where to look for wstunnel when the setting is blank. The macOS Tunnel VPN
 * installs it with Homebrew, whose prefix differs between Apple Silicon and
 * Intel; the Windows build ships it beside the app.
 */
function wstunnelCandidates() {
  if (MAC) {
    return ['/opt/homebrew/bin/wstunnel', '/usr/local/bin/wstunnel',
            path.join(HOME, '.local', 'bin', 'wstunnel')];
  }
  if (LINUX) {
    return ['/usr/local/bin/wstunnel', '/usr/bin/wstunnel',
            path.join(HOME, '.local', 'bin', 'wstunnel')];
  }
  return [path.join(LOCAL_APP_DATA, 'TunnelVPN', 'bin', 'wstunnel.exe')];
}

/** The picker Veil opens when the user locates the VPN by hand. */
const VPN_PICKER = MAC
  ? { title: 'Locate Tunnel VPN.app', filters: [{ name: 'Applications', extensions: ['app'] }] }
  : LINUX
    ? { title: 'Locate the Tunnel VPN program', filters: [{ name: 'Programs', extensions: ['*'] }] }
    : { title: 'Locate TunnelVPN.exe', filters: [{ name: 'Programs', extensions: ['exe'] }] };

/* -------------------------------------------------- other browsers on disk

   Where the Chromium-family browsers keep the file that holds their
   bookmarks. It is plain JSON and unencrypted, which is why importing them
   needs nothing from the user but permission.

   Passwords are deliberately absent from this list. Chrome and its relatives
   encrypt those with a key held by the operating system, and newer versions
   bind that key to the browser binary itself; reading them would mean
   impersonating another application to its own keystore. Veil asks for an
   exported file instead - which also means the user sees exactly what they
   are handing over.

   Firefox is absent for a different reason: its bookmarks live in a SQLite
   database, and shipping an SQLite reader to avoid one export step is not a
   trade worth making. Its HTML export imports like any other.               */

const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

/** Every Chromium-family browser this knows about, by where its data lives. */
function chromiumFamily() {
  if (MAC) {
    const app = path.join(HOME, 'Library', 'Application Support');
    return [
      { name: 'Chrome', dir: path.join(app, 'Google', 'Chrome') },
      { name: 'Edge', dir: path.join(app, 'Microsoft Edge') },
      { name: 'Brave', dir: path.join(app, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', dir: path.join(app, 'Vivaldi') },
      { name: 'Opera', dir: path.join(app, 'com.operasoftware.Opera') },
    ];
  }
  if (LINUX) {
    return [
      { name: 'Chrome', dir: path.join(XDG_CONFIG, 'google-chrome') },
      { name: 'Chromium', dir: path.join(XDG_CONFIG, 'chromium') },
      { name: 'Edge', dir: path.join(XDG_CONFIG, 'microsoft-edge') },
      { name: 'Brave', dir: path.join(XDG_CONFIG, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', dir: path.join(XDG_CONFIG, 'vivaldi') },
      { name: 'Opera', dir: path.join(XDG_CONFIG, 'opera') },
    ];
  }
  return [
    { name: 'Chrome', dir: path.join(LOCAL_APP_DATA, 'Google', 'Chrome', 'User Data') },
    { name: 'Edge', dir: path.join(LOCAL_APP_DATA, 'Microsoft', 'Edge', 'User Data') },
    { name: 'Brave', dir: path.join(LOCAL_APP_DATA, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { name: 'Vivaldi', dir: path.join(LOCAL_APP_DATA, 'Vivaldi', 'User Data') },
    { name: 'Opera', dir: path.join(ROAMING, 'Opera Software', 'Opera Stable') },
  ];
}

/**
 * Every bookmarks file on this machine that Veil could read, as
 * { browser, profile, file }.
 *
 * A Chromium profile directory is "Default", or "Profile 1" and up, and each
 * holds its own Bookmarks file. Opera keeps one at the top level instead.
 */
function bookmarkFiles() {
  const found = [];
  for (const { name, dir } of chromiumFamily()) {
    try {
      if (!fs.existsSync(dir)) continue;

      const top = path.join(dir, 'Bookmarks');
      if (fs.existsSync(top)) found.push({ browser: name, profile: '', file: top });

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name, 'Bookmarks');
        if (fs.existsSync(file)) {
          found.push({ browser: name, profile: entry.name, file });
        }
      }
    } catch {}
  }
  return found;
}

/* ------------------------------------------------------- names for the UI

   The settings and password pages describe what holds a secret and what holds
   a proxy setting, and those are different things on each platform. Saying
   "your Windows account" to somebody on a Mac is not a cosmetic error: it
   tells them the wrong thing about where their passwords are kept.          */

/** What the OS keystore is called, in the words the user's own OS uses. */
const KEYSTORE_NAME = MAC ? 'the macOS Keychain'
  : LINUX ? 'your system keyring'
  : 'your Windows account';

/** The same, capitalised for the start of a sentence or a button. */
const KEYSTORE_SHORT = MAC ? 'Keychain'
  : LINUX ? 'system keyring'
  : 'Windows account';

/** Where the machine's own proxy settings live, by name. */
const SYSTEM_PROXY_NAME = MAC ? 'the network settings in System Settings'
  : LINUX ? 'the desktop network settings'
  : "Windows' proxy settings";

/** Every platform fact a renderer is allowed to ask for, in one object. */
function describe() {
  return {
    os: MAC ? 'mac' : LINUX ? 'linux' : 'windows',
    name: MAC ? 'macOS' : LINUX ? 'Linux' : 'Windows',
    keystore: KEYSTORE_NAME,
    keystoreShort: KEYSTORE_SHORT,
    systemProxy: SYSTEM_PROXY_NAME,
    // Tunnel VPN is published for Windows and macOS only. On Linux the pages
    // that offer it say so rather than showing a picker for a file that was
    // never built.
    hasVpnApp: !LINUX,
    // electron-updater cannot replace a .deb, and a .deb is what Ubuntu should
    // be installing, so Linux is told to fetch the new version itself.
    canSelfUpdate: !LINUX
  };
}

/** The window icon. Windows takes the .ico; everything else wants a bitmap. */
const APP_ICON = path.join(__dirname, '..', '..', 'assets', WINDOWS ? 'icon.ico' : 'icon.png');

module.exports = {
  MAC, WINDOWS, LINUX, UNIX, APP_ICON,
  KEYSTORE_NAME, KEYSTORE_SHORT, SYSTEM_PROXY_NAME, describe,
  chromiumFamily, bookmarkFiles,
  firstExisting,
  VPN_CTRL_DIR, vpnCandidates, VPN_PROCESS_MARKS, PROCESS_LIST_CMD, VPN_PICKER,
  TOR_BUNDLE_PLATFORM, TOR_BINARY,
  wstunnelCandidates
};
