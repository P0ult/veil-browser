# Veil

A private browser and search engine for Windows. No ads, no history, no autofill,
no telemetry, no AI. Built on Chromium via Electron, with the whole network layer
under our own control.

```bash
npm start
```

---

## What it is

Veil is two things in one window:

**A browser.** Tabs, an address bar, find-in-page, zoom, downloads — the normal
things — with a deliberately small surface. There is no sync, no profile
switcher, no reading list, no shopping assistant, no sidebar of suggestions.

**A search engine.** Not a redirect to somebody else's search page: Veil's main
process queries several independent engines itself, merges their rankings,
cleans the links, and renders the results in its own paged interface. Nothing
about a query touches disk.

## Privacy, concretely

| | How |
|---|---|
| **No history** | There is no history feature at all — no history database, no history UI, nothing recording the pages you visit. This holds whichever profile mode you pick. |
| **Stay signed in** | Settings → Privacy. `keep` (default) stores cookies and cache on disk, so accounts survive a restart and pages load from cache. `none` is a RAM-only profile that forgets every login on exit. |
| **No Chromium autofill** | Chromium's own `Autofill` and `PasswordManager` stacks are disabled by command-line switch at launch. Veil's password vault (below) is separate and entirely under your control. |
| **Tunnel** | All browser traffic goes through Tor, or your own SOCKS5/HTTP endpoint, with a kill switch. On by default. |
| **Encrypted DNS** | DNS-over-HTTPS, so lookups are not readable on the wire. |
| **Ad and tracker blocking** | A full Adblock Plus / uBlock Origin filter engine, matching in `webRequest` before a packet leaves the machine: network patterns with resource types, first- and third-party rules, per-site rules and exceptions. EasyList, EasyPrivacy and uBlock Origin's own lists ship inside the app - about 116,000 rules - and refresh from their sources. |
| **Adverts inside the page's own data** | Some adverts cannot be blocked by refusing a request - YouTube describes its adverts inside the same JSON the player needs to play the video. uBlock Origin's scriptlets handle these, and are kept current by its maintainers rather than by this project. |
| **YouTube adverts** | Yes. uBlock Origin runs inside Veil, patched to work under Electron, and its scriptlets take the advert data out of the player before it is read - on a watch page opened directly and on a video clicked through to inside the site. Settings -> Privacy -> Use uBlock Origin. |
| **Blocking statistics** | `veil://stats` keeps a running count of what has been refused: the domains, how often, and whether an advert list or a tracking list named them, with a chart of the last thirty days. It is deliberately not history — the domain that was turned away is recorded, never the page you were reading when it happened. |
| **Reader view** | Strips a page to the thing you came to read. Runs in the preload, so no site's Content-Security-Policy can refuse it, and nothing is fetched or sent anywhere. |
| **No empty ad boxes** | Cosmetic filtering from the same lists collapses the containers a blocked ad leaves behind. The page says which class and id names it contains and is sent only the rules that could match one, so it carries forty selectors rather than forty thousand. |
| **Third-party cookies** | Stripped from cross-site requests in both directions — `Cookie` going out, `Set-Cookie` coming back. |
| **Referrers** | Cross-site requests send the bare origin, never the page you came from. |
| **HTTPS** | Plain `http://` is upgraded automatically, with a one-shot fallback for sites that genuinely cannot serve TLS. |
| **DNT / GPC** | `DNT: 1` and `Sec-GPC: 1` on every request. |
| **WebRTC** | IP handling policy set so a page cannot enumerate your local addresses. |
| **Permissions** | Notifications, USB, serial, HID, Bluetooth, idle detection and friends are denied outright. Camera, microphone and location prompt, and default to no. |
| **Telemetry** | Crash reporting, metrics, domain reliability, background networking, component updates, DNS prefetching and the entire Privacy Sandbox advertising stack are off. |
| **Fingerprinting** | Per-site noise on canvas, WebGL and audio readings, plus normalised CPU/memory/language. Randomisation, not Tor-style uniformity — see below. The user agent, the client hints and the page-side objects all give one consistent answer, which is what stops sites treating Veil as an embedded browser. |
| **HTTPS** | An upgraded address that will not load over TLS shows a warning page. Veil never falls back to plaintext on its own. |
| **Updates** | Veil knows how old its own Chromium is and says so, and can update itself when a release feed is configured. |
| **No AI** | Nothing summarises, completes, suggests or calls a model. The address bar has no dropdown at all — that is the point, not an omission. |

