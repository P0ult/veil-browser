'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');

const PAGES_DIR = path.join(__dirname, '..', 'ui', 'pages');
const UI_DIR = path.join(__dirname, '..', 'ui');

// Hosts that map to a page of the same name in src/ui/pages.
const PAGES = new Set([
  'home', 'search', 'settings', 'blocked', 'error', 'about', 'passwords', 'insecure'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** Must run before app ready. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'veil',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false
    }
  }]);
}

function notFound(what) {
  return new Response('Not found: ' + what, { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * Called after app ready, once per session that needs veil:// pages. The global
 * `protocol` object only covers the default session, and Veil browses in its
 * own partition, so the handler has to be attached per session.
 */
function registerHandler(settings, ses) {
  const target = ses ? ses.protocol : protocol;
  target.handle('veil', async (request) => {
    try {
      return await serve(settings, request);
    } catch (err) {
      // A throw here surfaces to the page as a bare ERR_FAILED, which says
      // nothing. Turn it into something readable instead.
      console.error('[veil://] handler failed for', request.url, '-', err && err.stack || err);
      return new Response('veil:// handler error: ' + (err && err.message || err), {
        status: 500, headers: { 'content-type': 'text/plain' }
      });
    }
  });
}

async function serve(settings, request) {
    let u;
    try { u = new URL(request.url); } catch { return notFound(request.url); }

    const host = (u.hostname || '').toLowerCase();

    // veil://asset/bg — the user's chosen background image, served from wherever
    // it lives so nothing has to be copied into the profile.
    if (host === 'asset' && u.pathname.replace(/\//g, '') === 'bg') {
      const p = settings.get('appearance.bgImage', '');
      if (p && /^https?:/i.test(p)) return net.fetch(p);
      try {
        if (p && fs.existsSync(p)) {
          const ext = path.extname(p).toLowerCase();
          const buf = await fs.promises.readFile(p);
          return new Response(buf, {
            headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' }
          });
        }
      } catch {}
      return notFound('background');
    }

    // Anything with a file extension is a static asset of the UI.
    const ext = path.extname(u.pathname).toLowerCase();
    let file;
    if (host === 'chrome' && !ext) {
      file = path.join(UI_DIR, 'chrome.html');
    } else if (ext && MIME[ext]) {
      file = path.join(PAGES_DIR, path.basename(u.pathname));
      if (!fs.existsSync(file)) file = path.join(UI_DIR, path.basename(u.pathname));
    } else {
      const page = PAGES.has(host) ? host : 'home';
      file = path.join(PAGES_DIR, page + '.html');
    }

    // Never serve outside the UI directory.
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(UI_DIR))) return notFound(u.pathname);
    if (!fs.existsSync(resolved)) return notFound(u.pathname);

  const body = await fs.promises.readFile(resolved);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'text/plain',
      'cache-control': 'no-store'
    }
  });
}

module.exports = { registerScheme, registerHandler, PAGES };
