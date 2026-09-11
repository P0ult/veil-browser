'use strict';

/**
 * An Adblock Plus / uBlock Origin filter engine.
 *
 * Veil used to block by hostname alone: every rule was reduced to a domain,
 * and a request was blocked if its host was on the list. That is cheap and it
 * catches whole ad networks, but it cannot express most of what the real
 * filter lists say - that a script is only an ad when a *different* site loads
 * it, that this path under an otherwise ordinary domain is a tracker, that
 * this element is the empty box the ad left behind.
 *
 * This reads those lists properly. It is not all of uBlock Origin - there is
 * no scriptlet injection, no procedural cosmetic filtering, no redirection -
 * but it is the part that does the blocking:
 *
 *   - network patterns, with the option syntax: $third-party, $script,
 *     $domain=a.com|~b.com, and the rest of the resource types
 *   - exception rules (@@), which are what stop a filter list breaking sites
 *   - cosmetic rules (##, #@#), generic and per-domain
 *
 * Speed comes from the same place uBlock gets it: rules are indexed under one
 * token of their own pattern, and a URL is only ever tested against rules
 * whose token it actually contains. A page load tests a handful of rules out
 * of sixty thousand rather than all of them.
 *
 * Anything whose meaning is not fully implemented here is dropped rather than
 * approximated. A rule that blocks more than it was written to block breaks
 * pages, and a broken page is worse than an advert.
 */

/* ------------------------------------------------------------ resource types */

const TYPE = {
  mainFrame: 1 << 0,
  subFrame: 1 << 1,
  stylesheet: 1 << 2,
  script: 1 << 3,
  image: 1 << 4,
  font: 1 << 5,
  object: 1 << 6,
  xhr: 1 << 7,
  ping: 1 << 8,
  media: 1 << 9,
  webSocket: 1 << 10,
  other: 1 << 11
};
const ALL_TYPES = Object.values(TYPE).reduce((a, b) => a | b, 0);

/** Electron's resourceType names, as bits. */
const TYPE_OF_RESOURCE = {
  mainFrame: TYPE.mainFrame,
  subFrame: TYPE.subFrame,
  stylesheet: TYPE.stylesheet,
  script: TYPE.script,
  image: TYPE.image,
  font: TYPE.font,
  object: TYPE.object,
  xhr: TYPE.xhr,
  ping: TYPE.ping,
  cspReport: TYPE.ping,
  media: TYPE.media,
  webSocket: TYPE.webSocket,
  other: TYPE.other
};

/** The filter lists' names for the same things. */
const TYPE_OF_OPTION = {
  script: TYPE.script,
  image: TYPE.image,
  stylesheet: TYPE.stylesheet,
  css: TYPE.stylesheet,
  object: TYPE.object,
  'object-subrequest': TYPE.object,
  xmlhttprequest: TYPE.xhr,
  xhr: TYPE.xhr,
  subdocument: TYPE.subFrame,
  frame: TYPE.subFrame,
  ping: TYPE.ping,
  beacon: TYPE.ping,
  websocket: TYPE.webSocket,
  media: TYPE.media,
  font: TYPE.font,
  other: TYPE.other,
  document: TYPE.mainFrame,
  doc: TYPE.mainFrame
};

/**
 * Options that change what a rule *does* rather than when it applies. A rule
 * carrying one of these does something this engine cannot do, so the rule is
 * dropped: honouring the pattern while ignoring the instruction would block a
 * request that was meant to be rewritten, redirected or merely reported on.
 */
const UNSUPPORTED_OPTIONS = new Set([
  'csp', 'redirect', 'redirect-rule', 'removeparam', 'queryprune', 'replace',
  'app', 'method', 'header', 'permissions', 'urltransform', 'uritransform',
  'inline-script', 'inline-font', 'genericblock', 'generichide', 'specifichide',
  'elemhide', 'ehide', 'cname', 'denyallow', 'to', 'from', 'ipaddress',
  'popunder', 'empty', 'mp4', 'stealth'
]);

