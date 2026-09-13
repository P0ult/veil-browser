/*******************************************************************************

    Veil's patch to uBlock Origin.

    uBlock is written against a full Chrome. Electron implements a subset, and
    uBlock touches the missing parts while it is still starting up - the first
    is `chrome.browserAction`, for the toolbar badge, read on the second line
    of the table in webext.js. That read throws, startup stops, and uBlock goes
    on to block precisely nothing. Loaded unmodified into Veil it costs 16MB
    and stops no adverts at all: measured at 185 advert-host requests without
    it and 189 with it.

    Patching the `chrome` global from a script does not work here. It appears
    to: every property is there when the script finishes. Electron then puts
    its own object back, and by the time uBlock's modules run the additions are
    gone again. So the substitution happens in module scope instead, where
    nothing can reach in and undo it: webext.js imports `chrome` from here, and
    that import shadows the global for that file. That keeps this fork to one
    new file and two added lines.

    Most of what follows is furniture uBlock has not been given - a badge, a
    context menu, a window list, a Chrome preference. One part is not. Electron
    fires no tab events at all: no tabs.onUpdated, no tabs.onCreated, no
    webNavigation. uBlock builds its per-page state from those events, so
    without them it never creates a page store for a tab, and every request a
    content script makes for its cosmetic filters and scriptlets is answered
    with nothing. That is why an otherwise healthy uBlock, with ten lists
    loaded, would block advert hosts and still leave YouTube's adverts intact.
    Navigation is reconstructed below, from the one signal Electron does give
    at the right moment.

    uBlock Origin is GPLv3. This file is part of that work and carries the same
    licence; its source ships beside it, unminified, as the licence requires.

    Home: https://github.com/gorhill/uBlock

**/

'use strict';

const real = globalThis.chrome || {};

// Everything uBlock already has, by reference, so the live APIs stay live.
const api = {};
for ( const key of Object.getOwnPropertyNames(real) ) {
    try { api[key] = real[key]; } catch {}
}

const deadEvent = ( ) => ({
    addListener() {},
    removeListener() {},
    hasListener() { return false; },
});

const noop = (...args) => {
    const cb = args[args.length - 1];
    if ( typeof cb === 'function' ) { cb(); }
};

const absent = (name, value) => {
    if ( api[name] === undefined || api[name] === null ) { api[name] = value; }
};

/* An event this file fires itself. */
const liveEvent = ( ) => {
    const listeners = new Set();
    return {
        addListener(fn) { if ( typeof fn === 'function' ) { listeners.add(fn); } },
        removeListener(fn) { listeners.delete(fn); },
        hasListener(fn) { return listeners.has(fn); },
        fire(...args) {
            for ( const fn of listeners ) {
                try { fn(...args); } catch {}
            }
        },
    };
};

/* ------------------------------------------------------------ browserAction

   The toolbar badge. Veil draws its own blocked count in the shield button,
   so uBlock's icon and badge have nowhere to go.                            */

const badge = {
    setIcon: noop,
    setTitle: noop,
    setBadgeText: noop,
    setBadgeBackgroundColor: noop,
    setBadgeTextColor: noop,
    setPopup: noop,
    enable: noop,
    disable: noop,
    onClicked: deadEvent(),
};
absent('browserAction', badge);
absent('action', badge);

/* ------------------------------------------------------------- contextMenus

   uBlock's "block element" entry. Veil builds its own page menu.            */

absent('contextMenus', {
    create() { return 0; },
    update: noop,
    remove: noop,
    removeAll: noop,
    onClicked: deadEvent(),
});

/* ----------------------------------------------------------------- privacy

   Chrome preference toggles - link prefetching, WebRTC IP handling. Veil sets
   both itself, in the main process, for every session. A stub that reports
   them already off is closer to the truth than one that throws.             */

const pref = value => ({
    get(details, cb) {
        const fn = typeof details === 'function' ? details : cb;
        if ( fn ) { fn({ value, levelOfControl: 'controlled_by_this_extension' }); }
    },
    set: noop,
    clear: noop,
    onChange: deadEvent(),
});

