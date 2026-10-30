'use strict';

// Author-name transliteration and persistent override dictionary.
//
// Translating a post body is semantic translation (Google Translate), but an
// author's name is a name: translating "Reborn" to "دوبارہ پیدا ہوا" is wrong;
// it must be phonetically transliterated to "ری بورن".
//
// Precedence:
// 1. If the name is already written in Urdu script, keep it as-is.
// 2. Check the local persistent JSON override dictionary. If an override exists, use it.
// 3. Otherwise, call Google Input Tools (itc=ur-t-i0-und) for phonetic transliteration.
// 4. If Google Input Tools fails or returns unusable output, safely fall back to the
//    original name. Never semantically translate an author's name.

const fs = require('fs');
const path = require('path');
const { userDataRoot } = require('./platform');

const INPUT_TOOLS_ENDPOINT = 'https://inputtools.google.com/request';
const ITC_URDU = 'ur-t-i0-und';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 300;
const MAX_NAME_CHARS = 400;

// Arabic script characters (Urdu, Arabic, Persian blocks)
const ARABIC_SCRIPT_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_LETTER = /[A-Za-z]/;

function isUrduText(text) {
  if (typeof text !== 'string') return false;
  let arabic = 0;
  let latin = 0;
  for (const ch of text) {
    if (ARABIC_SCRIPT_LETTER.test(ch)) arabic++;
    else if (LATIN_LETTER.test(ch)) latin++;
  }
  return arabic > 0 && arabic >= latin;
}

// Normalize a name for dictionary lookup:
// - Unicode normalization (NFC)
// - Collapse runs of whitespace into a single space, trim
// - Lowercase Latin characters for case-insensitive lookup
// Meaningful punctuation and symbols are preserved.
function normalizeName(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeHandle(value) {
  if (value == null) return '';
  const clean = String(value).trim().toLowerCase();
  if (!clean) return '';
  return clean.startsWith('@') ? clean : '@' + clean;
}

function makeNameKey(name) {
  const norm = normalizeName(name);
  return norm ? `name:${norm}` : '';
}

function makeHandleKey(handle) {
  const norm = normalizeHandle(handle);
  return norm ? `handle:${norm}` : '';
}

// --- Persistent JSON Dictionary Store ------------------------------------

class OverridesStore {
  constructor(filePath) {
    this.filePath = filePath || process.env.OVERRIDES_PATH || path.join(userDataRoot(), 'name-overrides.json');
    this._writeQueue = Promise.resolve();
  }

  // Read the dictionary safely. Returns { version: 1, overrides: { ... } }.
  // If the file does not exist, returns an empty dictionary.
  // If corrupted, creates a backup if possible and returns an empty dictionary.
  read() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return { version: 1, overrides: {} };
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw || !raw.trim()) {
        return { version: 1, overrides: {} };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.overrides !== 'object') {
        return { version: 1, overrides: {} };
      }
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        overrides: parsed.overrides || {},
      };
    } catch (e) {
      // Corrupt or unreadable JSON: back it up and recover safely without crashing.
      try {
        if (fs.existsSync(this.filePath)) {
          const bak = `${this.filePath}.corrupt.${Date.now()}`;
          fs.renameSync(this.filePath, bak);
        }
      } catch {}
      return { version: 1, overrides: {} };
    }
  }

  // Atomic write to disk via temporary file + rename.
  // Concurrent writes are serialized via _writeQueue.
  async write(data) {
    const job = async () => {
      const payload = {
        version: (data && data.version) || 1,
        overrides: (data && data.overrides) || {},
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });

      const tmpPath = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      fs.writeFileSync(tmpPath, jsonStr, 'utf8');
      try {
        fs.renameSync(tmpPath, this.filePath);
      } catch (err) {
        // On Windows or across volumes, renameSync can sometimes fail if target is locked; fallback copy+unlink
        try {
          fs.copyFileSync(tmpPath, this.filePath);
          fs.unlinkSync(tmpPath);
        } catch {
          try { fs.unlinkSync(tmpPath); } catch {}
          throw err;
        }
      }
      return payload;
    };

    this._writeQueue = this._writeQueue.then(job, job);
    return this._writeQueue;
  }

  lookup(name, handle) {
    const dict = this.read();
    const overrides = dict.overrides || {};

    // 1. Account-specific handle lookup if handle is provided
    if (handle) {
      const hKey = makeHandleKey(handle);
      if (hKey && overrides[hKey]) {
        return { ...overrides[hKey], key: hKey };
      }
    }

    // 2. Display name lookup
    const nKey = makeNameKey(name);
    if (nKey && overrides[nKey]) {
      return { ...overrides[nKey], key: nKey };
    }

    // 3. Fallback to bare normalized name (backward compatibility with simple schema)
    const rawKey = normalizeName(name);
    if (rawKey && overrides[rawKey]) {
      return { ...overrides[rawKey], key: rawKey };
    }

    return null;
  }

  async setOverride({ original, transliteration, handle, key }) {
    if (typeof original !== 'string' || !original.trim()) {
      throw new Error('invalid-original-name');
    }
    if (typeof transliteration !== 'string' || !transliteration.trim()) {
      throw new Error('invalid-transliteration');
    }

    const dict = this.read();
    const overrides = { ...(dict.overrides || {}) };

    const entry = {
      original: original.trim(),
      transliteration: transliteration.trim(),
      handle: handle ? normalizeHandle(handle) : null,
      updatedAt: new Date().toISOString(),
    };

    // Determine key: explicit key, or handle-specific key, or name key
    const chosenKey = key || (handle ? makeHandleKey(handle) : makeNameKey(original));
    overrides[chosenKey] = entry;

    // If saving with a name key, also maintain bare normalized name for simple schema compatibility
    if (!handle && chosenKey.startsWith('name:')) {
      const bare = normalizeName(original);
      if (bare) overrides[bare] = entry;
    }

    await this.write({ version: dict.version || 1, overrides });
    return { key: chosenKey, ...entry };
  }

  async deleteOverride({ key, original, handle }) {
    const dict = this.read();
    const overrides = { ...(dict.overrides || {}) };
    let removed = false;

    if (key && overrides[key]) {
      delete overrides[key];
      removed = true;
    }

    if (handle) {
      const hKey = makeHandleKey(handle);
      if (overrides[hKey]) {
        delete overrides[hKey];
        removed = true;
      }
    }

    if (original) {
      const nKey = makeNameKey(original);
      if (overrides[nKey]) {
        delete overrides[nKey];
        removed = true;
      }
      const rawKey = normalizeName(original);
      if (overrides[rawKey]) {
        delete overrides[rawKey];
        removed = true;
      }
    }

    if (removed) {
      await this.write({ version: dict.version || 1, overrides });
    }
    return { ok: true, removed };
  }

  getAll() {
    return this.read();
  }
}