/* -------------------------------------------------------------- tokenising

   A rule is filed under one token from its own pattern, and a URL is only
   tested against rules filed under tokens the URL contains. Picking a *rare*
   token matters: file everything under "com" and every request tests every
   rule again.                                                              */

const TOKEN_RE = /[a-z0-9%]{3,}/g;

const COMMON_TOKENS = new Set([
  'http', 'https', 'www', 'com', 'net', 'org', 'html', 'htm', 'php', 'index',
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'css', 'js', 'json', 'img', 'image',
  'images', 'static', 'assets', 'content', 'default', 'public', 'file', 'files',
  'data', 'api', 'cdn', 'media', 'src', 'the', 'and', 'for', 'min'
]);

function tokensOf(text) {
  TOKEN_RE.lastIndex = 0;
  return text.toLowerCase().match(TOKEN_RE) || [];
}

/** The most distinctive token in a pattern, or '' if it has none worth using. */
function pickToken(pattern) {
  // Only the literal runs can be tokens: anything next to a wildcard might not
  // appear in the URL in that form.
  const literals = pattern.toLowerCase().split(/[*^|]+/);
  let best = '';
  for (const part of literals) {
    TOKEN_RE.lastIndex = 0;
    for (const t of part.match(TOKEN_RE) || []) {
      if (COMMON_TOKENS.has(t)) continue;
      if (t.length > best.length) best = t;
    }
  }
  return best;
}

/* --------------------------------------------------------------- patterns */

function escapeRe(s) { return s.replace(/[.+?${}()|[\]\\]/g, '\\$&'); }

/**
 * An Adblock pattern as a regular expression.
 *
 *   ||host^   the domain anchor: this host or any subdomain of it
 *   |         the start or the end of the address
 *   ^         a separator: anything that is not part of a name
 *   *         anything at all
 */
function patternToRe(pattern) {
  let src = pattern;
  let prefix = '';
  let suffix = '';

  if (src.startsWith('||')) {
    prefix = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?';
    src = src.slice(2);
  } else if (src.startsWith('|')) {
    prefix = '^';
    src = src.slice(1);
  }
  if (src.endsWith('|') && !src.endsWith('\\|')) {
    suffix = '$';
    src = src.slice(0, -1);
  }

  const body = escapeRe(src)
    .replace(/\*/g, '.*')
    .replace(/\^/g, '(?:[^a-zA-Z0-9_.%-]|$)');

  return new RegExp(prefix + body + suffix, 'i');
}

/** `||example.com^` and nothing else: the common case, and a Set lookup. */
const PLAIN_DOMAIN_RE = /^\|\|([a-z0-9.-]+)\^?$/i;

/* ------------------------------------------------------------------ a rule */

