'use strict';
const { net } = require('electron');

/**
 * A short answer, above the results.
 *
 * Off unless it is switched on, and worth being plain about why: everything
 * else in this browser is arranged so that what you look for does not leave
 * the machine except to the search engines themselves. This sends your query,
 * and the titles and snippets of the first few results, to whatever endpoint
 * is configured. That is a real change in where your searching goes, so it
 * ships off, it names the endpoint in the settings, and nothing is sent until
 * somebody turns it on.
 *
 * It talks to Ollama's HTTP API, which is what people run at home - a local
 * one over the network, or a tunnel to it. There is no account, no key, and
 * no third party: it is a model on a machine you chose.
 *
 * The model is not asked what it knows. It is given the search results and
 * asked to read the answer out of them, which is the difference between a
 * browser that answers questions and one that makes things up.
 */

const DEFAULT_ENDPOINT = '';
const DEFAULT_MODEL = 'llama3.1:8b';

/* A tunnel to a machine at home gets a new address every time it restarts, so
   pinning one in the settings means editing them again every morning. Instead
   the address can be published to a gist, and Veil reads it from there - the
   same arrangement the wstunnel provider already uses in ./tunnel.

   The gist is a plain text file containing the address. It is read
   unauthenticated, so it works without a token, and it is re-read whenever the
   cached one stops answering. */
/* The gist Veil ships with.
 *
 * It holds the address of the model this browser was built alongside, and it
 * is published rather than pinned because a quick tunnel gets a new address
 * every time it restarts. Anyone who reads this file knows the address, and a
 * quick tunnel has no authentication in front of it - which is the deal being
 * struck here: a model anybody can reach, in exchange for one that needs no
 * setting up. Point the endpoint box at your own server to opt out of it
 * entirely; a pinned address always wins over this. */
const DEFAULT_GIST = 'ad01e8789efedd3cdecbf48498c8b31c';

/* The file the publishing script writes. A gist can hold several files, and
   GitHub returns them in name order rather than in the order they were
   written, so a stale address in a file named earlier in the alphabet would
   otherwise win over the current one. This name is preferred; anything else is
   only a fallback for a gist somebody filled in by hand. */
const GIST_FILE = 'veil-ai-endpoint.txt';

const GIST_API = 'https://api.github.com/gists/';
const GIST_TTL_MS = 5 * 60 * 1000;
/* The first connection of a session is the slow one - measured at over twenty
   seconds against a cold network stack, and a fraction of a second after that
   - so this waits longer than the read itself could ever need, and tries twice
   before giving up. A gist is a few hundred bytes; the time is all handshake. */
const GIST_TIMEOUT_MS = 30000;
const GIST_ATTEMPTS = 2;

/* How long to wait.
 *
 * Generous, because the first request of a session is nothing like the rest:
 * a cold Ollama loads the model, and a tunnel opens its first connection.
 * Measured against a real one over a Cloudflare tunnel: 23s for the first
 * answer, then 1.2s for every one after it. Waiting costs nothing here - the
 * results are already on screen and the answer slots in above them whenever it
 * arrives - whereas a timeout tuned to the warm case would fail every first
 * search of the day. */
const TIMEOUT_MS = 60000;
const MAX_ANSWER = 200;        // characters; anything longer is not an answer
const CONTEXT_RESULTS = 5;

/**
 * The instruction.
 *
 * Written to fight the two things a small model does by default: explaining
 * itself, and being polite about it. "When is Christmas?" should produce
 * "25 December", not "Christmas Day is celebrated annually on the 25th of
 * December, which falls on a Thursday this year!"
 */
function buildPrompt(query, context) {
  const lines = [];

  lines.push('Answer the question using only the search results below.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Answer in as few words as possible. A name, a date, a number, a word.');
  lines.push('- No sentence unless the question cannot be answered without one.');
  lines.push('- No preamble, no restating the question, no explanation, no sources.');
  lines.push('- No greeting, no sign-off, no offer of further help.');
  lines.push('- If the results do not contain the answer, reply exactly: unknown');
  lines.push('');
  lines.push('Examples:');
  lines.push('Question: when is christmas');
  lines.push('Answer: 25 December');
  lines.push('Question: how tall is the eiffel tower');
  lines.push('Answer: 330 m');
  lines.push('Question: who wrote dracula');
  lines.push('Answer: Bram Stoker');
  lines.push('');
  lines.push('Search results:');

  for (const r of context.slice(0, CONTEXT_RESULTS)) {
    const title = String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const snippet = String(r.snippet || r.description || '').replace(/\s+/g, ' ').trim().slice(0, 320);
    if (!title && !snippet) continue;
    lines.push('- ' + title + (snippet ? ': ' + snippet : ''));
  }

  lines.push('');
  lines.push('Question: ' + String(query).replace(/\s+/g, ' ').trim().slice(0, 300));
  lines.push('Answer:');

  return lines.join('\n');
}

