'use strict';

// Transliteration & Optional Review System Scenarios A-I
//
// Tests the end-to-end author name transliteration resolution pipeline,
// persistent dictionary overrides, and optional review popup interface.
//
// Run with:
//   node extension/test/transliteration-review.test.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const {
  OverridesStore,
  resolveTransliteration,
  normalizeName,
  normalizeHandle,
  isUrduText,
} = require('../../controller/src/transliterate');

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
    calls.push({ url: String(url), opts });
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-scenarios-'));
  const testDictPath = path.join(tmpDir, 'name-overrides.json');
  let store = new OverridesStore(testDictPath);

  console.log('\n--- Scenario A: Fresh transliteration & approval ---');
  {
    // Name: Reborn -> Engine returns ری بورن
    const fetchImpl = fakeFetch([{
      json: ['SUCCESS', [['Reborn', ['ری بورن']]]],
    }]);

    const res = await resolveTransliteration('Reborn', '@reborn_user', { store, fetchImpl, retryDelayMs: 0 });
    eq('generated transliteration is used', res.text, 'ری بورن');
    eq('source is inputtools', res.source, 'inputtools');
    eq('fetch was called once', fetchImpl.calls.length, 1);

    // Simulate approval in review interface
    await store.setOverride({ original: res.original, transliteration: res.text, handle: res.handle });

    // Future occurrence uses saved value without transliteration request
    const secondFetch = fakeFetch([]);
    const secondRes = await resolveTransliteration('Reborn', '@reborn_user', { store, fetchImpl: secondFetch });
    eq('future occurrence uses saved override', secondRes.text, 'ری بورن');
    eq('source is override', secondRes.source, 'override');
    eq('no HTTP request was made to engine', secondFetch.calls.length, 0);
  }

  console.log('\n--- Scenario B: Incorrect semantic translation corrected ---');
  {
    // Faulty semantic translation: دوبارہ پیدا ہوا
    // User corrects through review interface to phonetic transliteration: ری بورن
    await store.setOverride({ original: 'Reborn', transliteration: 'ری بورن' });

    // When engine would otherwise return semantic translation, override takes precedence
    const engineWithSemantic = fakeFetch([{
      json: ['SUCCESS', [['Reborn', ['دوبارہ پیدا ہوا']]]],
    }]);

    const res = await resolveTransliteration('Reborn', null, { store, fetchImpl: engineWithSemantic });
    eq('saved phonetic override prevents semantic translation', res.text, 'ری بورن');
    eq('override source is reported', res.source, 'override');
    eq('engine was bypassed completely', engineWithSemantic.calls.length, 0);
  }

  console.log('\n--- Scenario C: No user interaction (optional review) ---');
  {
    // Reset test dictionary
    try { fs.unlinkSync(testDictPath); } catch {}
    store = new OverridesStore(testDictPath);

    const fetchImpl = fakeFetch([{
      json: ['SUCCESS', [['Alex', ['ایلکس']]]],
    }]);

    // Transliterate without approving
    const res = await resolveTransliteration('Alex', null, { store, fetchImpl, retryDelayMs: 0 });
    eq('generated name is returned', res.text, 'ایلکس');
    eq('no permanent override was created', store.lookup('Alex'), null);

    // Dictionary remains empty
    const dict = store.getAll();
    eq('dictionary has no overrides', Object.keys(dict.overrides).length, 0);
  }

  console.log('\n--- Scenario D: Edit and save ---');
  {
    // Engine generates an imperfect spelling, user edits and saves
    const fetchImpl = fakeFetch([{
      json: ['SUCCESS', [['Christopher', ['کرسٹوفر']]]],
    }]);

    const initial = await resolveTransliteration('Christopher', null, { store, fetchImpl, retryDelayMs: 0 });
    eq('initial transliteration generated', initial.text, 'کرسٹوفر');

    // User edits to preferred spelling "کرسٹوفر خان"
    const userCorrection = 'کرسٹوفر خان';
    await store.setOverride({ original: initial.original, transliteration: userCorrection });

    const updated = await resolveTransliteration('Christopher', null, { store });
    eq('corrected spelling persists and is returned', updated.text, userCorrection);
    eq('source is override', updated.source, 'override');
  }

  console.log('\n--- Scenario E: Persistent storage across component restarts ---');
  {
    // Store already has Christopher -> کرسٹوفر خان
    // Simulate application restart by creating a new OverridesStore instance from the same file
    const restartedStore = new OverridesStore(testDictPath);
    const afterRestart = await resolveTransliteration('Christopher', null, { store: restartedStore });
    eq('saved correction remains available after restart', afterRestart.text, 'کرسٹوفر خان');
    eq('source is override after restart', afterRestart.source, 'override');
  }

  console.log('\n--- Scenario F: Missing or corrupted dictionary recovery ---');
  {
    // Corrupt the file
    fs.writeFileSync(testDictPath, 'CORRUPTED NON_JSON DATA {{{', 'utf8');
    const recoveringStore = new OverridesStore(testDictPath);

    // Reading should not throw and should recover gracefully
    const data = recoveringStore.read();
    eq('recovers to empty dictionary', data, { version: 1, overrides: {} });

    // Workflow continues normally
    const fetchImpl = fakeFetch([{
      json: ['SUCCESS', [['TestUser', ['ٹیسٹ یوزر']]]],
    }]);
    const res = await resolveTransliteration('TestUser', null, { store: recoveringStore, fetchImpl, retryDelayMs: 0 });
    eq('workflow continues after corruption', res.text, 'ٹیسٹ یوزر');

    // Saving works after corruption recovery
    await recoveringStore.setOverride({ original: 'TestUser', transliteration: 'ٹیسٹ یوزر' });
    eq('can save after recovery', recoveringStore.lookup('TestUser').transliteration, 'ٹیسٹ یوزر');
  }

  console.log('\n--- Scenario G: API failure and safe fallback ---');
  {
    // Simulate engine network failure or 500 error
    const failingFetch = fakeFetch([
      { throw: new Error('network-timeout') },
      { throw: new Error('network-timeout') },
    ]);

    const res = await resolveTransliteration('Newcomer', null, { store, fetchImpl: failingFetch, retryDelayMs: 0 });
    eq('engine failure falls back to original name', res.text, 'Newcomer');
    eq('source indicates fallback', res.source, 'fallback');
    check('never outputs semantic translation on failure', res.text === 'Newcomer');
  }

  console.log('\n--- Scenario H: Rapid posts and stale results guard ---');
  {
    // Simulate background worker storage guard
    let latestReviewItem = null;
    const storeReview = (item) => {
      if (latestReviewItem && latestReviewItem.timestamp > item.timestamp) {
        return; // Stale async response ignored
      }
      latestReviewItem = item;
    };

    const t0 = 1000;
    const t1 = 2000; // newer post

    // Newer post starts at t1 and finishes
    storeReview({ id: 'op2', original: 'Second Post Author', timestamp: t1, transliteration: 'دوسرا' });

    // Older post started at t0 finishes late
    storeReview({ id: 'op1', original: 'First Post Author', timestamp: t0, transliteration: 'پہلا' });

    eq('newer post wins review item slot', latestReviewItem.original, 'Second Post Author');
    eq('stale result did not overwrite newer', latestReviewItem.id, 'op2');
  }

  console.log('\n--- Scenario I: Matching correctness ---');
  {
    // 1. Case normalization
    await store.setOverride({ original: 'CaseSensitive', transliteration: 'کیس سینسیٹو' });
    eq('exact case matches', store.lookup('CaseSensitive').transliteration, 'کیس سینسیٹو');
    eq('lowercase matches', store.lookup('casesensitive').transliteration, 'کیس سینسیٹو');
    eq('uppercase matches', store.lookup('CASESENSITIVE').transliteration, 'کیس سینسیٹو');

    // 2. Spaces collapsing
    eq('spaced name matches', store.lookup('  CaseSensitive   ').transliteration, 'کیس سینسیٹو');

    // 3. Punctuation preserved
    await store.setOverride({ original: 'A.B.C.', transliteration: 'اے بی سی' });
    await store.setOverride({ original: 'ABC', transliteration: 'اے بی سی الگ' });
    eq('A.B.C. matches distinct from ABC', store.lookup('A.B.C.').transliteration, 'اے بی سی');
    eq('ABC matches distinct from A.B.C.', store.lookup('ABC').transliteration, 'اے بی سی الگ');

    // 4. Unicode normalization (NFC)
    await store.setOverride({ original: 'Renée', transliteration: 'رینے' });
    eq('composed unicode matches', store.lookup('Ren\u0065\u0301e').transliteration, 'رینے');

    // 5. Different accounts sharing display name
    await store.setOverride({ original: 'BBC', handle: '@bbcurdu', transliteration: 'بی بی سی اردو' });
    await store.setOverride({ original: 'BBC', handle: '@bbcworld', transliteration: 'بی بی سی ورلڈ' });
    eq('@bbcurdu override', store.lookup('BBC', '@bbcurdu').transliteration, 'بی بی سی اردو');
    eq('@bbcworld override', store.lookup('BBC', '@bbcworld').transliteration, 'بی بی سی ورلڈ');

    // 6. Names already written in Urdu script
    const urduName = 'عمران خان';
    const urduRes = await resolveTransliteration(urduName, null, { store });
    eq('already Urdu script is preserved directly', urduRes.text, urduName);
    eq('source is original', urduRes.source, 'original');

    // 7. Empty or missing names
    eq('empty name returns empty', (await resolveTransliteration('', null, { store })).text, '');
    eq('null name returns empty', (await resolveTransliteration(null, null, { store })).text, '');
  }

  // Clean up
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TRANSLITERATION SCENARIOS A-I PASSED');
  process.exit(failures ? 1 : 0);
})();
