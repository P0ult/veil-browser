'use strict';

/**
 * All network-layer privacy lives here. Electron allows exactly one listener per
 * webRequest event per session, so ad blocking, HTTPS upgrades, referrer
 * trimming and cookie stripping are all registered from this single module.
 */

// Second-level suffixes that need three labels to identify a site.
const MULTI_TLD = new Set([
  'co.uk','ac.uk','gov.uk','org.uk','me.uk','net.uk','sch.uk',
  'com.au','net.au','org.au','edu.au','gov.au',
  'co.nz','net.nz','org.nz','co.za','org.za',
  'com.br','com.mx','com.ar','com.tr','com.cn','com.hk','com.tw','com.sg',
  'co.jp','ne.jp','or.jp','co.kr','co.in','net.in','org.in',
  'com.pl','com.ua','com.ru','co.il','com.my','co.th','com.ph','com.vn'
]);

function baseDomain(hostname) {
  if (!hostname) return '';
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_TLD.has(last2) && parts.length >= 3) return parts.slice(-3).join('.');
  return last2;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const STATIC_TYPES = new Set(['image', 'stylesheet', 'font', 'media']);

class NetPrivacy {
  /**
   * @param {Electron.Session} session
   * @param {object} deps { settings, adblock, getTopUrl(wcId), onBlocked(wcId) }
   */
  constructor(session, deps) {
    this.session = session;
    this.settings = deps.settings;
    this.adblock = deps.adblock;
    this.getTopUrl = deps.getTopUrl || (() => '');
    this.onBlocked = deps.onBlocked || (() => {});
    this.onMainFrameBlocked = deps.onMainFrameBlocked || (() => {});
    this.httpsFailures = new Set();   // hosts the user chose to reach unencrypted
    this.upgrades = new Map();        // https url -> the http url it came from
    this.install();
  }

  p(key) { return this.settings.get('privacy.' + key); }

  /**
   * The user has looked at the warning for this site and decided to go on
   * unencrypted. Remembered for this run only - nothing is written down, so a
   * restart puts the protection back.
   */
  allowInsecure(url) {
    const host = hostOf(url);
    if (host) this.httpsFailures.add(host.toLowerCase());
    return !!host;
  }

  /** If this https address was one Veil upgraded, the original http one. */
  originalFor(httpsUrl) {
    return this.upgrades.get(httpsUrl) || null;
  }

  rememberUpgrade(httpsUrl, httpUrl) {
    // Bounded: this only exists to answer "did we cause this failure?".
    if (this.upgrades.size > 200) this.upgrades.clear();
    this.upgrades.set(httpsUrl, httpUrl);
  }

  /**
   * Is this request going somewhere other than the site the user is on?
   *
   * A top-level navigation is never third party: it *is* the new first party.
   * Comparing it against the page being left would strip Set-Cookie from the
   * very responses that sign you in, which breaks any login that redirects
   * across domains - most single sign-on, including Microsoft's.
   */
  isThirdParty(details) {
    if (details.resourceType === 'mainFrame') return false;
    const host = hostOf(details.url);
    const topHost = hostOf(this.getTopUrl(details.webContentsId));
    if (!host || !topHost) return false;
    return baseDomain(host) !== baseDomain(topHost);
  }

  /** Blocking decision for a single request. */
  decide(details) {
    const url = details.url || '';
    if (url.startsWith('veil:') || url.startsWith('devtools:') || url.startsWith('blob:') || url.startsWith('data:')) return null;

    const host = hostOf(url);
    const isMain = details.resourceType === 'mainFrame';
    const topHost = hostOf(this.getTopUrl(details.webContentsId));

    // A main-frame request *is* the new top-level site, so it answers for
    // itself when checking the user's pause list. Sub-resources answer to
    // whichever page is hosting them.
    const siteHost = isMain ? host : topHost;

    if (this.p('blockAds') && host && !this.adblock.isAllowedSite(siteHost)) {
      const sameSite = topHost && baseDomain(host) === baseDomain(topHost);
      const verdict = this.adblock.decide({
        url,
        host,
        type: details.resourceType,
        docDomain: isMain ? host : topHost,
        thirdParty: this.isThirdParty(details)
      });

      if (verdict) {
        if (isMain) {
          // Only a hostname list stops a navigation. A pattern rule is about
          // what a page loads, not about where you are allowed to go.
          if (verdict === 'block-host') {
            this.adblock.countHit(details.webContentsId);
            this.onMainFrameBlocked(details.webContentsId, url);
            return { cancel: true };
          }
        } else if (verdict === 'block') {
          this.adblock.countHit(details.webContentsId);
          this.onBlocked(details.webContentsId);
          return { cancel: true };
        } else {
          // A hostname list cannot tell "this domain serves adverts" from
          // "this domain is the page you are reading", so a site's own
          // pictures and stylesheets survive a hit on one; its scripts and
          // background requests do not.
          if (!sameSite || details.resourceType === 'script' || details.resourceType === 'xhr') {
            this.adblock.countHit(details.webContentsId);
            this.onBlocked(details.webContentsId);
            return { cancel: true };
          }
        }
      }
    }

    // Upgrade plain http to https for navigations and subresources.
    if (this.p('httpsOnly') && url.startsWith('http://')) {
      const h = host.toLowerCase();
      const isLocal = h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
                      h.endsWith('.local') || /^(10|127|192\.168)\./.test(h) ||
                      /^172\.(1[6-9]|2\d|3[01])\./.test(h);
      if (!isLocal && !this.httpsFailures.has(h)) {
        const secure = 'https://' + url.slice(7);
        this.rememberUpgrade(secure, url);
        return { redirectURL: secure };
      }
    }

    return null;
  }

  install() {
    const wr = this.session.webRequest;

    wr.onBeforeRequest((details, cb) => {
      let verdict = null;
      try { verdict = this.decide(details); } catch {}
      cb(verdict || { cancel: false });
    });

    wr.onBeforeSendHeaders((details, cb) => {
      const headers = details.requestHeaders;
      try {
        if (this.p('sendDnt')) {
          headers['DNT'] = '1';
          headers['Sec-GPC'] = '1';
        }
        const host = hostOf(details.url);
        const thirdParty = this.isThirdParty(details);

        if (this.p('trimReferrer') && headers['Referer']) {
          const refHost = hostOf(headers['Referer']);
          if (refHost && baseDomain(refHost) !== baseDomain(host)) {
            // Cross-site: send the bare origin, never the full path.
            try { headers['Referer'] = new URL(headers['Referer']).origin + '/'; }
            catch { delete headers['Referer']; }
          }
        }

        if (this.p('blockThirdPartyCookies') && thirdParty && headers['Cookie']) {
          delete headers['Cookie'];
        }

        const ua = this.p('spoofUserAgent') ? (this.p('userAgent') || '') : '';
        if (ua) headers['User-Agent'] = ua;
      } catch {}
      cb({ requestHeaders: headers });
    });

    wr.onHeadersReceived((details, cb) => {
      const headers = details.responseHeaders || {};
      try {
        if (this.p('blockThirdPartyCookies') && this.isThirdParty(details)) {
          for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === 'set-cookie') delete headers[key];
          }
        }
        // Sites that ask the browser to run FLoC/Topics-style ad measurement.
        for (const key of Object.keys(headers)) {
          const k = key.toLowerCase();
          if (k === 'permissions-policy' || k === 'feature-policy') continue;
          if (k === 'report-to' || k === 'nel') delete headers[key];
        }
      } catch {}
      cb({ responseHeaders: headers });
    });
  }
}

module.exports = { NetPrivacy, baseDomain, hostOf, STATIC_TYPES };
