'use strict';
const { MAC, WINDOWS } = require('./platform');

/**
 * What Veil says it is.
 *
 * Veil *is* Chromium, but Electron dresses it slightly differently from
 * Chrome, and the differences are exactly the ones sites use to tell an
 * embedded browser from a real one:
 *
 *   - Chrome sends `Sec-CH-UA`, `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform`
 *     on every request. Overriding the user agent in Electron stops them
 *     being sent at all, and a browser that claims to be Chrome while sending
 *     no client hints is not a browser Chrome has ever shipped.
 *   - `navigator.userAgentData.brands` lists Chromium but not "Google Chrome".
 *   - `window.chrome` exists but is empty, where in Chrome it carries app,
 *     csi, loadTimes and runtime.
 *
 * Google's sign-in page checks all three and refuses with "this browser may
 * not be secure". So this module keeps one answer and makes every surface
 * give it: the header, the JavaScript object and the user agent string agree
 * with each other and with the machine Veil is actually running on.
 *
 * The user agent names the real platform rather than always claiming Windows.
 * Claiming Windows everywhere would be the more anonymous choice if anything
 * else backed it up, but nothing does - the client hints, `navigator.platform`
 * and the font list all say what the machine really is - so the only thing the
 * lie bought was a contradiction that marks Veil out as something odd.
 */

/** The version Chrome would put in a user agent string: major, then zeros. */
function chromeMajor() {
  return String(process.versions.chrome || '').split('.')[0] || '0';
}

function platformToken() {
  if (MAC) return 'Macintosh; Intel Mac OS X 10_15_7';   // what Chrome reports on every Mac
  if (WINDOWS) return 'Windows NT 10.0; Win64; x64';
  return 'X11; Linux x86_64';
}

/** The `Sec-CH-UA-Platform` name for this machine. */
function platformName() {
  if (MAC) return 'macOS';
  if (WINDOWS) return 'Windows';
  return 'Linux';
}

function userAgent() {
  return 'Mozilla/5.0 (' + platformToken() + ') AppleWebKit/537.36 (KHTML, like Gecko) ' +
         'Chrome/' + chromeMajor() + '.0.0.0 Safari/537.36';
}

/**
 * The brand list, in the shape Chrome sends it.
 *
 * The "Not?A_Brand" entry is deliberate on Chrome's part - it is there to stop
 * sites hard-coding the list - so it is kept, and "Google Chrome" is added
 * beside Chromium, which is what a Chrome build reports and an Electron build
 * does not.
 */
function brands() {
  const v = chromeMajor();
  return [
    { brand: 'Not?A_Brand', version: '24' },
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v }
  ];
}

/** The same list as the `Sec-CH-UA` header value. */
function secChUa() {
  return brands().map(b => '"' + b.brand + '";v="' + b.version + '"').join(', ');
}

/** The low-entropy client hints Chrome puts on every request. */
function clientHints() {
  return {
    'Sec-CH-UA': secChUa(),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"' + platformName() + '"'
  };
}

module.exports = { userAgent, brands, secChUa, clientHints, platformName, chromeMajor };