absent('privacy', {
    network: {
        networkPredictionEnabled: pref(false),
        webRTCIPHandlingPolicy: pref('disable_non_proxied_udp'),
    },
    websites: {
        hyperlinkAuditingEnabled: pref(false),
        referrersEnabled: pref(true),
        thirdPartyCookiesAllowed: pref(false),
    },
});

/* ----------------------------------------------------------------- windows

   There is one window, and uBlock only asks in order to work out which tab is
   in front. tabs.query answers that already.                                */

const oneWindow = { id: 1, focused: true, type: 'normal', incognito: false };
const answer = (info, cb, value) => {
    const fn = typeof info === 'function' ? info : cb;
    if ( fn ) { fn(value); }
};

absent('windows', {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get(id, info, cb) { answer(info, cb, oneWindow); },
    getCurrent(info, cb) { answer(info, cb, oneWindow); },
    getLastFocused(info, cb) { answer(info, cb, oneWindow); },
    getAll(info, cb) { answer(info, cb, [ oneWindow ]); },
    create: noop,
    update: noop,
    remove: noop,
    onFocusChanged: deadEvent(),
    onCreated: deadEvent(),
    onRemoved: deadEvent(),
});

/* -------------------------------------------------------------- permissions

   Everything uBlock might ask for is already in the manifest Electron loaded,
   so every request has already been granted.                                */

absent('permissions', {
    contains(p, cb) { if ( cb ) { cb(true); } },
    request(p, cb) { if ( cb ) { cb(true); } },
    getAll(cb) { if ( cb ) { cb({ permissions: [], origins: [ '<all_urls>' ] }); } },
    remove(p, cb) { if ( cb ) { cb(true); } },
    onAdded: deadEvent(),
    onRemoved: deadEvent(),
});

/* --------------------------------------------------------------------- tabs

   tabs.query, tabs.get, tabs.update, tabs.sendMessage and - the one that
   matters, because it is how a scriptlet reaches the page - executeScript are
   all present. The rest are not, and neither is any of the events.          */

const tabEvents = {
    onCreated: liveEvent(),
    onUpdated: liveEvent(),
    onRemoved: liveEvent(),
    onActivated: liveEvent(),
};

if ( api.tabs ) {
    const tabs = {};
    for ( const key of Object.getOwnPropertyNames(api.tabs) ) {
        try { tabs[key] = api.tabs[key]; } catch {}
    }

    if ( typeof tabs.create !== 'function' ) {
        // uBlock opens its dashboard and its logger this way. There is nowhere
        // for either to go inside Veil, and refusing quietly beats throwing.
        tabs.create = function(props, cb) { if ( cb ) { cb({ id: -1 }); } };
    }
    if ( typeof tabs.remove !== 'function' ) { tabs.remove = noop; }

    /* Cosmetic filtering. uBlock hands its stylesheet to insertCSS, and
       without one a blocked advert leaves its empty box behind. executeScript
       is available, so the stylesheet goes in as a style element instead -
       which is what insertCSS does anyway. */
    if ( typeof tabs.insertCSS !== 'function' && typeof tabs.executeScript === 'function' ) {
        tabs.insertCSS = function(tabId, details, cb) {
            const css = String(details && details.code || '');
            if ( css === '' ) { if ( cb ) { cb(); } return; }
            tabs.executeScript(tabId, {
                frameId: details.frameId,
                matchAboutBlank: details.matchAboutBlank === true,
                runAt: 'document_start',
                code: '(function(){try{' +
                      'var s=document.createElement("style");' +
                      's.setAttribute("data-ubo","1");' +
                      's.textContent=' + JSON.stringify(css) + ';' +
                      '(document.head||document.documentElement).appendChild(s);' +
                      '}catch(e){}})();'
            }, ( ) => { void api.runtime.lastError; if ( cb ) { cb(); } });
        };

        tabs.removeCSS = function(tabId, details, cb) {
            const css = String(details && details.code || '');
            tabs.executeScript(tabId, {
                frameId: details.frameId,
                runAt: 'document_start',
                code: '(function(){try{' +
                      'var want=' + JSON.stringify(css) + ';' +
                      'var all=document.querySelectorAll("style[data-ubo]");' +
                      'for (var i=0;i<all.length;i++){ if(all[i].textContent===want){ all[i].remove(); } }' +
                      '}catch(e){}})();'
            }, ( ) => { void api.runtime.lastError; if ( cb ) { cb(); } });
        };
    }

    for ( const [ name, event ] of Object.entries(tabEvents) ) {
        tabs[name] = event;
    }

    api.tabs = tabs;
}

