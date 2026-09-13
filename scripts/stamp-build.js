// Records when this build was made, so the browser can tell the user how old
// its Chromium is. Run automatically before packaging.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electron = (pkg.devDependencies && pkg.devDependencies.electron || '').replace(/^[^\d]*/, '');

/* Whether this build is signed, per platform.
 *
 * It matters for more than trust. macOS will not let an unsigned application
 * replace itself: electron-updater downloads the new version, fails the code
 * signature check and leaves the user where they started, after a long wait
 * and an obscure error. Veil would rather say so up front, so the stamp
 * carries the answer and the updater reads it.
 *
 * An empty `identity` means electron-builder was told explicitly not to sign.
 * `publisherName` absent on Windows means the updater's own signature check on
 * a downloaded installer is skipped. Both are recorded as they are. */
const build = pkg.build || {};
const signed = {
  mac: !!(build.mac && build.mac.identity),
  win: !!(build.win && build.win.publisherName)
};

const info = {
  builtAt: new Date().toISOString(),
  version: pkg.version,
  electron,
  signed
};
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('stamped build-info.json:', info.builtAt,
  '| signed: mac=' + signed.mac + ' win=' + signed.win);
