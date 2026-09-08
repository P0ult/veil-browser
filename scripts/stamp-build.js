// Records when this build was made, so the browser can tell the user how old
// its Chromium is. Run automatically before packaging.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electron = (pkg.devDependencies && pkg.devDependencies.electron || '').replace(/^[^\d]*/, '');

const info = { builtAt: new Date().toISOString(), version: pkg.version, electron };
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log('stamped build-info.json:', info.builtAt);