/* ------------------------------------------------------------ webNavigation

   The part that decides whether uBlock works at all.

   uBlock creates a page store when it sees a main frame commit, and answers a
   content script's request for cosmetic filters and scriptlets only if that
   store exists. Electron fires no navigation events, and reports tabId -1 on
   every webRequest, so nothing ever told uBlock a page had loaded. Every
   content script got an empty answer and gave up: no cosmetic filtering, no
   scriptlets, and therefore no way to touch YouTube's adverts, which are only
   reachable from a scriptlet.

   The one signal Electron does deliver, at the right moment and with the right
   identity, is the content script's own port. It opens at document start, and
   its sender carries the tab id, the frame id and the URL. Because this
   listener is registered while this module loads - before uBlock's own
   messaging sets up - it runs first, and the commit is dispatched before
   uBlock reads the first message off that port. By the time the request for
   filters arrives, the page store is there.

   A port opens once per document, so same-document navigation - YouTube moving
   from one video to the next without a reload - would go unseen. A slow poll
   of tabs.query covers that, and retires the page stores of tabs that have
   closed, which Electron also never announces.                              */

const navEvents = {
    onCommitted: liveEvent(),
    onBeforeNavigate: liveEvent(),
    onCreatedNavigationTarget: liveEvent(),
    onDOMContentLoaded: liveEvent(),
    onCompleted: liveEvent(),
    onHistoryStateUpdated: liveEvent(),
    onReferenceFragmentUpdated: liveEvent(),
};

api.webNavigation = Object.assign({
    getFrame(details, cb) { const fn = typeof details === 'function' ? details : cb; if ( fn ) { fn(null); } },
    getAllFrames(details, cb) { const fn = typeof details === 'function' ? details : cb; if ( fn ) { fn([]); } },
}, navEvents);

// What each tab was last seen showing, so a repeat is not announced twice.
const lastURL = new Map();

const isPage = url => /^(https?|file|ftp):/.test(String(url || ''));

const commit = (tabId, frameId, url) => {
    if ( isPage(url) === false ) { return; }
    if ( typeof tabId !== 'number' || tabId < 0 ) { return; }
    if ( frameId === 0 ) {
        if ( lastURL.get(tabId) === url ) { return; }
        lastURL.set(tabId, url);
    }
    const details = {
        tabId,
        frameId,
        parentFrameId: frameId === 0 ? -1 : 0,
        url,
        timeStamp: Date.now(),
        transitionType: 'link',
        transitionQualifiers: [],
    };
    navEvents.onBeforeNavigate.fire(details);
    navEvents.onCommitted.fire(details);
    navEvents.onDOMContentLoaded.fire(details);
};

/* Earlier still. A content script's port opens at document start, which is
   early enough for most of what uBlock does, but not for all of it: one of its
   YouTube rules removes a script that stashes a pristine copy of `fetch`
   before anything can wrap it, and that script has to be caught before the
   document is parsed at all. Nothing inside an extension sees a page that
   early here - Electron reports tabId -1 on every request, so a main frame
   request cannot even be attributed to a tab.

   Veil's main process can. It owns the views, its tab id is the webContents
   id, and it is told a navigation has begun before the first byte is parsed.
   It calls this. When Veil is not the host - a test harness, or uBlock loaded
   into a plain window - the port below still covers it.                     */

