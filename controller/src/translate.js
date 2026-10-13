'use strict';

// Translating a post's text for the Channel.
//
// Google's keyless endpoint is used: `translate_a/t` with the browser
// dictionary client. Of Google's public endpoints it is the one that answers a
// plain request with no API key, no consent round-trip and no cookies, and
// returns the translation directly as JSON. A single `q` comes back as
// [[translated, detectedLanguage]]; if the endpoint splits the input it
// returns one such pair per piece, which are joined back together here.
//
// Only the post's text is sent. A URL in the text is left in place by the
// endpoint, so a text-only post's link keeps its place at the top (see the
// content script's link-first rule) and WhatsApp can still build its preview.
//
// The request is made from the controller, not the extension: the controller
// is already the only thing that talks to the outside world for a send, it is
// not bound by a page's origin rules, and the request and its outcome are
// logged in one place. Nothing of the text is logged.

const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const CLIENT = 'dict-chrome-ex';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// One request carries at most this much text.
const MAX_CHUNK = 1600;
const TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 400;

// Nothing to translate: an empty or whitespace-only post stays as it is.
function isTranslatable(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

// Split `text` into pieces no longer than `maxLen`, breaking at whitespace
// where it can (a newline preferred to a space) and mid-text only when a single
// run has no whitespace at all.
//
// A break is kept out of the pieces and returned alongside as a separator, so
// the pieces can be rejoined exactly even though the translator is not trusted
// to keep the whitespace at a piece's very start or end. `chunks[i] + seps[i]`
// for every i reconstructs the original text.
function chunkText(text, maxLen) {
  const size = Math.max(1, maxLen | 0);
  const chunks = [];
  const seps = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      // Look back through the window for a break, but not so early that a
      // piece would be mostly empty. A newline is preferred to a space, and
      // the search may land exactly on the window's edge so the whitespace
      // goes into the separator rather than leading the next piece.
      const min = Math.max(1, Math.floor(size * 0.6));
      let at = -1;
      for (let j = end; j >= i + min; j--) {
        if (text.charAt(j) === '\n') { at = j; break; }
      }
      if (at < 0) {
        for (let j = end; j >= i + min; j--) {
          if (/\s/.test(text.charAt(j))) { at = j; break; }
        }
      }
      if (at > i) {
        let after = at;
        while (after < text.length && /\s/.test(text.charAt(after))) after++;
        chunks.push(text.slice(i, at));
        seps.push(text.slice(at, after));
        i = after;
        continue;
      }
    }
    chunks.push(text.slice(i, end));
    seps.push('');
    i = end;
  }
  return { chunks, seps };
}

// Read the translation out of one response. Accepts the endpoint's shapes:
// [[translated, lang]] (one piece), [[a, lang], [b, lang]] (several pieces) or
// the flat [translated, lang]. Returns null for anything else.
function readTranslation(data) {
  if (typeof data === 'string') return data;
  if (!Array.isArray(data) || data.length === 0) return null;
  if (Array.isArray(data[0])) {
    let out = '';
    for (const piece of data) {
      if (!Array.isArray(piece) || typeof piece[0] !== 'string') return null;
      out += piece[0];
    }
    return out;
  }
  return typeof data[0] === 'string' ? data[0] : null;
}

async function requestChunk(chunk, target, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const url = `${ENDPOINT}?client=${CLIENT}&sl=auto&tl=${encodeURIComponent(target)}`;
  const body = new URLSearchParams();
  body.set('q', chunk);

  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch {} },
    (deps && deps.timeoutMs) || TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error('translate-http-' + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const out = readTranslation(data);
    if (out === null) {
      const err = new Error('translate-bad-response');
      // A body we cannot read is not worth a second request.
      err.retryable = false;
      throw err;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// A transient failure - a timeout, a network error, a rate limit or a server
// fault - is worth one more try; anything else (a bad response, an outright
// refusal) is not, and is surfaced so the send can report it.
async function requestChunkRetrying(chunk, target, deps) {
  try {
    return await requestChunk(chunk, target, deps);
  } catch (e) {
    const status = e && e.status;
    const transient = e && e.retryable !== false
      && (!status || status === 429 || (status >= 500 && status <= 599));
    if (!transient) throw e;
    await new Promise((r) => setTimeout(r, (deps && deps.retryDelayMs) || RETRY_DELAY_MS));
    return requestChunk(chunk, target, deps);
  }
}

// Translate `text` into `target` (default Urdu). Rejects on failure so the
// caller can report it rather than send the original text in the wrong
// language; an empty text resolves to '' without a request.
async function translateText(text, target, deps) {
  if (!isTranslatable(text)) return '';
  const lang = target || 'ur';
  const { chunks, seps } = chunkText(text, (deps && deps.maxChunk) || MAX_CHUNK);
  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    out += await requestChunkRetrying(chunks[i], lang, deps);
    out += seps[i];
  }
  return out;
}

module.exports = {
  translateText,
  chunkText,
  readTranslation,
  isTranslatable,
  MAX_CHUNK,
  ENDPOINT,
};
