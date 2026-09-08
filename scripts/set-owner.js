// Points the update feed at a GitHub account.
//
//   npm run set-owner -- <github-username> [repo-name]
//
// electron-builder bakes this into resources/app-update.yml at package time,
// and that file is the only thing the running browser consults when it asks
// whether a newer build exists. Getting it wrong is not a crash: the check
// just 404s forever, which is why it is worth setting deliberately.
const fs = require('node:fs');
const path = require('node:path');

const [owner, repo] = process.argv.slice(2);
if (!owner || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
  console.error('usage: npm run set-owner -- <github-username> [repo-name]');
  process.exit(1);
}

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const feed = pkg.build.publish[0];
feed.owner = owner;
if (repo) feed.repo = repo;

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('update feed: https://github.com/' + feed.owner + '/' + feed.repo + '/releases');
