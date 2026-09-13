'use strict';
const { net } = require('electron');

/**
 * Veil handles the https scheme itself.
 *
 * There is one thing a browser cannot do from inside a page, and YouTube's
 * adverts are it. The advert list arrives in the watch page's own JSON, the
 * player keeps a private copy of it before anything else runs, and the request
 * that fetches it on a later video is issued from a context no hook in this
 * process can see - not the page, not its iframes, not its service worker, not
 * the webRequest layer, not the debugger. Every one of those was tried and
 * every one of them saw every other request and never that one.
 *
 * What is left is the scheme itself. With this on, Veil answers https requests
 * by making them itself, which puts the reply in its hands before the page
 * ever sees it. Two kinds of reply are read and rewritten - the YouTube watch
 * page and the player API - and everything else is handed straight back as a
 * stream, so video and images are never copied through this process.
 *
 * The cost is real and worth stating: every request is re-issued rather than
 * going straight out, and the header work Veil normally does in webRequest
 * does not happen for a re-issued request. That work is therefore done here
 * instead, from the same policy, or turning this on would quietly turn the
 * browser's privacy off.
 */

const WATCH_PAGE = /^https:\/\/(www|m)\.youtube\.com\/(watch|shorts|embed)\b/;
const PLAYER_API = /\/youtubei\/v1\/(player|reel_watch_sequence)\b/;

/**
 * Renaming rather than deleting. The JSON stays exactly as long and exactly as
 * valid; the player simply finds nothing where it looks for its advert list.
 * Cutting the values out means balancing brackets inside a megabyte of
 * minified JSON, which is a parser's job and not worth doing to a page.
 */
const AD_KEYS = /"(adPlacements|playerAds|adSlots|adBreakHeartbeatParams)":/g;

class Interceptor {
  constructor(session, deps) {
    this.session = session;
    this.settings = deps.settings;
    this.netPrivacy = deps.netPrivacy || null;
    this.getTopUrl = deps.getTopUrl || (() => '');
    this.installed = false;
    this.stats = { requests: 0, pages: 0, apis: 0, keysRenamed: 0, errors: 0 };
  }

  enabled() {
    return !!this.settings.get('privacy.rewriteYouTube', false);
  }

  /** Turn the handler on or off to match the setting. */
  sync() {
    const want = this.enabled();
    if (want === this.installed) return;
    if (want) this.install(); else this.uninstall();
  }

  install() {
    try {
      this.session.protocol.handle('https', (request) => this.serve(request));
      this.installed = true;
    } catch (e) {
      console.error('[intercept] could not take the https scheme:', e.message);
    }
  }

  uninstall() {
    try { this.session.protocol.unhandle('https'); } catch {}
    this.installed = false;
  }

  /** Ask the network for this request, with Veil's own header policy on it. */
  fetchUpstream(request) {
    let headers = request.headers;
    if (this.netPrivacy) {
      const plain = {};
      for (const [k, v] of request.headers) plain[k] = v;
      try {
        // A re-issued request never reaches onBeforeSendHeaders, so the same
        // policy is applied here by hand.
        this.netPrivacy.applyRequestHeaders(plain, request.url, this.isThirdParty(request));
      } catch {}
      headers = new Headers();
      for (const [k, v] of Object.entries(plain)) {
        if (v !== undefined && v !== null) headers.set(k, String(v));
      }
    }

    return net.fetch(new Request(request, { headers }), { bypassCustomProtocolHandlers: true });
  }

  /** Best effort: the scheme handler is not told which tab asked. */
  isThirdParty(request) {
    try {
      const top = this.getTopUrl();
      if (!top) return false;
      return new URL(request.url).hostname !== new URL(top).hostname;
    } catch { return false; }
  }

  async serve(request) {
    this.stats.requests++;
    const url = request.url;
    const isPage = WATCH_PAGE.test(url);
    const isApi = PLAYER_API.test(url);

    try {
      const answer = await this.fetchUpstream(request);
      if (!isPage && !isApi) return answer;

      const type = String(answer.headers.get('content-type') || '');
      // A watch address that answers with anything but a page is not the page.
      if (isPage && !/text\/html/i.test(type)) return answer;

      const text = await answer.text();
      const hits = (text.match(AD_KEYS) || []).length;
      if (!hits) return this.rebuild(answer, text);

      this.stats.keysRenamed += hits;
      if (isPage) this.stats.pages++; else this.stats.apis++;
      return this.rebuild(answer, text.replace(AD_KEYS, '"veilNoAds_$1":'));
    } catch (e) {
      this.stats.errors++;
      // A page served is better than a page rewritten: fall back to the plain
      // request rather than failing the navigation.
      try { return await net.fetch(request, { bypassCustomProtocolHandlers: true }); }
      catch { return new Response('', { status: 502 }); }
    }
  }

  /** The reply, with a body we have already read and possibly changed. */
  rebuild(answer, body) {
    const headers = new Headers(answer.headers);
    // Both describe the bytes we just replaced, and both are now wrong.
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(body, {
      status: answer.status,
      statusText: answer.statusText,
      headers
    });
  }
}

module.exports = { Interceptor, WATCH_PAGE, PLAYER_API, AD_KEYS };
