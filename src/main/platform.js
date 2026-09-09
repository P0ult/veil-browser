'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The handful of facts that differ between Windows and macOS.
 *
 * They live together here rather than as `process.platform` checks sprinkled
 * through the modules that need them, so that adding a third platform is a
 * matter of editing one file and so that it is possible to read, in one place,
 * exactly what Veil assumes about the machine it is running on.
 */

const MAC = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';

const HOME = os.homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || HOME;

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
  : path.join(LOCAL_APP_DATA, 'TunnelVPN', 'ctrl');

/** Where the app itself usually ends up, most likely first. */
function vpnCandidates() {
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
  : { app: 'tunnelvpn.exe', openvpn: 'openvpn.exe', wstunnel: 'wstunnel.exe' };

/** The command that lists running processes, as [exe, args]. */
const PROCESS_LIST_CMD = MAC
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
  : 'windows-x86_64';

const TOR_BINARY = MAC ? 'tor' : 'tor.exe';

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
  return [path.join(LOCAL_APP_DATA, 'TunnelVPN', 'bin', 'wstunnel.exe')];
}

/** The picker Veil opens when the user locates the VPN by hand. */
const VPN_PICKER = MAC
  ? { title: 'Locate Tunnel VPN.app', filters: [{ name: 'Applications', extensions: ['app'] }] }
  : { title: 'Locate TunnelVPN.exe', filters: [{ name: 'Programs', extensions: ['exe'] }] };

module.exports = {
  MAC, WINDOWS,
  firstExisting,
  VPN_CTRL_DIR, vpnCandidates, VPN_PROCESS_MARKS, PROCESS_LIST_CMD, VPN_PICKER,
  TOR_BUNDLE_PLATFORM, TOR_BINARY,
  wstunnelCandidates
};
