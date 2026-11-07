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

const { translateWithGroq, isGroqConfigured, getGroqConfig, formatModelDisplayName } = require('./groq');

function getLogger(deps) {
  if (deps && typeof deps.log === 'function') return deps.log;
  return (level, event, data) => {
    const rec = { ts: new Date().toISOString(), level, component: 'translate', event, ...(data || {}) };
    try { console.log(JSON.stringify(rec)); } catch {}
  };
}

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
const HANDLE_TOKEN_RE = /@\s*h(\d+)/gi;

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

// Translate `text` into `target` (default Urdu).
// Primary engine: Qwen 3.8 27B on Groq for Urdu translation.
// Fallback engine: Keyless Google Translate endpoint.
// Handles are masked out of the request and restored on the way back, so a username is
// never translated into some other word. If `deps.pure === true`, masks and splits are bypassed
// to provide a pure, unmodified translation.
async function translateTextWithMeta(text, target, deps) {
  if (!isTranslatable(text)) return { text: '', provider: 'none', model: null };
  const lang = target || 'ur';
  const log = getLogger(deps);
  const isPure = Boolean(deps && deps.pure);
  const author = deps && deps.author ? sanitizeAuthorDisplayName(deps.author) : null;

  // 1. Primary path: Groq (GPT-OSS 120B / Qwen 3.8 27B) for Urdu translation
  const disableGroq = deps && deps.disableGroq === true;
  const isUrdu = lang === 'ur';
  if (isUrdu && !disableGroq) {
    const configured = isGroqConfigured(deps && deps.env, deps);
    if (!configured) {
      log('info', 'translate-groq-skipped', { reason: 'no-api-key', fallback: 'google' });
    } else {
      const cfg = getGroqConfig(deps && deps.env, deps);
      const chosenModel = (deps && deps.model) || cfg.model;
      log('info', 'translate-groq-start', { model: chosenModel, charsIn: text.length, author: author || undefined });
      const t0 = Date.now();
      try {
        // Groq receives unmasked pure text naturally as LLM understands handles & author natively
        const groqRes = await translateWithGroq(text, {
          target: lang,
          model: chosenModel,
          pure: isPure,
          author,
        }, deps);
        if (groqRes && typeof groqRes.text === 'string' && groqRes.text.trim().length > 0) {
          const out = groqRes.text;
          log('info', 'translate-groq-done', {
            provider: 'groq',
            model: groqRes.model,
            charsIn: text.length,
            charsOut: out.length,
            ms: Date.now() - t0,
          });
          return {
            text: out,
            provider: 'groq',
            model: groqRes.model,
            reasoning: groqRes.reasoning || null,
            durationMs: groqRes.durationMs || (Date.now() - t0),
          };
        }
        throw new Error('groq-empty-response');
      } catch (e) {
        log('warn', 'translate-groq-failed', {
          provider: 'groq',
          model: chosenModel,
          error: (e && e.message) || String(e),
          status: e && e.status,
          fallback: 'google',
        });
      }
    }
  }

  // 2. Fallback path: Google Translate (or primary for non-Urdu targets)
  const t0 = Date.now();
  const { text: googleMasked, tokens: googleTokens } = isPure ? { text, tokens: [] } : maskHandles(text);
  const inputToChunk = googleMasked;
  const { chunks, seps } = chunkText(inputToChunk, (deps && deps.maxChunk) || MAX_CHUNK);
  let googleOut = '';
  for (let i = 0; i < chunks.length; i++) {
    googleOut += await requestChunkRetrying(chunks[i], lang, deps);
    googleOut += seps[i];
  }
  const out = isPure ? googleOut : unmaskHandles(googleOut, googleTokens);
  log('info', 'translate-google-done', {
    provider: 'google',
    target: lang,
    charsIn: text.length,
    charsOut: out.length,
    ms: Date.now() - t0,
  });
  return {
    text: out,
    provider: 'google',
    model: null,
    reasoning: null,
    durationMs: Date.now() - t0,
  };
}