## Running uBlock Origin

Veil has its own filter engine, and for what it is it is a good one: same
lists, same rules, same collapsing of the empty boxes a blocked advert leaves
behind. It cannot stop a video advert. Those are not described in a list at
all — YouTube ships its advert schedule inside the same JSON the player needs
to play the video, and the player reads it before any page script runs. What
stops them is a set of small scripts that uBlock Origin rewrites every time
YouTube changes the delivery, and keeping pace with that by hand is not a race
this project can win.

So uBlock Origin runs inside Veil, and its own maintainers keep it current.

### The fork

uBlock is written against a full Chrome; Electron implements a subset. Loaded
unmodified it blocks nothing at all — not because blocking fails, but because
startup dies on the second line of its API table, reaching for
`chrome.browserAction`. Measured: 185 advert-host requests without it, 189
with it.

The fork is one new file and one added import line in each of two others:

```
assets/ubo/js/veil-chrome.js      new — the APIs Electron lacks
assets/ubo/js/webext.js           + import { chrome } from './veil-chrome.js'
assets/ubo/js/vapi-background.js  + import { chrome as browser } from './veil-chrome.js'
```

Patching the `chrome` global from a script does not work here. It appears to —
every property is present when the script ends — and then Electron puts its own
object back before uBlock's modules run. The substitution happens in module
scope instead, where nothing can reach in and undo it.

Most of what `veil-chrome.js` supplies is furniture for a browser UI uBlock has
not been given: a toolbar badge, a context menu, a window list, a Chrome
preference. One part is not.

### The part that mattered

**Electron fires no tab events, and reports `tabId: -1` on every request.** No
`tabs.onUpdated`, no `tabs.onCreated`, no `webNavigation` — and a main-frame
request carries nothing that identifies which tab it belongs to.

uBlock builds its per-page state from those events, and answers a content
script's request for cosmetic filters and scriptlets only once that state
exists. Without them it loaded all ten of its lists, blocked advert hosts
perfectly well, and filtered nothing whatsoever on the page itself. Every
content script asked for its filters and was answered with nothing.

Navigation is reconstructed from two signals. A content script's port opens at
document start and its sender carries the tab id, the frame id and the URL —
that listener is registered as the module loads, before uBlock's own messaging
sets up, so the commit is dispatched before uBlock reads the first message off
that port. Veil's main process also says so directly, from
`did-start-navigation`, which is earlier still; an extension tab id is the id
of its `webContents`, which is what makes that sayable at all. A slow
`tabs.query` sweep covers same-document navigation and retires the state of
tabs that have closed, neither of which Electron announces either.

### One rule uBlock cannot apply here

Clicking a video inside YouTube fetches `/youtubei/v1/get_watch`, not
`/player`. uBlock strips the advert data out of that response with `$replace=`
filters, which need `webRequest.filterResponseData` — Firefox only. Its
Chromium stand-in is a scriptlet covering `"adSlots"` alone, and the line that
would cover `"adPlacements"` ships commented out. So on Chromium, in Chrome as
much as in Veil, the video you click through to still arrives with its advert
breaks scheduled.

Veil enables that commented-out line as a user filter, verbatim. Over three
videos reached by clicking, `adPlacements` was present on two of three without
it and on none of three with it.

### What this replaced

An earlier version answered the `https` scheme itself, making each request from
the main process so the watch page could be rewritten before the player read
it. It worked, and it was fast — median page load fell on every site measured —
but `accounts.google.com` refuses any request re-issued that way with
`401 — malformed`, whatever is done to the headers. It also never reached a
video clicked through to inside the site. It has been deleted, along with its
setting: uBlock does the same job without breaking sign-in, and leaving four
hundred lines of it in the tree behind a switch nobody should turn on was not
worth the surface.

### Alongside it

Veil's own engine keeps running: it is what the shield button counts and what
the per-site toggle switches off. While uBlock is up, Veil stops serving its
own cosmetic rules and scriptlets — two stylesheets for one page is work twice
over, and two sets of scriptlets pinning the same property is how both end up
broken.