function parseNetworkRule(line) {
  let text = line;
  const exception = text.startsWith('@@');
  if (exception) text = text.slice(2);

  let pattern = text;
  let optionText = '';

  // A regex rule is /like this/ and may contain a $ of its own, so the option
  // separator is only looked for after the closing slash.
  if (pattern.startsWith('/')) {
    const close = pattern.lastIndexOf('/');
    if (close > 0) {
      const after = pattern.slice(close + 1);
      if (after === '' || after.startsWith('$')) {
        optionText = after.slice(1);
        pattern = pattern.slice(0, close + 1);
      }
    }
  }
  if (!optionText) {
    const dollar = pattern.lastIndexOf('$');
    if (dollar > 0) {
      optionText = pattern.slice(dollar + 1);
      pattern = pattern.slice(0, dollar);
    }
  }
  if (!pattern) return null;

  const rule = {
    exception,
    types: 0,            // 0 means "every type"
    notTypes: 0,
    thirdParty: null,    // true, false, or null for either
    domains: null,
    notDomains: null,
    re: null,
    host: '',            // set for the ||domain^ fast path
    token: ''
  };

  if (optionText) {
    for (const raw of optionText.split(',')) {
      if (!raw) continue;
      let opt = raw.trim().toLowerCase();
      const negated = opt.startsWith('~');
      if (negated) opt = opt.slice(1);

      const eq = opt.indexOf('=');
      const name = eq >= 0 ? opt.slice(0, eq) : opt;
      const value = eq >= 0 ? raw.trim().slice(eq + 1) : '';

      if (name === 'domain') {
        for (const d of value.toLowerCase().split('|')) {
          if (!d) continue;
          if (d.startsWith('~')) (rule.notDomains || (rule.notDomains = new Set())).add(d.slice(1));
          else (rule.domains || (rule.domains = new Set())).add(d);
        }
        continue;
      }
      if (name === 'third-party' || name === '3p') { rule.thirdParty = !negated; continue; }
      if (name === 'first-party' || name === '1p') { rule.thirdParty = negated; continue; }
      if (name === 'all') { continue; }
      // Flags that only narrow when a request is *not* matched, or that this
      // engine treats as no-ops, are harmless to ignore.
      if (name === 'important' || name === 'match-case' || name === 'strict3p' ||
          name === 'strict1p' || name === 'popup' || name === 'badfilter') {
        if (name === 'badfilter') return null;      // cancels another rule: skip both safely
        continue;
      }

      const bit = TYPE_OF_OPTION[name];
      if (bit) {
        if (negated) rule.notTypes |= bit;
        else rule.types |= bit;
        continue;
      }
      // Anything else changes the meaning of the rule in a way this engine
      // does not implement.
      return null;
    }
  }

  // A pattern made mostly of wildcards can take exponential time to fail.
  // Nothing in the lists needs more than a few.
  if ((pattern.match(/\*/g) || []).length > 4) return null;

  const plain = PLAIN_DOMAIN_RE.exec(pattern);
  if (plain && !pattern.includes('*')) {
    rule.host = plain[1].toLowerCase();
    rule.token = rule.host.split('.').filter(p => p.length >= 3 && !COMMON_TOKENS.has(p))[0] || '';
  } else if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    try { rule.re = new RegExp(pattern.slice(1, -1), 'i'); } catch { return null; }
  } else {
    try { rule.re = patternToRe(pattern); } catch { return null; }
    rule.token = pickToken(pattern);
  }

  return rule;
}

/* ------------------------------------------------------------ the engine */

class FilterEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.blockByToken = new Map();
    this.blockNoToken = [];
    this.allowByToken = new Map();
    this.allowNoToken = [];

    // The hostname set: every plain ||domain^ rule and every hosts-file line.
    this.blockedHosts = new Set();
    this.hostExceptions = new Set();

    // Cosmetic filtering.
    this.cosmeticByDomain = new Map();     // domain -> [selector]
    this.cosmeticExceptions = new Map();   // domain -> Set(selector)
    this.genericByToken = new Map();       // class/id token -> [selector]
    this.genericComplex = [];              // generic selectors with no single token

    this.counts = { network: 0, host: 0, cosmetic: 0, generic: 0, skipped: 0 };
  }

  /** Add one list, in Adblock, hosts, or plain-domain format. */
  addList(text) {
    for (const raw of String(text).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line[0] === '!' || line[0] === '[' || line[0] === '#' && line[1] === ' ') continue;
      this.addLine(line);
    }
  }

  addLine(line) {
    // Cosmetic rules first: ## and #@# are unambiguous, and a URL pattern can
    // legitimately contain a #.
    const hashHash = line.indexOf('##');
    const hashAt = line.indexOf('#@#');
    if (hashAt >= 0) return this.addCosmetic(line.slice(0, hashAt), line.slice(hashAt + 3), true);
    if (hashHash >= 0) return this.addCosmetic(line.slice(0, hashHash), line.slice(hashHash + 2), false);
    // Procedural and scriptlet syntax, which this engine does not run.
    if (/#[@$?%]?#/.test(line) || line.includes('#%#') || line.includes('#$#')) {
      this.counts.skipped++;
      return;
    }
    return this.addNetwork(line);
  }

  addNetwork(line) {
    // hosts format: "0.0.0.0 tracker.example" / "127.0.0.1 tracker.example"
    const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+(\S+)/.exec(line);
    if (hosts) return this.addHost(hosts[1]);

    // A bare domain on a line of its own, as the DNS-style lists publish.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(line)) {
      return this.addHost(line);
    }

    const rule = parseNetworkRule(line);
    if (!rule) { this.counts.skipped++; return; }

    // A plain domain rule with no conditions attached is just a blocked host,
    // and a Set lookup beats any amount of pattern matching.
    if (rule.host && !rule.types && !rule.notTypes && rule.thirdParty === null &&
        !rule.domains && !rule.notDomains) {
      if (rule.exception) this.hostExceptions.add(rule.host);
      else this.blockedHosts.add(rule.host);
      this.counts.host++;
      return;
    }

    if (rule.host && !rule.re) rule.re = patternToRe('||' + rule.host + '^');

    const byToken = rule.exception ? this.allowByToken : this.blockByToken;
    const noToken = rule.exception ? this.allowNoToken : this.blockNoToken;
    if (rule.token) {
      const bucket = byToken.get(rule.token);
      if (bucket) bucket.push(rule);
      else byToken.set(rule.token, [rule]);
    } else {
      noToken.push(rule);
    }
    this.counts.network++;
  }

  addHost(host) {
    const h = String(host).toLowerCase().replace(/^www\./, '');
    if (!h || !h.includes('.') || /[^a-z0-9.\-_]/.test(h)) return;
    if (h === 'localhost' || h === 'localhost.localdomain' || h === 'local') return;
    this.blockedHosts.add(h);
    this.counts.host++;
  }

  /* ----------------------------------------------------------- cosmetic */

  addCosmetic(domainPart, selector, isException) {
    const sel = selector.trim();
    if (!sel) return;
    // Procedural selectors, scriptlets and style rewriting: not implemented,
    // and a partial implementation would hide the wrong things.
    if (/^\+js\(|:has-text\(|:xpath\(|:matches-css|:matches-path|:matches-media|:min-text-length|:upward\(|:watch-attr|:remove\(|:style\(|:others\(|\\/.test(sel)) {
      this.counts.skipped++;
      return;
    }

    const domains = domainPart.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

    if (!domains.length) {
      if (isException) return;              // a generic exception needs a domain
      return this.addGeneric(sel);
    }

    for (const d of domains) {
      const negated = d.startsWith('~');
      const domain = negated ? d.slice(1) : d;
      // "everywhere except here" is an exception in all but name.
      const target = (isException || negated) ? this.cosmeticExceptions : this.cosmeticByDomain;
      if (isException || negated) {
        const set = target.get(domain) || new Set();
        set.add(sel);
        target.set(domain, set);
      } else {
        const list = target.get(domain) || [];
        list.push(sel);
        target.set(domain, list);
        this.counts.cosmetic++;
      }
    }
  }

  /**
   * A generic rule applies to every site, and there are tens of thousands of
   * them. Injecting all of them into every page costs real time on every load,
   * so the simple ones - a single class or id - are filed under that name and
   * handed out only when the page turns out to contain it. That is how uBlock
   * does it, and it is the difference between a stylesheet of forty thousand
   * selectors and one of forty.
   */
  addGeneric(sel) {
    const simple = /^([.#])([A-Za-z0-9_-]+)$/.exec(sel);
    if (simple) {
      const key = simple[1] + simple[2].toLowerCase();
      const list = this.genericByToken.get(key);
      if (list) list.push(sel);
      else this.genericByToken.set(key, [sel]);
      this.counts.generic++;
      return;
    }
    // Everything else: an attribute selector, a descendant, a tag. These are
    // few enough to carry as they are.
    if (this.genericComplex.length < 6000) {
      this.genericComplex.push(sel);
      this.counts.generic++;
    } else {
      this.counts.skipped++;
    }
  }

  /* ------------------------------------------------------------ matching */

  /** Does any rule in these buckets match? */
  matchIn(byToken, noToken, ctx) {
    for (const token of ctx.tokens) {
      const bucket = byToken.get(token);
      if (!bucket) continue;
      for (const rule of bucket) if (this.ruleMatches(rule, ctx)) return rule;
    }
    for (const rule of noToken) if (this.ruleMatches(rule, ctx)) return rule;
    return null;
  }

  ruleMatches(rule, ctx) {
    // A rule that names no type does not block a top-level navigation. uBlock
    // draws this line too, and for the same reason: `||ads.example.com^` is
    // written to stop a page loading adverts, not to stop you visiting the
    // advert company's website if you type its address in. Veil still blocks
    // navigation to a host on the blocklist - that is the hostname set, and it
    // has its own warning page - but a pattern rule stays out of it.
    if (!rule.types && !rule.exception && (ctx.type & TYPE.mainFrame)) return false;
    if (rule.types && !(rule.types & ctx.type)) return false;
    if (rule.notTypes & ctx.type) return false;
    if (rule.thirdParty !== null && rule.thirdParty !== ctx.thirdParty) return false;

    if (rule.domains && !domainListHas(rule.domains, ctx.docDomain)) return false;
    if (rule.notDomains && domainListHas(rule.notDomains, ctx.docDomain)) return false;

    return rule.re ? rule.re.test(ctx.url) : false;
  }

  /**
   * Should this request be blocked?
   *
   * @param {object} ctx { url, host, type (Electron's name), docDomain, thirdParty }
   * @returns {'block'|'allow'|null}
   */
  decide(ctx) {
    const type = TYPE_OF_RESOURCE[ctx.type] || TYPE.other;
    const probe = {
      url: ctx.url,
      tokens: tokensOf(ctx.url),
      type,
      thirdParty: !!ctx.thirdParty,
      docDomain: ctx.docDomain || ''
    };

    const hostBlocked = this.hasBlockedHost(ctx.host);
    const blocked = hostBlocked || this.matchIn(this.blockByToken, this.blockNoToken, probe);
    if (!blocked) return null;

    if (this.hasHostException(ctx.host)) return 'allow';
    if (this.matchIn(this.allowByToken, this.allowNoToken, probe)) return 'allow';
    return 'block';
  }

  hasBlockedHost(hostname) { return setHasDomainOrParent(this.blockedHosts, hostname); }
  hasHostException(hostname) { return setHasDomainOrParent(this.hostExceptions, hostname); }

  /* ------------------------------------------------- cosmetic, for a page */

  /** The rules written for this site by name, plus the generic odd ones. */
  cosmeticFor(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    const specific = [];
    const excepted = new Set();

    for (const domain of parentsOf(host)) {
      const ex = this.cosmeticExceptions.get(domain);
      if (ex) for (const s of ex) excepted.add(s);
    }
    for (const domain of parentsOf(host)) {
      const list = this.cosmeticByDomain.get(domain);
      if (list) for (const s of list) if (!excepted.has(s)) specific.push(s);
    }

    return {
      specific,
      complex: this.genericComplex,
      excepted: [...excepted]
    };
  }

  /**
   * Which generic rules apply to a page containing these class and id names.
   * The page sends what it has; this answers with the few rules that match.
   */
  genericFor(tokens, excepted) {
    const out = [];
    const skip = excepted instanceof Set ? excepted : new Set(excepted || []);
    for (const t of tokens) {
      const list = this.genericByToken.get(String(t).toLowerCase());
      if (!list) continue;
      for (const s of list) if (!skip.has(s)) out.push(s);
    }
    return out;
  }

  size() { return this.counts.network + this.counts.host; }
}

/* ------------------------------------------------------------------ helpers */

/** example.com, then com - the labels a domain rule could be written against. */
function parentsOf(host) {
  const out = [];
  if (!host) return out;
  let h = host;
  out.push(h);
  let i = h.indexOf('.');
  while (i !== -1) {
    const parent = h.slice(i + 1);
    if (!parent.includes('.')) break;
    out.push(parent);
    i = h.indexOf('.', i + 1);
  }
  return out;
}

function domainListHas(set, host) {
  for (const d of parentsOf(host)) if (set.has(d)) return true;
  return false;
}

function setHasDomainOrParent(set, hostname) {
  if (!hostname || !set.size) return false;
  const h = String(hostname).toLowerCase();
  if (set.has(h)) return true;
  for (const parent of parentsOf(h)) if (set.has(parent)) return true;
  return false;
}

module.exports = { FilterEngine, TYPE, tokensOf, parseNetworkRule, patternToRe };