/**
 * Cut whatever came back down to the answer.
 *
 * Even told not to, a model will sometimes write "Answer: 25 December" or add
 * a second line explaining the first. The first line is the answer; the rest
 * is the thing the user asked not to have.
 */
function tidy(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';

  // Some models think out loud in tags before answering.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  text = text.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
  text = text.replace(/^answer\s*[:\-]\s*/i, '');
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();

  // "The answer is X" / "It is X" - the model restating the question.
  text = text.replace(/^(the answer is|it is|that is|this is)\s+/i, '').trim();

  if (!text) return '';
  if (/^(unknown|i don'?t know|i do not know|no answer)\b/i.test(text)) return '';
  if (text.length > MAX_ANSWER) return '';

  return text;
}

class AiAnswer {
  constructor(settings, session) {
    this.settings = settings;
    this.session = session;
  }

  get config() {
    return {
      enabled: this.settings.get('search.ai.enabled', false) === true,
      endpoint: String(this.settings.get('search.ai.endpoint', DEFAULT_ENDPOINT) || '').trim(),
      // An empty box means the one Veil ships with, so clearing it gets the
      // default back rather than turning the feature off by accident.
      gistId: String(this.settings.get('search.ai.gistId', DEFAULT_GIST) || DEFAULT_GIST).trim(),
      model: String(this.settings.get('search.ai.model', DEFAULT_MODEL) || DEFAULT_MODEL).trim()
    };
  }

  /**
   * The address to ask, which may have to be looked up.
   *
   * A pinned endpoint wins: somebody who typed one in means it. Otherwise the
   * gist is read and the first address in it used, and that answer is kept for
   * five minutes so a page of searches is not five reads of GitHub.
   */
  async endpoint() {
    const cfg = this.config;
    if (cfg.endpoint) return { url: cfg.endpoint, from: 'settings' };
    if (!cfg.gistId) return { url: '', from: 'nothing' };

    const fresh = this.cached && this.cached.id === cfg.gistId &&
                  (Date.now() - this.cached.at) < GIST_TTL_MS;
    if (fresh) return { url: this.cached.url, from: 'gist (remembered)' };

    const url = await this.readGist(cfg.gistId);
    if (!url) {
      return { url: '', from: 'gist', error: this.gistError || 'The gist held no address' };
    }

    this.cached = { id: cfg.gistId, url, at: Date.now() };
    return { url, from: 'gist' };
  }

  /**
   * The first address in a gist, whatever else the file says.
   *
   * Tried twice, because the failure that actually happens is a cold first
   * connection rather than a missing gist, and reports why it failed rather
   * than saying the gist was empty when it was never read.
   */
  async readGist(id) {
    this.gistError = '';

    for (let attempt = 1; attempt <= GIST_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GIST_TIMEOUT_MS);
      try {
        const res = await net.fetch(GIST_API + encodeURIComponent(id), {
          signal: controller.signal,
          session: this.session,
          credentials: 'omit',
          // GitHub's API refuses a request with no User-Agent, and refuses it
          // with a 403 that reads like rate limiting rather than like a missing
          // header. The tunnel's own gist lookup has always sent one.
          headers: {
            accept: 'application/vnd.github+json',
            'User-Agent': 'Veil'
          }
        });

        if (!res.ok) {
          this.gistError = res.status === 404
            ? 'No such gist'
            : 'GitHub answered ' + res.status + ' when asked for the gist';
          return '';                       // a real answer; trying again will not help
        }

        const json = await res.json();
        const files = (json && json.files) || {};

        // The file the script writes first, then any other, so a gist written
        // by hand still works and a stale leftover never outranks the current
        // address.
        const named = files[GIST_FILE];
        const ordered = named
          ? [ named, ...Object.entries(files).filter(([n]) => n !== GIST_FILE).map(([, f]) => f) ]
          : Object.values(files);

        for (const file of ordered) {
          const text = String((file && file.content) || '');
          const m = /https?:\/\/[^\s"'<>]+/.exec(text);
          if (m) return m[0].replace(/[.,;]+$/, '');
        }

        this.gistError = 'The gist holds no address';
        return '';
      } catch (e) {
        this.gistError = e && e.name === 'AbortError'
          ? 'GitHub did not answer in time'
          : String((e && e.message) || e);
        // Fall through and try once more: the first connection of a session
        // is slow often enough to be worth a second go.
      } finally {
        clearTimeout(timer);
      }
    }

    console.error('[ai] the gist could not be read: ' + this.gistError);
    return '';
  }

  /** Forget the looked-up address, so the next ask reads the gist again. */
  forgetEndpoint() { this.cached = null; }

  /** Where to POST, given whatever the user typed into the endpoint box. */
  static generateUrl(endpoint) {
    let base = String(endpoint || '').trim();
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    base = base.replace(/\/+$/, '');
    if (/\/api\/generate$/i.test(base)) return base;
    return base + '/api/generate';
  }

  /**
   * Ask, and return { answer, model } - or { answer: '' } for every kind of
   * failure there is. An answer box is a nicety; nothing about a search should
   * break because a model was not reachable.
   */
  async ask(query, context) {
    const cfg = this.config;
    if (!cfg.enabled) return { answer: '', off: true };

    const q = String(query || '').trim();
    if (!q) return { answer: '' };

    const found = await this.endpoint();
    const url = AiAnswer.generateUrl(found.url);
    if (!url) {
      return { answer: '', error: found.error || 'No address is set' };
    }

    const body = JSON.stringify({
      model: cfg.model,
      prompt: buildPrompt(q, Array.isArray(context) ? context : []),
      stream: false,
      options: {
        // Deterministic and short. A search answer should be the same answer
        // twice, and a model allowed to ramble will.
        temperature: 0,
        num_predict: 64
      }
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
        // Through the browsing session, so the tunnel carries this like
        // everything else rather than around it.
        session: this.session,
        credentials: 'omit'
      });

      if (!res.ok) {
        // A remembered address that has stopped working is the ordinary case
        // for a tunnel: it restarted and got a new one. Forget it so the next
        // question reads the gist again.
        this.forgetEndpoint();
        return { answer: '', error: 'The model answered ' + res.status };
      }

      const json = await res.json();
      const answer = tidy(json && json.response);
      return { answer, model: (json && json.model) || cfg.model };
    } catch (e) {
      this.forgetEndpoint();
      const message = e && e.name === 'AbortError'
        ? 'The model did not answer in time'
        : String((e && e.message) || e);
      return { answer: '', error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Is the endpoint there at all? For the button in settings. */
  async test() {
    const cfg = this.config;
    this.forgetEndpoint();                 // a test should check what is there now
    const found = await this.endpoint();
    const url = AiAnswer.generateUrl(found.url);
    if (!url) {
      return { ok: false, detail: found.error || 'No address is set, and no gist to read one from' };
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          prompt: 'Reply with the single word: ready',
          stream: false,
          options: { temperature: 0, num_predict: 8 }
        }),
        signal: controller.signal,
        session: this.session,
        credentials: 'omit'
      });

      if (!res.ok) return { ok: false, detail: 'Answered ' + res.status + ' ' + res.statusText };
      const json = await res.json();
      const took = ((Date.now() - started) / 1000).toFixed(1);
      const where = found.from === 'gist' ? ', address read from the gist' : '';
      return {
        ok: true,
        detail: (json && json.model ? json.model : cfg.model) + ' answered in ' + took + 's' + where
      };
    } catch (e) {
      return {
        ok: false,
        detail: e && e.name === 'AbortError'
          ? 'No answer within ' + (TIMEOUT_MS / 1000) + 's'
          : String((e && e.message) || e)
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { AiAnswer, buildPrompt, tidy, DEFAULT_MODEL, DEFAULT_GIST, GIST_FILE };