Settings → Privacy → **Use uBlock Origin**. It needs *Stay signed in*: an
extension cannot load into a profile that is never written to disk.

## Blocking, counted

`veil://stats` answers a question a shield icon with a number on it cannot:
what is actually being blocked, and by what.

It keeps, across restarts, the domain that was refused, how many times, and
which kind of list named it. `src/main/stats.js` writes it to `block-stats.json`
in the profile, debounced to one write every twenty seconds, and trims itself to
sixty days and three thousand domains.

**What it deliberately does not keep is the page you were on.** That line is the
whole design. `doubleclick.net, 412 times, an advert list` is a fact about
advertising. `doubleclick.net, on the page you read at 11:04` is browsing
history wearing a different hat, and this browser does not have history.

The advert-or-tracker label is not a guess about the domain — nothing can tell
those apart by looking at a name. The lists are already split along that line,
and a rule knows which list it came from, so the label says exactly what it
knows: which kind of list stopped this request. Only the uncommon answers are
stored, because a hosts list can carry 180,000 domains and writing "advert"
beside each of them would cost megabytes to record what can be assumed.

Turn the counting off in Settings → Privacy, or forget the figures from the
page itself.

## Reading

**Reader view** (`Ctrl+Alt+R`, or the ⋮ menu) strips a page to its article.

It runs in the tab's preload rather than in the page, which is what makes it
work everywhere: the preload's DOM access is the page's DOM, but its code is not
subject to the page's Content-Security-Policy, so no site can refuse it. Nothing
is fetched and nothing is sent anywhere — the article is already in the
document; reader view only decides which part of it is the article.

The extraction is the old heuristic, and it is boring because it works: score
every block by how much of its text sits in paragraphs rather than in links, and
take the winner. A page with no article in it says so rather than emptying
itself. The original page is hidden, not destroyed, so its own scripts keep
running and pressing the key again puts everything back exactly as it was,
scroll position included.

**PDFs** open in Chromium's own viewer rather than downloading. It is already in
the binary; nothing is sent anywhere to render one. Settings → Browser.

**Zoom is remembered per site.** Chromium keeps a zoom level per origin, but only
for as long as the session lives, so a site you always read at 125% was back at
100% after every restart. It is written down now, and put back when the page
commits rather than after it has painted at the wrong size.

**A tab making a noise** shows a speaker button, in the tab strip and in the
vertical rail, and clicking it silences that tab. It appears only when there is
a sound to stop.

## The search engine

`veil://search/?q=…` is served by `src/main/search.js`:

1. **DuckDuckGo** (the `lite` endpoint, falling back to the `html` one) and
   **Marginalia** (its own crawler over the non-commercial web, so results are
   not a single index reheated) are queried in parallel from the main process,
   over a throwaway session that carries no cookies. **Mojeek** is available too
   but ships off, because it usually answers with a bot check.
2. Results are merged with **weighted reciprocal rank fusion** — a page several
   engines rank highly beats one a single engine happens to put first, and a
   niche index cannot outrank the obvious answer on an everyday query. A slow
   engine is dropped after six seconds rather than holding up the page.
3. DuckDuckGo's `/l/?uddg=` redirect wrappers are unwrapped, and `utm_*`,
   `fbclid`, `gclid`, `msclkid` and about thirty other tracking parameters are
   stripped, so the link you click is the real one.
4. **Wikipedia** supplies the answer card at the top.
5. Ad blocks in the upstream markup are discarded before parsing.

Typical warm search: **under two seconds**. Prefer someone else's engine?
Settings → Search switches to DuckDuckGo, Mojeek, Startpage, Brave, Marginalia,
Wikipedia or any custom `%s` URL.

**Bangs** work in the address bar: `!yt orbital mechanics`, `!w tardigrade`,
`!gh electron`. The table is editable in Settings.

## The tunnel

On by default, and there is nothing to launch. Chromium proxies every request
the browsing session makes, so all browser traffic goes through the tunnel
without a driver, a UAC prompt or a separate program.

