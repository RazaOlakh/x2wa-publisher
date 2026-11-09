'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { OverridesStore, normalizeHandle, makeHandleKey } = require('../src/transliterate');
const { translatePostTextWithMeta } = require('../src/translate');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) throw new Error('no response prepared');
    if (next.throw) throw next.throw;
    return {
      ok: next.ok !== false,
      status: next.status || 200,
      json: async () => next.json,
      text: async () => next.text || JSON.stringify(next.json),
    };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  console.log('1. OverridesStore author corrections storage & handle normalization');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-corr-test-'));
  const testFile = path.join(tmpDir, 'name-overrides.json');
  const store = new OverridesStore(testFile);

  {
    // Normalization & Key formatting
    eq('handle prefixed with @ and lowercased', normalizeHandle('ElonMusk'), '@elonmusk');
    eq('handle with @ lowercased', normalizeHandle('@ElonMusk'), '@elonmusk');
    eq('handle with spaces trimmed', normalizeHandle('  @alex_news  '), '@alex_news');
    eq('handle key format', makeHandleKey('Alex_News'), 'handle:@alex_news');

    // Saving author correction
    const entry1 = await store.setCorrection({
      handle: 'alex_news',
      urduName: 'ایلکس نیوز سپیشل',
      originalName: 'Alex News',
    });
    eq('saved handle normalized to @alex_news', entry1.handle, '@alex_news');
    eq('saved urduName preserved', entry1.urduName, 'ایلکس نیوز سپیشل');
    eq('saved originalName preserved', entry1.originalName, 'Alex News');
    check('has timestamp', typeof entry1.updatedAt === 'number');

    // Reading correction back
    const lookup1 = store.getCorrection('@alex_news');
    eq('retrieved via @alex_news', lookup1 && lookup1.urduName, 'ایلکس نیوز سپیشل');

    const lookup2 = store.getCorrection('alex_news');
    eq('retrieved without @ prefix', lookup2 && lookup2.urduName, 'ایلکس نیوز سپیشل');

    const lookup3 = store.getCorrection('@ALEX_NEWS');
    eq('retrieved case-insensitively', lookup3 && lookup3.urduName, 'ایلکس نیوز سپیشل');

    // Listing corrections
    const list1 = store.listCorrections();
    eq('list has 1 entry', list1.length, 1);
    eq('list entry handle is @alex_news', list1[0].handle, '@alex_news');

    // Duplicate handle prevention: overwrite instead of adding duplicate
    await store.setCorrection({
      handle: '@alex_news',
      urduName: 'ایلکس نیوز اپڈیٹ',
      originalName: 'Alex News Channel',
    });
    const list2 = store.listCorrections();
    eq('list still has 1 entry after update', list2.length, 1);
    eq('urduName updated', list2[0].urduName, 'ایلکس نیوز اپڈیٹ');
    eq('originalName updated', list2[0].originalName, 'Alex News Channel');

    // Unicode and Urdu script preservation
    const urduNameWithDiacritics = 'مُحَمَّد عِمْرَان';
    await store.setCorrection({
      handle: '@complex_urdu',
      urduName: urduNameWithDiacritics,
      originalName: 'Muhammad Imran',
    });
    const complexLookup = store.getCorrection('@complex_urdu');
    eq('complex Urdu diacritics preserved exactly', complexLookup.urduName, urduNameWithDiacritics);

    // Deleting a correction
    const deleted = await store.deleteCorrection('@alex_news');
    check('deleteCorrection returned true', deleted === true);
    eq('correction is gone', store.getCorrection('@alex_news'), null);
    eq('other corrections remain', store.listCorrections().length, 1);
  }

  console.log('2. Deterministic translation pipeline with author corrections');
  {
    const storePipeline = new OverridesStore(path.join(tmpDir, 'pipeline-overrides.json'));
    await storePipeline.setCorrection({
      handle: '@reborn_x',
      urduName: 'ریبورن خصوصی',
      originalName: 'Reborn Official',
    });

    // Translation with Google fallback: author name matches correction
    const fetchGoogle = fakeFetch([
      // Only body translation call should happen; author transliteration via network is bypassed by correction
      { json: [['یہ ایک ٹیسٹ پوسٹ ہے', 'en']] },
    ]);

    const res1 = await translatePostTextWithMeta(
      'Reborn Official\n\nThis is a test post',
      'ur',
      'Reborn Official',
      { fetchImpl: fetchGoogle, retryDelayMs: 0 },
      { authorHandle: '@reborn_x', store: storePipeline }
    );

    check('Google fallback translation succeeded', res1.text.includes('یہ ایک ٹیسٹ پوسٹ ہے'));
    check('Author header contains corrected Urdu spelling', res1.text.includes('ریبورن خصوصی'));
    check('Dual author header formats correctly', res1.text.includes('ریبورن خصوصی   |   Reborn Official'));
    eq('Metadata translatedAuthor matches correction', res1.translatedAuthor, 'ریبورن خصوصی');
    eq('Metadata authorHandle matches', res1.authorHandle, '@reborn_x');

    // Display name change immunity:
    // If the account changes its display name to "Reborn Breaking News" but handle remains @reborn_x,
    // the saved correction must still apply!
    const fetchGoogle2 = fakeFetch([
      { json: [['ایک اور خبر', 'en']] },
    ]);

    const res2 = await translatePostTextWithMeta(
      'Reborn Breaking News\n\nAnother news item',
      'ur',
      'Reborn Breaking News',
      { fetchImpl: fetchGoogle2, retryDelayMs: 0 },
      { authorHandle: '@reborn_x', store: storePipeline }
    );

    check('Uses saved correction despite changed display name', res2.text.includes('ریبورن خصوصی'));
    check('Dual author uses new English display name with corrected Urdu', res2.text.includes('ریبورن خصوصی   |   Reborn Breaking News'));

    // Tweet body is strictly preserved and not modified by author correction
    check('Body content is translated and separate from header', res2.text.endsWith('\n\nایک اور خبر'));

    // When no correction exists for an author handle, it falls back to standard transliteration
    const fetchGoogle3 = fakeFetch([
      { json: ['SUCCESS', [['Unknown Author', ['نامعلوم مصنف']]]] }, // transliteration
      { json: [['باڈی مواد', 'en']] }, // body
    ]);

    const res3 = await translatePostTextWithMeta(
      'Unknown Author\n\nBody content',
      'ur',
      'Unknown Author',
      { fetchImpl: fetchGoogle3, retryDelayMs: 0 },
      { authorHandle: '@uncorrected_user', store: storePipeline }
    );

    check('Falls back to standard transliteration', res3.text.includes('نامعلوم مصنف'));

    // Groq primary translation path with author correction
    const mockGroqFetch = async (url, opts) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '`Reborn Official`\n\nیہ گروک کا ترجمہ ہے۔',
              },
            },
          ],
        }),
      };
    };

    const resGroq = await translatePostTextWithMeta(
      'Reborn Official\n\nGroq test post',
      'ur',
      'Reborn Official',
      { fetchImpl: mockGroqFetch, retryDelayMs: 0, apiKey: 'gsk_test_key', model: 'openai/gpt-oss-120b' },
      {
        authorHandle: '@reborn_x',
        store: storePipeline,
      }
    );

    check('Groq primary translation succeeded', resGroq.text.includes('یہ گروک کا ترجمہ ہے۔'));
    check('Author header contains corrected Urdu spelling in Groq path', resGroq.text.includes('ریبورن خصوصی'));
    eq('resGroq provider is groq', resGroq.provider, 'groq');
    eq('resGroq translatedAuthor is corrected', resGroq.translatedAuthor, 'ریبورن خصوصی');
  }

  console.log('3. Controller HTTP API endpoint handlers (/author-corrections)');
  {
    const apiStore = new OverridesStore(path.join(tmpDir, 'api-overrides.json'));
    // Setup isolated test HTTP server matching server.js endpoint logic
    const testServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const readBody = () => new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => resolve(d));
      });

      if (req.method === 'GET' && url.pathname === '/author-corrections') {
        const corrections = apiStore.listCorrections();
        return json(200, { ok: true, corrections });
      }

      if (req.method === 'POST' && url.pathname === '/author-corrections') {
        let body;
        try { body = JSON.parse(await readBody()); } catch { return json(400, { ok: false, error: 'bad-request' }); }
        if (!body || typeof body !== 'object') return json(400, { ok: false, error: 'bad-request' });
        const handle = body.handle || body.username || body.authorHandle;
        const urduName = body.urduName || body.transliteration || body.urdu;
        const originalName = body.originalName || body.original || body.author || '';
        if (!handle || typeof handle !== 'string' || !handle.trim()) {
          return json(400, { ok: false, error: 'missing-handle' });
        }
        if (!urduName || typeof urduName !== 'string' || !urduName.trim()) {
          return json(400, { ok: false, error: 'missing-urdu-name' });
        }
        const entry = await apiStore.setCorrection({ handle, urduName, originalName });
        return json(200, { ok: true, count: apiStore.listCorrections().length, correction: entry });
      }

      if (req.method === 'DELETE' && url.pathname === '/author-corrections') {
        let body = {};
        try {
          const raw = await readBody();
          if (raw && raw.trim()) body = JSON.parse(raw);
        } catch {}
        const handle = body.handle || body.username || url.searchParams.get('handle');
        if (!handle) return json(400, { ok: false, error: 'missing-handle' });
        const removed = await apiStore.deleteCorrection(handle);
        return json(200, { ok: true, deleted: removed, count: apiStore.listCorrections().length });
      }

      json(404, { error: 'not-found' });
    });

    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const port = testServer.address().port;
    const base = `http://127.0.0.1:${port}`;

    const apiReq = async (method, pathUrl, body) => {
      const payload = body ? JSON.stringify(body) : null;
      return new Promise((resolve, reject) => {
        const req = http.request(`${base}${pathUrl}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: JSON.parse(data) });
            } catch {
              resolve({ statusCode: res.statusCode, ok: false, body: data });
            }
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    };

    // GET /author-corrections initially empty
    const r1 = await apiReq('GET', '/author-corrections');
    check('GET /author-corrections ok', r1.ok);
    eq('initial list empty', r1.body.corrections, []);

    // POST /author-corrections validations
    const rErr1 = await apiReq('POST', '/author-corrections', { handle: '' });
    check('POST without handle rejected', !rErr1.ok);
    eq('error message for missing handle', rErr1.body.error, 'missing-handle');

    const rErr2 = await apiReq('POST', '/author-corrections', { handle: '@valid', urduName: '' });
    check('POST without urduName rejected', !rErr2.ok);
    eq('error message for missing urduName', rErr2.body.error, 'missing-urdu-name');

    // POST /author-corrections valid
    const r2 = await apiReq('POST', '/author-corrections', {
      handle: '@test_user',
      urduName: 'ٹیسٹ صارف',
      originalName: 'Test User',
    });
    check('POST /author-corrections ok', r2.ok);
    eq('saved count is 1', r2.body.count, 1);
    eq('saved handle normalized', r2.body.correction.handle, '@test_user');
    eq('saved urduName matches', r2.body.correction.urduName, 'ٹیسٹ صارف');

    // GET /author-corrections reflects saved entry
    const r3 = await apiReq('GET', '/author-corrections');
    check('GET has 1 correction', r3.body.corrections.length === 1);
    eq('retrieved handle', r3.body.corrections[0].handle, '@test_user');
    eq('retrieved urduName', r3.body.corrections[0].urduName, 'ٹیسٹ صارف');

    // DELETE /author-corrections
    const r4 = await apiReq('DELETE', '/author-corrections', { handle: 'test_user' });
    check('DELETE ok', r4.ok);
    check('deleted true', r4.body.deleted === true);
    eq('remaining count 0', r4.body.count, 0);

    // GET again confirms empty
    const r5 = await apiReq('GET', '/author-corrections');
    eq('list empty after delete', r5.body.corrections.length, 0);

    testServer.close();
  }

  // Cleanup tmp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nALL AUTHOR CORRECTIONS TESTS PASSED');
  }
})();