try {
    Object.defineProperty(globalThis, 'veilNavigation', {
        value(tabId, frameId, url) { commit(tabId, frameId | 0, url); return true; },
        configurable: true,
        writable: true,
    });
} catch {}

if ( api.runtime && api.runtime.onConnect ) {
    api.runtime.onConnect.addListener(port => {
        const sender = port && port.sender;
        if ( !sender || !sender.tab ) { return; }
        commit(sender.tab.id, sender.frameId | 0, sender.url || sender.tab.url);
    });
}

/* The slow half: same-document navigation, and tabs that have gone away. */

if ( api.tabs && typeof api.tabs.query === 'function' ) {
    const sweep = ( ) => {
        try {
            api.tabs.query({}, tabs => {
                void api.runtime.lastError;
                if ( Array.isArray(tabs) === false ) { return; }
                const alive = new Set();
                for ( const tab of tabs ) {
                    const { id, url } = tab;
                    if ( typeof id !== 'number' || id < 0 ) { continue; }
                    alive.add(id);
                    if ( isPage(url) === false ) { continue; }
                    if ( lastURL.get(id) === url ) { continue; }
                    const first = lastURL.has(id) === false;
                    lastURL.set(id, url);
                    if ( first ) {
                        tabEvents.onCreated.fire(tab);
                    }
                    // A URL change with no new document: uBlock rebinds the
                    // page store from this and re-runs its filters.
                    tabEvents.onUpdated.fire(id, { url, status: 'complete' }, tab);
                    navEvents.onHistoryStateUpdated.fire({
                        tabId: id,
                        frameId: 0,
                        parentFrameId: -1,
                        url,
                        timeStamp: Date.now(),
                        transitionType: 'link',
                        transitionQualifiers: [],
                    });
                }
                for ( const id of lastURL.keys() ) {
                    if ( alive.has(id) ) { continue; }
                    lastURL.delete(id);
                    tabEvents.onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
                }
            });
        } catch {}
    };
    setInterval(sweep, 700);
}

/* ------------------------------------------------------------- webRequest

   uBlock does not only cancel requests. For the best-known advert scripts -
   adsbygoogle.js, gpt.js, analytics.js - its lists carry `$redirect=` rules
   that swap the script for a harmless stub, so the page's own code still finds
   the function it expects and simply does nothing with it.

   Electron does not honour a redirect to a packaged extension resource. The
   redirect is dropped and the real script loads instead, which is why those
   three arrived intact while criteo, taboola and facebook were stopped dead.
   Turning the redirect into a cancel gets the advert blocked. It is blunter
   than uBlock intends - a page that insists on the stub existing may notice -
   but a blocked advert with an occasional broken widget beats an advert.     */

if ( api.webRequest && api.webRequest.onBeforeRequest ) {
    const webRequest = {};
    for ( const key of Object.getOwnPropertyNames(api.webRequest) ) {
        try { webRequest[key] = api.webRequest[key]; } catch {}
    }

    const source = api.webRequest.onBeforeRequest;
    const wrapped = new Map();

    webRequest.onBeforeRequest = {
        addListener(fn, filter, extra) {
            const wrap = function(details) {
                const r = fn(details);
                if ( r instanceof Object && typeof r.redirectUrl === 'string' ) {
                    if ( r.redirectUrl.startsWith('chrome-extension:') ||
                         r.redirectUrl.startsWith('moz-extension:') ||
                         r.redirectUrl.startsWith('data:') ) {
                        return { cancel: true };
                    }
                }
                return r;
            };
            wrapped.set(fn, wrap);
            return source.addListener(wrap, filter, extra);
        },
        removeListener(fn) {
            const wrap = wrapped.get(fn) || fn;
            wrapped.delete(fn);
            return source.removeListener(wrap);
        },
        hasListener(fn) {
            return source.hasListener(wrapped.get(fn) || fn);
        },
    };

    api.webRequest = webRequest;
}

export { api as chrome };