**This covers the browser, not the whole machine.** A system-wide VPN needs a
virtual network adapter and route-table edits, both of which require
Administrator; Veil runs unelevated and does not pretend otherwise. Other apps
on the machine are unaffected.

This is the same shape as Edge's "Secure Network": a browser-level proxy.
Edge supplies Cloudflare as the endpoint; Veil lets you point it at your own.

Providers, in Settings → Tunnel:

- **My VPN — whole machine** — the Tunnel VPN app carries every packet on the
  machine, so Veil does not proxy on top of it. What Veil adds is a browser kill
  switch: if a VPN that was up disconnects, browser traffic stops instead of
  quietly continuing in the clear.
- **My VPN — browser only** — routes just the browser through your own wstunnel
  server: no OpenVPN, no virtual adapter, no UAC. See the note below.

- **Tor** (default) — Veil downloads the official expert bundle, checks it
  against the published SHA-256, and runs it. Nothing to configure, but it is
  slow and blocked on restrictive networks.
- **My VPN — SOCKS5** — the proxy endpoint your VPN publishes.
- **My VPN — HTTP/HTTPS proxy** — the same, over HTTP CONNECT.

### Browser-only through your own server

`TunnelVPN` reaches its server with `wstunnel`, and wstunnel can forward to a
SOCKS server on the far side — which is all a browser tunnel needs. Two things
have to line up:

1. **On the server:** a SOCKS daemon, and its port added to the allowlist.
   `--restrict-to` can be given more than once:

   ```
   wstunnel server --restrict-to 127.0.0.1:1194 --restrict-to 127.0.0.1:1080 ws://0.0.0.0:8080
   ```

   Do not drop `--restrict-to` altogether — the tunnel address is published in a
   public gist, so an unrestricted server is an open proxy for anyone who reads
   it. If you want it open anyway, pair it with
   `--restrict-http-upgrade-path-prefix <secret>`.

2. **In Veil:** *Server-side SOCKS* set to that address (`127.0.0.1:1080` by
   default). Leaving it **empty** asks for a dynamic tunnel instead, which a
   restricted server refuses with HTTP 400 — Veil reports that exact cause
   rather than hanging.

The endpoint is re-read from the gist on every connect, so a rotated Cloudflare
quick-tunnel URL is picked up automatically.

**A note on exit IPs.** This design tunnels to *your* server, so your traffic
leaves from wherever that server is. If you are on the same connection as the
server, your IP will not change — that is expected. The point is getting out of
a restrictive network, not masking your address.

**Credentials.** Chromium has never supported username/password authentication
on SOCKS5, which is what nearly every commercial VPN requires. Veil works around
it with a loopback relay (`src/main/socks-relay.js`): it accepts an
unauthenticated SOCKS5 connection from Chromium on 127.0.0.1 and forwards each
one upstream with the credentials attached. Hostnames are passed through
untouched, so DNS is still resolved at the far end. HTTP proxies authenticate
the normal way, through Electron's `login` event, scoped to proxy challenges
only so a website asking for basic auth can never be handed VPN credentials.

Credentials are sealed with the OS keystore in `proxy.cred` — never written to
`settings.json`.

**Where you appear.** Settings → Tunnel → *Check* asks Cloudflare's trace
endpoint, through the tunnel, what IP and country the far end presents. The
answer also appears in the toolbar tooltip once connected.

The **kill switch** points the session at a dead port when a tunnel that was
running drops, so requests fail instead of quietly going out in the clear. It
deliberately does *not* fire when a tunnel never started — bricking a fresh
install helps nobody; you get a plain error and normal browsing instead.

Search queries go through the tunnel too, controlled by *Route search through
it*. This uses `net.request` rather than `net.fetch`, because only the former
honours a session's proxy — `net.fetch` would have sent every query straight out
of the machine while the tunnel claimed to carry it.

### The separate system VPN

The separate Tunnel VPN app is still wired up under Settings → Tunnel → System
VPN, for when you want the whole machine covered. Veil looks for it in the usual
places for the platform it is running on — `src/main/platform.js` holds that
list — and Settings has a picker for anywhere else. Veil opens it and reports
honest status by checking which processes are actually running; it does not
press Connect for you, because that app owns its own elevated session.

## Fingerprinting

