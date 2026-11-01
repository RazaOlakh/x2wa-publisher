'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  OverridesStore,
  isUrduText,
  normalizeName,
  normalizeHandle,
  makeNameKey,
  makeHandleKey,
  readInputToolsResponse,
  requestInputTools,
  resolveTransliteration,
} = require('../src/transliterate');

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
  console.log('normalization and keys');
  {
    eq('name is lowercased and spaces collapsed', normalizeName('  Imran   Khan  '), 'imran khan');
    eq('name with punctuation preserved', normalizeName('John-Paul (JP)'), 'john-paul (jp)');
    eq('unicode NFC normalization', normalizeName('Ren\u0065\u0301e'), 'renée');
    eq('handle prepends @ if missing and lowercases', normalizeHandle('ElonMusk'), '@elonmusk');
    eq('handle keeps @', normalizeHandle('@elonmusk'), '@elonmusk');
    eq('empty name produces empty key', normalizeName(''), '');
    eq('makeNameKey formats correctly', makeNameKey('Reborn'), 'name:reborn');
    eq('makeHandleKey formats correctly', makeHandleKey('Reborn'), 'handle:@reborn');
  }

  console.log('urdu script detection');
  {
    eq('English name is not Urdu', isUrduText('Imran Khan'), false);
    eq('Reborn is not Urdu', isUrduText('Reborn'), false);
    eq('Urdu name is detected', isUrduText('عمران خان'), true);
    eq('Urdu transliteration is detected', isUrduText('ری بورن'), true);
    eq('Mixed with mostly Urdu is Urdu', isUrduText('عمران خان PTI'), true);
    eq('Empty is not Urdu', isUrduText(''), false);
    eq('Numbers and emoji not Urdu', isUrduText('123 🎉'), false);
  }

  console.log('persistent JSON store - safe init, recovery and atomic write');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-test-'));
  const testFile = path.join(tmpDir, 'name-overrides.json');
  const store = new OverridesStore(testFile);

  {
    eq('missing file yields empty dictionary', store.read(), { version: 1, overrides: {} });
    eq('lookup on empty returns null', store.lookup('Reborn'), null);

    // Write corrupted JSON
    fs.writeFileSync(testFile, '{ corrupted json: not valid ...', 'utf8');
    const recovered = store.read();
    eq('corrupted json recovers safely with empty overrides', recovered, { version: 1, overrides: {} });
    check('corrupted file was backed up', fs.readdirSync(tmpDir).some((f) => f.includes('corrupt')));

    // Set an override
    const saved = await store.setOverride({ original: 'Reborn', transliteration: 'ری بورن' });
    eq('override returned with timestamp and key', saved.original, 'Reborn');
    eq('saved transliteration is accurate', saved.transliteration, 'ری بورن');

    // Read back
    const found = store.lookup('Reborn');
    eq('case-insensitive lookup works', found && found.transliteration, 'ری بورن');
    eq('upper-case lookup works', store.lookup('REBORN').transliteration, 'ری بورن');
    eq('spaced lookup works', store.lookup('  Reborn  ').transliteration, 'ری بورن');

    // Add another override without losing the first
    await store.setOverride({ original: 'Geo News', transliteration: 'جیو نیوز' });
    const all = store.getAll();
    check('first entry still exists', Boolean(store.lookup('Reborn')));
    check('second entry exists', Boolean(store.lookup('Geo News')));

    // Account-specific override distinguishing same display name
    await store.setOverride({ original: 'Alex', transliteration: 'ایلکس نیوز', handle: '@alex_news' });
    await store.setOverride({ original: 'Alex', transliteration: 'ایلکس ٹیک', handle: '@alex_tech' });
    eq('handle @alex_news lookup', store.lookup('Alex', '@alex_news').transliteration, 'ایلکس نیوز');
    eq('handle @alex_tech lookup', store.lookup('Alex', '@alex_tech').transliteration, 'ایلکس ٹیک');

    // Delete override
    await store.deleteOverride({ original: 'Reborn' });
    eq('deleted override is gone', store.lookup('Reborn'), null);
    check('other entries remain after deletion', Boolean(store.lookup('Geo News')));
  }

  console.log('google input tools parser');
  {
    const sample = ['SUCCESS', [['Reborn', ['ریبورن', 'ربورن', 'رےبورن'], [], { candidate_type: [0, 0, 0] }]]];
    eq('reads primary candidate from response', readInputToolsResponse(sample), 'ریبورن');

    const multi = ['SUCCESS', [['Imran', ['عمران']], ['Khan', ['خان']]]];
    eq('joins multi-word candidates', readInputToolsResponse(multi), 'عمران خان');

    eq('malformed data returns null', readInputToolsResponse(['FAILED']), null);
    eq('empty array returns null', readInputToolsResponse([]), null);
    eq('non-array returns null', readInputToolsResponse(null), null);
  }

  console.log('transliteration pipeline resolution');
  {
    // 1. Missing name
    const emptyRes = await resolveTransliteration('', null, { store });
    eq('empty name returns empty string', emptyRes.text, '');
    eq('empty source is empty', emptyRes.source, 'empty');

    // 2. Already Urdu
    const urduRes = await resolveTransliteration('عمران خان', null, { store });
    eq('already Urdu name is preserved', urduRes.text, 'عمران خان');
    eq('already Urdu source is original', urduRes.source, 'original');

    // 3. Saved override in dictionary
    await store.setOverride({ original: 'Reborn', transliteration: 'ری بورن' });
    const overrideRes = await resolveTransliteration('Reborn', null, { store });
    eq('override wins over engine', overrideRes.text, 'ری بورن');
    eq('source is override', overrideRes.source, 'override');

    // 4. Fresh transliteration via mock Input Tools
    const fetchImpl = fakeFetch([{
      json: ['SUCCESS', [['Zubair', ['زبیر']]]],
    }]);
    const freshRes = await resolveTransliteration('Zubair', null, { store, fetchImpl, retryDelayMs: 0 });
    eq('engine result is used', freshRes.text, 'زبیر');
    eq('source is inputtools', freshRes.source, 'inputtools');
    eq('fetch was called with itc=ur-t-i0-und', fetchImpl.calls[0].url.includes('itc=ur-t-i0-und'), true);

    // 5. Engine failure falls back to original name (NEVER semantic translation)
    const failingFetch = fakeFetch([{ throw: new Error('network-down') }, { throw: new Error('network-down') }]);
    const failRes = await resolveTransliteration('Unknown Person', null, { store, fetchImpl: failingFetch, retryDelayMs: 0 });
    eq('engine failure returns original name', failRes.text, 'Unknown Person');
    eq('source is fallback', failRes.source, 'fallback');
  }

  // Cleanup temporary directory
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TRANSLITERATION TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