// --- Google Input Tools Client -------------------------------------------

function readInputToolsResponse(data) {
  if (!Array.isArray(data) || data[0] !== 'SUCCESS' || !Array.isArray(data[1])) {
    return null;
  }
  const items = data[1];
  if (!items.length) return null;

  // Items contains one or more candidate blocks: [ [word, [cand1, cand2, ...], ...], ... ]
  const pieces = [];
  for (const block of items) {
    if (Array.isArray(block) && Array.isArray(block[1]) && block[1].length > 0) {
      const firstCand = block[1][0];
      if (typeof firstCand === 'string' && firstCand.trim()) {
        pieces.push(firstCand.trim());
      }
    } else if (Array.isArray(block) && typeof block[0] === 'string' && block[0].trim()) {
      pieces.push(block[0].trim());
    }
  }

  return pieces.length ? pieces.join(' ') : null;
}

async function requestInputTools(text, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const timeoutMs = (deps && deps.timeoutMs) || TIMEOUT_MS;
  const url = `${INPUT_TOOLS_ENDPOINT}?text=${encodeURIComponent(text)}&itc=${ITC_URDU}&num=5&cp=0&cs=1&ie=utf-8&oe=utf-8&app=demopage`;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = new Error(`inputtools-http-${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const result = readInputToolsResponse(data);
    if (!result) {
      const err = new Error('inputtools-bad-response');
      err.retryable = false;
      throw err;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function requestInputToolsRetrying(text, deps) {
  try {
    return await requestInputTools(text, deps);
  } catch (e) {
    const status = e && e.status;
    const transient = e && e.retryable !== false
      && (!status || status === 429 || (status >= 500 && status <= 599));
    if (!transient) throw e;
    await new Promise((r) => setTimeout(r, (deps && deps.retryDelayMs) || RETRY_DELAY_MS));
    return requestInputTools(text, deps);
  }
}

// --- Single Transliteration Resolution Pipeline --------------------------

async function resolveTransliteration(name, handle, deps) {
  const store = (deps && deps.store) || defaultStore;

  // 1. Missing or blank author name
  if (name == null || typeof name !== 'string' || !name.trim()) {
    return { ok: true, text: '', source: 'empty', original: '' };
  }

  const original = name.trim();

  // 2. Names already written in Urdu script are kept as-is without re-conversion
  if (isUrduText(original)) {
    return { ok: true, text: original, source: 'original', original, handle: handle || null };
  }

  // 3. Lookup in persistent JSON override dictionary
  const override = store.lookup(original, handle);
  if (override && override.transliteration) {
    return {
      ok: true,
      text: override.transliteration,
      source: 'override',
      original: override.original || original,
      handle: override.handle || handle || null,
      key: override.key,
      updatedAt: override.updatedAt,
    };
  }

  // 4. Query Google Input Tools engine
  try {
    const transliterated = await requestInputToolsRetrying(original, deps);
    if (transliterated && typeof transliterated === 'string' && transliterated.trim()) {
      return {
        ok: true,
        text: transliterated.trim(),
        source: 'inputtools',
        original,
        handle: handle || null,
      };
    }
  } catch (e) {
    // Engine failed, timeout, or bad response
  }

  // 5. Safe fallback: return the original name. NEVER semantically translate.
  return {
    ok: true,
    text: original,
    source: 'fallback',
    original,
    handle: handle || null,
    error: 'transliteration-failed',
  };
}

const defaultStore = new OverridesStore();

module.exports = {
  OverridesStore,
  defaultStore,
  isUrduText,
  normalizeName,
  normalizeHandle,
  makeNameKey,
  makeHandleKey,
  readInputToolsResponse,
  requestInputTools,
  requestInputToolsRetrying,
  resolveTransliteration,
  INPUT_TOOLS_ENDPOINT,
  ITC_URDU,
  MAX_NAME_CHARS,
};