Settings → Privacy → *Resist fingerprinting*. Canvas, WebGL and audio readings
get a small amount of noise, seeded from a secret generated at launch and mixed
with the site's own origin. That means:

- reading the same canvas twice on one page agrees, so a script cannot average
  the noise away
- the same canvas on another site disagrees, so two sites cannot line their
  readings up into one identity
- restarting Veil changes every answer again

WebGL reports a very ordinary integrated-graphics string, and
`hardwareConcurrency`, `deviceMemory` and `languages` report common values.

**Be clear about what this is.** It is Brave-style *randomisation*, not
Tor-style *uniformity*. It stops readings being joined across sites; it does not
make you look like everybody else. Tor Browser and Mullvad Browser do the
latter, and they give up a lot of usability for it. Screen metrics and timezone
are not spoofed here.

### Saying the same thing everywhere

Veil *is* Chromium, but Electron dresses it differently from Chrome in three
ways that sites use to tell an embedded browser from a real one: no `Sec-CH-UA`
client-hint headers, a brand list with Chromium but no Google Chrome, and an
empty `window.chrome`. Google's sign-in refuses all three — "this browser may
not be secure". `src/main/identity.js` holds one answer and every surface
repeats it: the header, the user agent string and the JavaScript object agree.

That includes naming the real platform. The user agent used to claim Windows on
every machine, which would be the more anonymous choice if anything else backed
it up — but the client hints, `navigator.platform` and the font list all say
what the machine really is, so the only thing the lie bought was a
contradiction that marked Veil out as something odd.

The defences are inlined into `src/preload/page.js` rather than living in their
own module, because tab preloads run sandboxed and a sandboxed preload can only
`require('electron')` — a relative require fails at load and takes the whole
bridge down with it.

## HTTPS without the quiet downgrade

When *Upgrade to HTTPS* is on and an upgraded address will not load over TLS,
Veil shows a warning page instead of retrying in the clear. Continuing needs two
deliberate presses, and the exemption lasts for that site until Veil is closed —
it is held in memory and never written to disk.

Only addresses **Veil itself upgraded** get this page. A site the user typed as
`https://` that fails is an ordinary error, not an invitation to drop to
plaintext.

## Updates

`src/main/updater.js`. Two jobs:

1. With a release feed configured (`build.publish` in `package.json`), it checks
   GitHub Releases and can download and install a new build. Nothing downloads
   or installs without being asked — `autoDownload` and `autoInstallOnAppQuit`
   are both off.
2. With or without a feed, it knows how old the running build is and says so.
   Past 45 days it warns; past 90 it warns harder. A browser that silently rots
   is the most dangerous program on the machine, so "no update server" must not
   become "no idea I am out of date".

