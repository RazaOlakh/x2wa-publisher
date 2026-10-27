// Translation tests - no network, no WhatsApp.
//
// The "post in Urdu" button has the controller translate the post's text with
// Google's keyless endpoint before it is sent. These assert the split (so a
// long post survives being sent in pieces), the reading of the endpoint's
// several response shapes, and the request itself - made as a POST, addressed
// to the chosen language, retried once on a transient fault and surfaced on a
// real one.
//
//   node controller/test/translate.test.js
const {
  translateText, chunkText, readTranslation, isTranslatable, readTranslateRequest, MAX_CHUNK, ENDPOINT,
  maskHandles, unmaskHandles, transliterateText, translatePostText, readTransliteration, isUrduScript,
} = require('../src/translate');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// A fetch stand-in that records each call and answers from a queue. A queued
// Error is thrown; anything else is treated as a Response with ok/status/json.
function fakeFetch(queue) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('fake-fetch-exhausted');
    const status = next.status == null ? 200 : next.status;
    return {
      ok: next.ok == null ? status < 400 : next.ok,
      status,
      json: async () => next.json,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function rebuild({ chunks, seps }) {
  let out = '';
  for (let i = 0; i < chunks.length; i++) out += chunks[i] + seps[i];
  return out;
}

// --- what is worth a request ---
console.log('only real text is translated');
{
  check('an ordinary post', isTranslatable('Hello there') === true);
  check('an empty string', isTranslatable('') === false);
  check('whitespace only', isTranslatable('   \n  ') === false);
  check('not a string', isTranslatable(undefined) === false);
}

// --- reading the endpoint's answer ---
console.log('the endpoint\'s several shapes are read');
{
  eq('one piece', readTranslation([['ہیلو', 'en']]), 'ہیلو');
  eq('several pieces are joined back',
    readTranslation([['ایک ', 'en'], ['دو', 'en']]), 'ایک دو');
  eq('the flat shape', readTranslation(['ہیلو', 'en']), 'ہیلو');
  eq('a bare string', readTranslation('ہیلو'), 'ہیلو');
  eq('nothing', readTranslation([]), null);
  eq('not an array', readTranslation({ oops: true }), null);
  eq('a malformed piece', readTranslation([['a', 'en'], 7]), null);
}

// --- splitting a long post ---
console.log('a long post is split without losing a character');
{
  // The pieces plus their separators must rebuild the original exactly, so a
  // post that had to be split is never quietly changed.
  const samples = [
    'short',
    'a'.repeat(5000),
    'word '.repeat(500),
    'line one\nline two\n\nline three\n' + 'x'.repeat(3000),
    '\n\nleading blanks and ' + 'y '.repeat(2000),
    'a'.repeat(20) + '\n' + 'b'.repeat(4000) + ' ' + 'c'.repeat(4000),
  ];
  for (const s of samples) {
    const split = chunkText(s, MAX_CHUNK);
    eq(`rebuilt exactly (len ${s.length})`, rebuild(split), s);
    check(`no piece exceeds the limit (len ${s.length})`,
      split.chunks.every((c) => c.length <= MAX_CHUNK), split.chunks.map((c) => c.length));
  }
}
{
  // A newline is a better break than a space, and it is preferred.
  const text = 'aaaaaaaaaa\nbbbbbbbbbb cccccccccc';
  const split = chunkText(text, 16);
  eq('the first piece breaks at the newline', split.chunks[0], 'aaaaaaaaaa');
  eq('the newline is kept as the separator', split.seps[0], '\n');
}
{
  // With no newline, a space is used and kept out of the pieces.
  const split = chunkText('aaaaaaaaaa bbbbbbbbbb', 12);
  eq('the first piece breaks at the space', split.chunks[0], 'aaaaaaaaaa');
  eq('the space is the separator', split.seps[0], ' ');
  eq('the rest is the second piece', split.chunks[1], 'bbbbbbbbbb');
}
{
  // A run with no whitespace at all has to be cut mid-text, with no separator.
  const split = chunkText('z'.repeat(30), 10);
  eq('cut into window-sized pieces', split.chunks.map((c) => c.length), [10, 10, 10]);
  eq('with nothing to put back', split.seps, ['', '', '']);
  eq('and still exact', rebuild(split), 'z'.repeat(30));
}
{
  // Text that fits is a single piece with no separator: the common case
  // passes the translator's own output straight through.
  const split = chunkText('Hello there', MAX_CHUNK);
  eq('one piece', split.chunks, ['Hello there']);
  eq('nothing to rejoin', split.seps, ['']);
}

// --- the request ---
console.log('the translation request');
(async () => {
  {
    const fetchImpl = fakeFetch([{ json: [['ہیلو دنیا', 'en']] }]);
    const out = await translateText('Hello world', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('the translation comes back', out, 'ہیلو دنیا');
    eq('one request was made', fetchImpl.calls.length, 1);
    const { url, opts } = fetchImpl.calls[0];
    check('it is a POST', opts.method === 'POST');
    check('to the keyless endpoint', url.startsWith(ENDPOINT));
    check('asked for the chosen language', /[?&]tl=ur(?:&|$)/.test(url), url);
    check('with the language detected', /[?&]sl=auto(?:&|$)/.test(url), url);
    check('and the text as the body', opts.body === 'q=' + encodeURIComponent('Hello world').replace(/%20/g, '+'), opts.body);
  }
  {
    // Each piece is one request; the separators are put back between them.
    const fetchImpl = fakeFetch([{ json: [['A', 'en']] }, { json: [['B', 'en']] }]);
    const out = await translateText('one two', 'ur', { fetchImpl, retryDelayMs: 0, maxChunk: 4 });
    eq('both requests were made', fetchImpl.calls.length, 2);
    eq('the separator is restored', out, 'A B');
  }
  {
    // Nothing to translate is no request at all.
    const fetchImpl = fakeFetch([{ json: [['x', 'en']] }]);
    eq('empty text resolves empty', await translateText('', 'ur', { fetchImpl }), '');
    eq('and made no request', fetchImpl.calls.length, 0);
  }
  {
    // A transient status is retried once, then succeeds.
    const fetchImpl = fakeFetch([{ status: 429, json: null }, { json: [['ٹھیک', 'en']] }]);
    const out = await translateText('okay', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('the retry came back', out, 'ٹھیک');
    eq('it took two attempts', fetchImpl.calls.length, 2);
  }
  {
    // A network error with no status is transient too.
    const fetchImpl = fakeFetch([new Error('socket hang up'), { json: [['دوبارہ', 'en']] }]);
    const out = await translateText('again', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('the retry came back', out, 'دوبارہ');
  }
  {
    // A real refusal is not retried, and is raised so the send can report it.
    const fetchImpl = fakeFetch([{ status: 400, json: null }]);
    let err = null;
    try { await translateText('nope', 'ur', { fetchImpl, retryDelayMs: 0 }); } catch (e) { err = e; }
    check('it throws', !!err);
    eq('naming the refusal', err && err.message, 'translate-http-400');
    eq('and is not retried', fetchImpl.calls.length, 1);
  }
  {
    // An unreadable body is not transient: one request, and it is reported.
    const fetchImpl = fakeFetch([{ json: { not: 'an array' } }, { json: { not: 'an array' } }]);
    let err = null;
    try { await translateText('huh', 'ur', { fetchImpl, retryDelayMs: 0 }); } catch (e) { err = e; }
    eq('a bad response is reported', err && err.message, 'translate-bad-response');
    eq('and is not retried', fetchImpl.calls.length, 1);
  }
  {
    // The default language is Urdu when none is given.
    const fetchImpl = fakeFetch([{ json: [['ہاں', 'en']] }]);
    await translateText('yes', undefined, { fetchImpl, retryDelayMs: 0 });
    check('urdue by default', /[?&]tl=ur(?:&|$)/.test(fetchImpl.calls[0].url), fetchImpl.calls[0].url);
  }

  // The standalone request (a short string, e.g. the author's name that heads
  // an Urdu post) is validated before it ever reaches the endpoint.
  console.log('a standalone translate request is validated');
  {
    eq('a plain request passes, Urdu by default', readTranslateRequest({ text: 'Imran Khan' }), { ok: true, text: 'Imran Khan', to: 'ur' });
    eq('a chosen language is kept', readTranslateRequest({ text: 'x', to: 'ar' }), { ok: true, text: 'x', to: 'ar' });
    eq('missing text is refused', readTranslateRequest({}), { ok: false, error: 'bad-request' });
    eq('a non-string text is refused', readTranslateRequest({ text: 5 }), { ok: false, error: 'bad-request' });
    eq('an empty text is refused', readTranslateRequest({ text: '' }), { ok: false, error: 'bad-request' });
    eq('an over-long text is refused', readTranslateRequest({ text: 'x'.repeat(5000) }).ok, false);
    eq('a long language code is refused', readTranslateRequest({ text: 'x', to: 'not-a-lang' }), { ok: false, error: 'bad-request' });
    eq('a non-string language is refused', readTranslateRequest({ text: 'x', to: 7 }), { ok: false, error: 'bad-request' });
    eq('a non-object body is refused', readTranslateRequest(null), { ok: false, error: 'bad-request' });
  }

  console.log('handles are shielded, never translated');
  {
    eq('an @handle is masked to a placeholder', maskHandles('hi @elonmusk there'), { text: 'hi @h0 there', tokens: ['@elonmusk'] });
    eq('several handles keep their order', maskHandles('@a and @b'), { text: '@h0 and @h1', tokens: ['@a', '@b'] });
    eq('a name with no handle is untouched', maskHandles('Imran Khan'), { text: 'Imran Khan', tokens: [] });
    eq('the masked text round-trips back', unmaskHandles('hi @h0 there', ['@elonmusk']), 'hi @elonmusk there');
    eq('a missing token keeps the placeholder', unmaskHandles('hi @h9 there', ['@elonmusk']), 'hi @h9 there');
  }
  {
    const fetchImpl = fakeFetch([{ json: [['ہیلو @h0', 'en']] }]);
    const out = await translateText('Hello @elonmusk', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('the handle is restored after translation', out, 'ہیلو @elonmusk');
    check('the translator saw the masked handle', decodeURIComponent(String(fetchImpl.calls[0].opts.body).split('q=')[1] || '').includes('@h0'), String(fetchImpl.calls[0].opts.body));
  }

  console.log('transliteration reads candidates from Google Input Tools');
  {
    eq('single token transliteration is parsed', readTransliteration(['SUCCESS', [['Reborn', ['ریبورن']]]], 'Reborn'), 'ریبورن');
    eq('multi token transliteration is joined', readTransliteration(['SUCCESS', [['Elon', ['ایلون']], ['Musk', ['مسک']]]], 'Elon Musk'), 'ایلون مسک');
    eq('candidate with spaces is preserved', readTransliteration(['SUCCESS', [['Elon Musk', ['الوں مسک']]]], 'Elon Musk'), 'الوں مسک');
    eq('failed response returns fallback', readTransliteration(['FAILED', []], 'fallback'), 'fallback');
    eq('null response returns fallback', readTransliteration(null, 'fallback'), 'fallback');
  }

  console.log('Urdu script detection');
  {
    eq('Urdu text is detected', isUrduScript('عمران خان'), true);
    eq('transliterated Urdu word is detected', isUrduScript('ریبورن'), true);
    eq('Latin text is not Urdu', isUrduScript('Reborn'), false);
    eq('Latin sentence is not Urdu', isUrduScript('Hello world'), false);
  }

  console.log('transliterateText phonetically transliterates names');
  {
    const fetchImpl = fakeFetch([{ json: ['SUCCESS', [['Reborn', ['ریبورن']]]] }]);
    const out = await transliterateText('Reborn', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('Reborn transliterates to phonetic Urdu script', out, 'ریبورن');
    check('requested ur-t-i0-und input tools endpoint', fetchImpl.calls[0].url.includes('itc=ur-t-i0-und'), fetchImpl.calls[0].url);
  }
  {
    // Already in Urdu script: no fetch needed
    const fetchImpl = fakeFetch([]);
    const out = await transliterateText('عمران خان', 'ur', { fetchImpl });
    eq('Urdu name is returned as-is without network call', out, 'عمران خان');
    eq('no fetch was made for Urdu text', fetchImpl.calls.length, 0);
  }
  {
    // Handles inside names are shielded
    const fetchImpl = fakeFetch([{ json: ['SUCCESS', [['Reborn @h0', ['ریبورن @h0']]]] }]);
    const out = await transliterateText('Reborn @reborn', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('handle is preserved during transliteration', out, 'ریبورن @reborn');
  }
  {
    // Failure fallback returns original
    const fetchImpl = fakeFetch([{ status: 500, ok: false }, { status: 500, ok: false }]);
    const out = await transliterateText('Reborn', 'ur', { fetchImpl, retryDelayMs: 0 });
    eq('transliteration failure falls back gracefully to raw text', out, 'Reborn');
  }
  {
    eq('empty text returns empty', await transliterateText(''), '');
    eq('whitespace only returns empty', await transliterateText('   '), '');
  }

  console.log('translatePostText handles author headers and post body');
  {
    // First call to fetch is for transliterating the author (Input Tools),
    // second call is for translating the post body (Translate API).
    const fetchImpl = fakeFetch([
      { json: ['SUCCESS', [['Reborn', ['ریبورن']]]] },
      { json: [['ہیلو دنیا', 'en']] },
    ]);
    const out = await translatePostText('Reborn\n\nHello world', 'ur', 'Reborn', { fetchImpl, retryDelayMs: 0 });
    eq('author header is transliterated and body translated', out, 'ریبورن\n\nہیلو دنیا');
  }
  {
    // Already Urdu author header is not re-translated or corrupted
    const fetchImpl = fakeFetch([
      { json: [['ہیلو دنیا', 'en']] },
    ]);
    const out = await translatePostText('ریبورن\n\nHello world', 'ur', 'Reborn', { fetchImpl, retryDelayMs: 0 });
    eq('already-Urdu author header is preserved and body translated', out, 'ریبورن\n\nہیلو دنیا');
  }
  {
    // Post without author header translates body normally
    const fetchImpl = fakeFetch([
      { json: [['ہیلو دنیا', 'en']] },
    ]);
    const out = await translatePostText('Hello world', 'ur', null, { fetchImpl, retryDelayMs: 0 });
    eq('plain post without author header translates normally', out, 'ہیلو دنیا');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TRANSLATE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