async function translateText(text, target, deps) {
  const res = await translateTextWithMeta(text, target, deps);
  return res.text;
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
  const store = (deps && deps.store) || (function() {
    try { return require('./transliterate').defaultStore; } catch { return null; }
  })();
  if (store) {
    const override = store.lookup(trimmed);
    if (override && override.transliteration) return override.transliteration;
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
// When translating with AI (Groq), the author display name is specified to the AI model
// and translated naturally along with the post text in one pure AI translation step.
// Mechanical transliteration is completely bypassed in favor of natural LLM translation.
async function translatePostTextWithMeta(text, target, author, deps) {
  if (!isTranslatable(text)) return { text: '', provider: 'none', model: null };
  const lang = target || 'ur';
  let bodyText = text;
  let rawAuthor = author && typeof author === 'string' ? author.trim() : '';

  const sepIdx = text.indexOf('\n\n');
  if (sepIdx > 0) {
    const firstLine = text.slice(0, sepIdx).trim();
    const rest = text.slice(sepIdx + 2).trim();
    const cleanFirst = firstLine.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
    const authorMatches = rawAuthor && (cleanFirst.toLowerCase() === rawAuthor.toLowerCase() || cleanFirst === rawAuthor);
    const isUrduAuthorHeader = isUrduScript(cleanFirst) && !/[A-Za-z]/.test(cleanFirst);
    if (isUrduAuthorHeader) {
      rawAuthor = cleanFirst;
      bodyText = rest;
    } else if (authorMatches || (!rawAuthor && cleanFirst.length <= 60 && !cleanFirst.includes('\n'))) {
      if (!rawAuthor) rawAuthor = cleanFirst;
      bodyText = rest;
    }
  }

  const cleanAuthor = sanitizeAuthorDisplayName(rawAuthor);

  // If Groq is configured and active for Urdu, execute pure AI translation with author specified:
  const isUrdu = lang === 'ur';
  const disableGroq = deps && deps.disableGroq === true;
  if (isUrdu && !disableGroq && isGroqConfigured(deps && deps.env, deps)) {
    return translateTextWithMeta(bodyText, lang, {
      ...(deps || {}),
      author: cleanAuthor || undefined,
      pure: true,
    });
  }

  // Fallback path: Google Translate (when Groq is unconfigured or disabled)
  if (cleanAuthor) {
    const transliteratedAuthor = await transliterateText(cleanAuthor, lang, deps);
    const cleanTrans = (transliteratedAuthor || cleanAuthor).replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
    const bodyRes = await translateTextWithMeta(bodyText, lang, deps);
    const authorLine = (lang === 'ur') ? `\u200F\`${cleanTrans}\`\u200F` : `\u200E\`${cleanTrans}\`\u200E`;
    return {
      text: `${authorLine}\n\n${bodyRes.text}`,
      provider: bodyRes.provider,
      model: bodyRes.model,
      authorTransliterated: true,
    };
  }
  return translateTextWithMeta(bodyText, lang, deps);
}

async function translatePostText(text, target, author, deps) {
  const res = await translatePostTextWithMeta(text, target, author, deps);
  return res.text;
}

function sanitizeAuthorDisplayName(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\s*\(@?[A-Za-z0-9_]+\)/g, '')
    .replace(/\s*@[A-Za-z0-9_]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function compareTranslations(text, options = {}, deps = {}) {
  if (!isTranslatable(text)) {
    return { ok: false, error: 'empty-text', results: [] };
  }
  let cleanText = text.trim();
  const rawAuthor = options && options.author && typeof options.author === 'string' ? options.author : '';
  const author = sanitizeAuthorDisplayName(rawAuthor);
  if (author && cleanText.toLowerCase().startsWith(author.toLowerCase())) {
    cleanText = cleanText.slice(author.length).replace(/^[:\s\n]+/, '').trim();
  }
  const requestedModels = options && Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : [
        'openai/gpt-oss-120b',
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-20b',
        'allam-2-7b',
        'google',
      ];
  const isPure = options.pure !== false;

  const promises = requestedModels.map(async (modelId) => {
    const t0 = Date.now();
    if (modelId === 'google') {
      try {
        const res = await translatePostTextWithMeta(cleanText, 'ur', author, {
          ...(deps || {}),
          disableGroq: true,
          pure: isPure,
        });
        return {
          model: 'google',
          modelName: 'Google Translate',
          provider: 'google',
          text: res.text,
          reasoning: null,
          durationMs: Date.now() - t0,
          ok: true,
        };
      } catch (e) {
        return {
          model: 'google',
          modelName: 'Google Translate',
          provider: 'google',
          error: (e && e.message) || String(e),
          durationMs: Date.now() - t0,
          ok: false,
        };
      }
    }

    try {
      const groqRes = await translateWithGroq(cleanText, {
        model: modelId,
        pure: isPure,
        author: author || undefined,
        temperature: options.temperature || 0.2,
      }, deps);
      return {
        model: modelId,
        modelName: formatModelDisplayName(modelId),
        provider: 'groq',
        text: groqRes.text,
        reasoning: groqRes.reasoning || null,
        durationMs: groqRes.durationMs || (Date.now() - t0),
        ok: true,
      };
    } catch (e) {
      return {
        model: modelId,
        modelName: formatModelDisplayName(modelId),
        provider: 'groq',
        error: (e && e.message) || String(e),
        durationMs: Date.now() - t0,
        ok: false,
      };
    }
  });

  const results = await Promise.all(promises);
  return {
    ok: true,
    original: author ? `${author}:\n${cleanText}` : cleanText,
    pure: isPure,
    results,
  };
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
  translateTextWithMeta,
  transliterateText,
  translatePostText,
  translatePostTextWithMeta,
  compareTranslations,
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