It cannot always do the first of those, and says which rather than failing
late — see [Windows, macOS and Linux](#windows-macos-and-linux). Short version:
Windows yes, macOS only when the build is signed, Linux never.

The build date is stamped into `assets/build-info.json` by
`scripts/stamp-build.js`, which `npm run dist` runs first. The same stamp
records whether the build was signed, which is what the updater reads to decide
whether replacing itself can work at all. Timestamps before
2020 are treated as unknown rather than believed — Electron's own zip carries
1980 dates.

Point it at your own GitHub account once:

```bash
npm run set-owner -- YOUR-GITHUB-USERNAME
```

The repository has to be public — the updater fetches the feed anonymously, and
a private one would mean shipping a GitHub token inside the app. Full procedure
in [RELEASING.md](RELEASING.md).

## Passwords

An encrypted vault with autofill, at `veil://passwords` (**Ctrl+Shift+P**).

- Entries live in a single **AES-256-GCM** blob; the plaintext never touches disk
- The key comes from your master password via **PBKDF2-SHA512, 600,000 rounds**
- The derived key exists only in main-process memory while unlocked
- **Windows account unlock** wraps the key with DPAPI so the vault opens without
  a master password — this is what makes saving automatic, and it means anyone
  who can sign in as you can read it, which is the trade being made. Veil
  refuses to remove it unless a master password exists, since it would otherwise
  lock the vault permanently
- Auto-locks after 15 minutes by default

Autofill is deliberately narrow:

- only in the **top frame** of a page, so a cross-origin iframe cannot fish for
  the parent site's logins
- matched on the **registrable domain**, the same rule browsers use, so a login
  saved on `accounts.example.com` works on `example.com` and never reaches
  `example.evil.com`
- **HTTPS only** by default — it will not put a password into a plain-http page
- the main process re-checks the requesting page itself rather than trusting
  what the page claims
- passwords are never placed on `window`; the preload writes them straight into
  the field, so page scripts cannot read them from Veil

One saved login for a site fills itself; several offer a picker. **New logins
save themselves** — no prompt, and no vault to set up first: the first save
creates one protected by your Windows account, the same way Chrome and Edge do
it on Windows. Add a master password later from the passwords page if you want
one; turn the automatic behaviour off under Settings > Passwords.

This vault is the one thing in Veil that survives a restart — a password manager
that forgets is not a password manager. Everything else still lives in memory.

## Customising

Everything lives in one readable file at
`%APPDATA%\Veil\settings.json`, exportable and importable from Settings → Data.

- **Appearance** — accent, text and link colours, solid / gradient / image
  background with fit, dim and blur, liquid glass with an intensity slider, four
  font stacks, corner radius, compact or comfortable density, and **tabs across
  the top or down the left** (with an adjustable rail width and a
  collapse-to-icons mode). There is no light/dark switch: pick a pale
  background and the interface dresses itself to suit it.
- **New tab** — clock, greeting, shortcut tiles, status line, each toggleable
- **Search** — engine, which backends to blend, result count, bang table
- **Tunnel** — provider, kill switch, whether search is routed, encrypted DNS
- **Passwords** — autofill, save prompts, HTTPS-only, auto-lock
- **Privacy** — every switch in the table above
- **Ad block** — which lists are on, your own rules in the lists' own syntax, per-site pause list
- **Browser** — home page, new tab page, default zoom, shortcuts

Changes apply live across every open tab; nothing needs a restart except
switching the profile between in-memory and on-disk.

## Keyboard

| | |
|---|---|
| `Ctrl T` / `Ctrl W` | New tab · close tab |
| `Ctrl Shift T` | Reopen the last closed tab |
| `Ctrl L`, `F6`, `Alt D` | Focus the address bar |
| `Alt Enter` | Open the address bar entry in a new tab |
| `Ctrl F` · `F3` / `Shift F3` | Find in page · next · previous |
| `Alt ←` / `Alt →` | Back · forward |
| `Ctrl Tab` / `Ctrl Shift Tab` | Cycle tabs |
| `Ctrl 1…8`, `Ctrl 9` | Jump to tab · last tab |
| `Ctrl R` / `Ctrl Shift R` | Reload · reload ignoring cache |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | Zoom, remembered per site |
| `Ctrl Alt R` | Reader view |
| `Ctrl ,` | Settings |
| `Ctrl Shift P` | Passwords |
| `Ctrl Shift C` | Copy the current address |
| `Ctrl Shift I` | Developer tools |

On macOS every `Ctrl` above is `Cmd`: the shortcuts are declared once, as
`CmdOrCtrl`, and Electron binds and draws the right key on each platform.

Copy and paste are ordinary: `Ctrl C` / `Ctrl V` / `Ctrl X` / `Ctrl A` work in
pages and in Veil's own fields, `Ctrl Shift V` pastes as plain text, and the
right-click menu carries copy, paste, paste-as-plain-text, copy link, copy
image, and "Search Veil for …".

## Layout

```
src/
  main/
    index.js       app lifecycle, window, sessions, IPC
    tabs.js        one WebContentsView per tab
    net-privacy.js every webRequest rule: blocking, HTTPS, cookies, referrers
    adblock.js     the lists: what ships, what was downloaded, what you added
    filters.js     the filter engine: Adblock Plus syntax, network and cosmetic
    search.js      the meta-search engine
    tunnel.js      the in-browser tunnel: Tor, SOCKS5, kill switch
    socks-relay.js loopback SOCKS5 relay that authenticates upstream
    vault.js       encrypted password vault and autofill rules
    updater.js     release checks and build-age reporting
    vpn.js         system Tunnel VPN launch and status
    protocol.js    the veil:// scheme
    menus.js       application, context and toolbar menus
    layout.js      where the page, toolbar and tab rail views go
    hover.js       which window edge the pointer is reaching for
    settings.js    the settings store
  preload/
    chrome.js      bridge for the browser chrome
    page.js        cosmetic filter + bridge for veil:// pages
  ui/
    chrome.*       the horizontal tab strip and the toolbar
    rail.*         the vertical tab bar, in a view of its own
    theme.*        shared tokens, applied live from settings
    pages/         home, search, passwords, settings, about, blocked,
                   error, insecure
assets/
  blocklist.txt    a short hand-written domain list, as a backstop
  filters/         EasyList, EasyPrivacy and uBlock Origin's lists
  ubo/             uBlock Origin itself, patched to run under Electron
```

Two rules hold the security model together: the preload only hands the `veil`
bridge to `veil://` pages, and the main process independently checks the
sender's URL on every privileged IPC channel. A web page that got hold of the
bridge still could not read your settings.

## Appearance

Everything that can be recoloured has a token in `src/ui/theme.css`, and
`src/ui/theme.js` applies the user's choices on top of them. Two rules keep
that from turning into an unusable mess:

- **There is no light/dark switch.** The background is the switch: pick a pale
  colour and the text, surfaces, borders and outlines all move to their light
  values, because `theme.js` reads the background's luminance and dresses the
  interface to suit it. Dark is simply what an unset background looks like.
- **Liquid glass is honest about its limits.** Frosted panels use a real
  `backdrop-filter`, which blurs whatever is behind them *within their own
  view*. The toolbar and tab bar are separate native views from the page, and
  a backdrop-filter cannot reach across that boundary - so glass panels blur
  the chrome's own background, not the web page under them.
- **Blank means "follow the theme".** The background, the link colour and the
  tab bar colour are all empty by default. Storing a concrete value is what
  used to break light mode: the text switched and the background did not,
  because a colour was always set and it was always the dark one.
- **Controls keep a hard outline.** Once someone picks a strong background,
  translucent surfaces and tinted borders stop separating anything from
  anything. `--outline` is a flat, high-contrast edge that does not depend on
  the palette, and it can be switched off.

The logo is carried as an alpha mask (`src/ui/veil-mark.png`), so it takes the
colour of whatever is drawing it rather than bringing its own background.

## Search verticals

Web, Images, Videos, News and Shopping, chosen with `?t=` so a results page is
an ordinary address that can be returned to.

Images, Videos and News each come from an endpoint of their own, all of which
want a token fetched per query. **Shopping has no endpoint at all** - the
shopping and product paths fall through to the generic instant-answer API and
return nothing - so it is image results narrowed to retailers: a picture of the
thing, linking to the listing. That means no prices, and the page says so
rather than leaving a gap where a number should be. How well it works varies
with the query; a search whose results are mostly editorial will show few
listings.

## The chrome is three views, not one

The page, the toolbar and the vertical tab bar are three native views stacked
in one window, and `src/main/layout.js` works out their rectangles. There are
two arrangements:

- **Docked** - the chrome takes its space, the page gets what is left, nothing
  overlaps. This is the default.
- **Floating** ("Hide the chrome") - the page has the whole window and the
  toolbar and tab bar slide in over the top of it, each on its own, from the
  edge the pointer reached for. The page never moves, so no frame of the
  animation costs a document relayout.

The tab bar is a separate view precisely so it can float: a view can only be a
rectangle, and a toolbar plus a left rail is an L. Two rectangles can be.

Fully hidden means fully hidden - the views sit off-screen, where they can
neither be seen nor swallow a click meant for the page. Nothing is left to
hover, which is why the main process watches the cursor instead
(`src/main/hover.js`) and reveals whichever part the pointer approached.

## Platforms

Windows and macOS on Apple Silicon. The differences between them - where
Tunnel VPN installs itself, what its processes are called, which Tor expert
bundle to fetch, where wstunnel lives - are collected in
`src/main/platform.js` rather than scattered as `process.platform` checks, so
the modules that use them read the same on both.

What differs in practice:

- **Tunnel VPN** works on both; the macOS app is the same design (a supervisor
  holds one elevated session and writes `session.log`), so Veil tracks it the
  same way. Only the paths and process names change.
- **Tor** downloads the `macos-aarch64` expert bundle on Apple Silicon.
- **Signing** is a harder requirement on macOS: an unsigned build is refused
  outright rather than warned about, and auto-updates will not install. See
  [RELEASING.md](RELEASING.md).

## Packaging

```bash
npm run dist
```

Produces an NSIS installer and a portable `.exe` in `dist/`, and stamps
`assets/build-info.json` first so the built browser knows its own age.

`npm run release` does the same and uploads the result to a **draft** GitHub
release, as does pushing a version tag (`.github/workflows/release.yml`).
Drafts are invisible to the updater until you press Publish.

**Before handing a build to anyone else**, two things are worth doing, both
covered in [RELEASING.md](RELEASING.md):

1. **Point the update feed somewhere real** — `npm run set-owner -- <account>`.
   Until it names a GitHub account with releases, the installed browser can
   tell the user it is out of date but cannot fix it.
2. **Sign it.** An unsigned installer trips SmartScreen, and — more to the
   point — the updater's signature check on downloaded installers is skipped
   entirely while `publisherName` is absent, so update integrity rests on your
   GitHub account alone.

## Renaming it

`Veil` appears in `package.json` (`productName`, `build.appId`), in the
`veil://` scheme registered in `src/main/protocol.js`, and as display text in
the UI. The scheme name is the only one that has to change everywhere at once.

## Windows, macOS and Linux

Everything that differs between the three lives in `src/main/platform.js`, so
that adding a platform means editing one file and so that it is possible to read,
in one place, exactly what Veil assumes about the machine it is on. The pages ask
it for the words they use, rather than naming Windows and hoping: telling
somebody on a Mac that their passwords are kept by "your Windows account" is not
a cosmetic error, it tells them the wrong thing about where their passwords are.

Where something genuinely is not available, Veil says so instead of offering a
button that cannot work:

| | |
|---|---|
| **Tunnel VPN** (the separate whole-machine app) | Windows and macOS. On Linux the section is not shown, and a profile carried over from another machine is moved off that tunnel provider rather than left retrying one that can never start. |
| **Updating itself** | Windows, and macOS only when the build is signed — macOS will not let an unsigned application replace itself, so electron-updater would download the whole thing and then fail the signature check. The build stamp records whether it was signed and the updater reads it, so this turns itself on the day the builds are signed. Linux never: electron-updater can replace an AppImage and nothing else, and a `.deb` is what should be installed on Ubuntu. |
| **The keystore** | All three, under different names — DPAPI, Keychain, the system keyring. On a Linux box with no keyring running there is no keystore at all, and the vault needs a master password. |
| **The in-browser tunnel** | All three. It needs no driver and no root, which is the reason it is the one that matters on Linux. |

### The macOS "damaged" message

macOS refuses to open a downloaded application that is not signed and notarised,
and says it is *damaged* rather than *unsigned*, which is alarming and wrong. The
build is fine; Gatekeeper has quarantined it. Either right-click the app and
choose Open, or:

```bash
xattr -dr com.apple.quarantine /Applications/Veil.app
```

The real fix is an Apple Developer ID, which is also what turns updating itself
back on.

## Third-party software

Veil bundles [uBlock Origin](https://github.com/gorhill/uBlock) 1.74.0 in
`assets/ubo/`, under the **GNU General Public License v3**. Its full source
ships with the application, unminified, as that licence requires, along with
its own `LICENSE.txt`.

It is modified. uBlock is written against a full Chrome, and Electron
implements a subset of those APIs, so three changes were needed:

- `assets/ubo/js/veil-chrome.js` — new file. Supplies the extension APIs
  Electron lacks, and rebuilds the navigation events it never fires.
- `assets/ubo/js/webext.js` — one added import line.
- `assets/ubo/js/vapi-background.js` — one added import line.

Nothing else in uBlock Origin is touched, and nothing in those changes alters
what it blocks. The file's own header explains each part and why it is there.

Filter lists in `assets/filters/` are the work of their respective authors:
EasyList and EasyPrivacy (GPLv3 / CC BY-SA 3.0) and uBlock Origin's own lists
(GPLv3).
