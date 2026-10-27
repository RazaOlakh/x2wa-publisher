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
const TRANSLITERATE_ENDPOINT = 'https://inputtools.google.com/request';
const TRANSLITERATE_ITC = 'ur-t-i0-und';
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

// Usernames / @handles inside a post must survive translation as the same
// handle, not be transliterated into unrelated words. The post's text is what
// the post-translate option sends to the translator, so the handles are masked
// to placeholders before the translator sees them and put back exactly as they
// were afterwards. (Issue: do not translate names when using the post translate
// option - names and handles keep their original form.)
const HANDLE_RE = /@([A-Za-z0-9_]{1,24})/g;
const HANDLE_TOKEN_RE = /@h(\d+)/g;

function maskHandles(text) {
  const tokens = [];
  const masked = String(text).replace(HANDLE_RE, (m, handle) => {
    tokens.push(m);
    return `@h${tokens.length - 1}`;
  });
  return { text: masked, tokens };
}

function unmaskHandles(text, tokens) {
  return String(text).replace(HANDLE_TOKEN_RE, (m, i) => (tokens && tokens[Number(i)] !== undefined ? tokens[Number(i)] : m));
}

// Translate `text` into `target` (default Urdu). Rejects on failure so the
// caller can report it rather than send the original text in the wrong
// language; an empty text resolves to '' without a request. Handles are
// masked out of the request and restored on the way back, so a username is
// never translated into some other word.
async function translateText(text, target, deps) {
  if (!isTranslatable(text)) return '';
  const lang = target || 'ur';
  const { text: masked, tokens } = maskHandles(text);
  const { chunks, seps } = chunkText(masked, (deps && deps.maxChunk) || MAX_CHUNK);
  let out = '';
  for (let i = 0; i < chunks.length; i++) {
    out += await requestChunkRetrying(chunks[i], lang, deps);
    out += seps[i];
  }
  return unmaskHandles(out, tokens);
}

function readTransliteration(data, fallback) {
  if (data && data[0] === 'SUCCESS' && Array.isArray(data[1])) {
    const parts = data[1].map((p) => {
      if (p && Array.isArray(p[1]) && typeof p[1][0] === 'string' && p[1][0].trim()) {
        return p[1][0].trim();
      }
      return (p && typeof p[0] === 'string' && p[0].trim()) || '';
    });
    const result = parts.filter(Boolean).join(' ').trim();
    if (result) return result;
  }
  return fallback;
}

function isUrduScript(text) {
  return typeof text === 'string' && /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

async function requestTransliterationChunk(chunk, target, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const itc = (target === 'ur' || !target) ? TRANSLITERATE_ITC : `${target}-t-i0-und`;
  const url = `${TRANSLITERATE_ENDPOINT}?text=${encodeURIComponent(chunk)}&itc=${encodeURIComponent(itc)}&num=1`;

  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch {} },
    (deps && deps.timeoutMs) || TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error('transliterate-http-' + res.status);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return readTransliteration(data, chunk);
  } finally {
    clearTimeout(timer);
  }
}

async function requestTransliterationRetrying(chunk, target, deps) {
  try {
    return await requestTransliterationChunk(chunk, target, deps);
  } catch (e) {
    const status = e && e.status;
    const transient = e && (!status || status === 429 || (status >= 500 && status <= 599));
    if (!transient) return chunk;
    await new Promise((r) => setTimeout(r, (deps && deps.retryDelayMs) || RETRY_DELAY_MS));
    try {
      return await requestTransliterationChunk(chunk, target, deps);
    } catch {
      return chunk;
    }
  }
}

// Phonetically transliterate text into the target script (default Urdu).
// Used for names so words like "Reborn" are written phonetically in Urdu script
// ("ریبورن") rather than being semantically translated into unrelated words
// like "دوبارہ پیدا ہوا".
async function transliterateText(text, target, deps) {
  if (!isTranslatable(text)) return '';
  const trimmed = text.trim();
  if (isUrduScript(trimmed) && !/[A-Za-z]/.test(trimmed)) {
    return trimmed;
  }
  const lang = target || 'ur';
  const { text: masked, tokens } = maskHandles(trimmed);
  try {
    const res = await requestTransliterationRetrying(masked, lang, deps);
    return unmaskHandles(res, tokens);
  } catch {
    return trimmed;
  }
}

// Translate a post's text into the target language (default Urdu).
// If the text starts with an author header (separated by \n\n) or matches `author`,
// the author name is phonetically transliterated into Urdu (e.g. "Reborn" -> "ریبورن")
// rather than being semantically translated into Urdu vocabulary words (like "دوبارہ پیدا ہوا"),
// while the rest of the post text is translated normally.
async function translatePostText(text, target, author, deps) {
  if (!isTranslatable(text)) return '';
  const lang = target || 'ur';
  const sepIdx = text.indexOf('\n\n');
  if (sepIdx > 0) {
    const firstLine = text.slice(0, sepIdx).trim();
    const rest = text.slice(sepIdx + 2);
    const authorMatches = author && typeof author === 'string' &&
      (firstLine.toLowerCase() === author.trim().toLowerCase() || firstLine === author.trim());
    const isUrduAuthorHeader = isUrduScript(firstLine) && !/[A-Za-z]/.test(firstLine);
    if (authorMatches || isUrduAuthorHeader) {
      const transliteratedAuthor = await transliterateText(firstLine, lang, deps);
      const translatedBody = await translateText(rest, lang, deps);
      return transliteratedAuthor + '\n\n' + translatedBody;
    }
  }
  return translateText(text, lang, deps);
}

// The standalone translation request (a short string, e.g. an author's name
// that heads an Urdu post). Validate it here so a stray value can never reshape
// the translate call, whatever the caller sent.
const MAX_REQUEST_CHARS = 400;

function readTranslateRequest(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad-request' };
  const text = body.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_REQUEST_CHARS) return { ok: false, error: 'bad-request' };
  const to = body.to == null ? 'ur' : body.to;
  if (typeof to !== 'string' || to.length === 0 || to.length > 8) return { ok: false, error: 'bad-request' };
  const out = { ok: true, text, to };
  if (body.mode === 'translate' || body.mode === 'transliterate') out.mode = body.mode;
  return out;
}

module.exports = {
  translateText,
  transliterateText,
  translatePostText,
  readTransliteration,
  isUrduScript,
  chunkText,
  readTranslation,
  isTranslatable,
  readTranslateRequest,
  maskHandles,
  unmaskHandles,
  MAX_CHUNK,
  MAX_REQUEST_CHARS,
  ENDPOINT,
  TRANSLITERATE_ENDPOINT,
};
