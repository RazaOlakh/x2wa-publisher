// Author-name tests - zero dependencies.
//
// The second send button is the same post, sent with the author's name above
// it ("Imran Khan's Tweet"). These assert how the name is read out of X's
// User-Name block - without mistaking the @handle, the timestamp, or a quoted
// post's author for it - and how the header is put in front of the text,
// leaving the link-first order beneath intact.
//
//   node extension/test/author-header.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'tweet-extractor.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// tweet-extractor.js is a content script: its functions are globals in the
// browser, so load it the same way the page does.
const sandbox = { window: {}, console: { log() {} }, location: { origin: 'https://x.com' } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { pickAuthorName, authorHeader, withAuthorHeader, isUrduText, findTweetAuthor, extractPost } = sandbox;

// --- the rule, on its own ---
console.log('the display name is the first real name in the User-Name block');
{
  // What X actually renders: name, then @handle, then the time, each an anchor.
  const anchors = [
    { text: 'Arbaz Niazi', href: '/Iam_ArbazRaees' },
    { text: '@Iam_ArbazRaees', href: '/Iam_ArbazRaees' },
    { text: '42m', href: '/Iam_ArbazRaees/status/2109715181408494080' },
  ];
  eq('the name wins', pickAuthorName(anchors), 'Arbaz Niazi');
}
{
  // A wrapped name must not carry a newline into the post's first line.
  eq('a name that wraps is collapsed to one line',
    pickAuthorName([{ text: 'Imran\nKhan', href: '/ImranKhan' }]), 'Imran Khan');
}
{
  // The timestamp link carries a /status/ href; it is skipped even when it is
  // listed before the name, so position never decides the outcome.
  eq('a timestamp anchor is never the name',
    pickAuthorName([
      { text: '2h', href: '/someone/status/9' },
      { text: 'Imran Khan', href: '/ImranKhan' },
    ]), 'Imran Khan');
}
{
  eq('an @handle alone yields no name', pickAuthorName([{ text: '@ImranKhanPTI', href: '/ImranKhanPTI' }]), null);
  eq('no anchors yields no name', pickAuthorName([]), null);
  eq('a missing list yields no name', pickAuthorName(undefined), null);
}

// --- reading it from the post's DOM ---
// A tiny stand-in for the calls findTweetAuthor makes: the User-Name blocks,
// each block's anchors, and closest() for the article / quoted-post checks.
// A block's `article` is set to the article it is pushed into below, so the
// nearest-article check sees the same object findTweetAuthor was handed.
function anchor(text, href) {
  return { innerText: text, textContent: text, getAttribute: (n) => (n === 'href' ? (href || '') : null) };
}
function userBlock(anchors, opts) {
  const o = opts || {};
  return {
    querySelectorAll: (sel) => (sel === 'a' ? anchors : []),
    closest(sel) {
      if (sel === 'article') return o.article || null;
      if (sel === '[data-testid="quoteTweet"]') return o.quote ? {} : null;
      return null;
    },
  };
}
function articleWith(blocks) {
  return { querySelectorAll: (sel) => (sel === '[data-testid="User-Name"]' ? blocks : []) };
}

console.log('\nthe post\'s own author is read, not a quoted post\'s');
{
  const blocks = [];
  const art = articleWith(blocks);
  blocks.push(userBlock([anchor('Imran Khan', '/ImranKhan'), anchor('@ImranKhanPTI', '/ImranKhanPTI')], { article: art }));
  eq('the name comes back', findTweetAuthor(art), 'Imran Khan');
}
{
  const blocks = [];
  const art = articleWith(blocks);
  // A quoted post renders its own name block inside the same article: it must
  // not win over the post's own author.
  blocks.push(userBlock([anchor('Quoted Person', '/quoted')], { article: art, quote: true }));
  blocks.push(userBlock([anchor('Arbaz Niazi', '/Iam_ArbazRaees')], { article: art }));
  eq('a quoted post\'s name block is skipped', findTweetAuthor(art), 'Arbaz Niazi');
}
{
  const blocks = [];
  const art = articleWith(blocks);
  const other = articleWith([]);
  blocks.push(userBlock([anchor('Someone Else', '/else')], { article: other }));
  eq('a block belonging to another article is skipped', findTweetAuthor(art), null);
  eq('a post with no User-Name block has no author', findTweetAuthor(articleWith([])), null);
}

// --- the header line ---
console.log('\nthe header line');
{
  eq('the author\'s name becomes a title', authorHeader('Imran Khan'), "Imran Khan's Tweet");
  eq('surrounding space is trimmed', authorHeader('  Imran Khan  '), "Imran Khan's Tweet");
  eq('no name means no header', authorHeader(''), '');
  eq('a blank name means no header', authorHeader('   '), '');
  eq('a missing name means no header', authorHeader(null), '');
}

// --- the post's language, from its own letters ---
console.log('\nthe post\'s language is read from its letters');
{
  eq('an Urdu post reads as Urdu', isUrduText('یہ بہت اچھی خبر ہے'), true);
  eq('an English post reads as English', isUrduText('This is great news'), false);
  eq('a long Latin link does not turn an Urdu post English',
    isUrduText('یہ بہت اچھی خبر ہے https://t.co/AbCdEfGhIjKlMnOpQr'), true);
  eq('a bare t.co link does not either',
    isUrduText('خبر t.co/AbCdEfGhIjKlMnOpQr'), true);
  eq('a stray Urdu word does not turn an English post Urdu',
    isUrduText('Hello everyone یہ'), false);
  eq('no letters at all reads as English', isUrduText('123 456 🎉'), false);
  eq('empty reads as English', isUrduText(''), false);
  eq('missing text reads as English', isUrduText(null), false);
}

// --- the header follows that language ---
console.log('\nthe header is written in the post\'s language');
{
  eq('English keeps the familiar header', authorHeader('Imran Khan', 'en'), "Imran Khan's Tweet");
  eq('no language still reads as English', authorHeader('Imran Khan'), "Imran Khan's Tweet");
  eq('Urdu heads the post in Urdu', authorHeader('عمران خان', 'ur'), 'عمران خان کی ٹویٹ');
  eq('a missing name has no header in either language', authorHeader('', 'ur'), '');
  eq('the Urdu header goes above the post, link first untouched',
    withAuthorHeader('example.com\nHello', 'عمران خان', 'ur'),
    'عمران خان کی ٹویٹ\n\nexample.com\nHello');
  eq('an English post keeps its English header through the same call',
    withAuthorHeader('Hello there', 'Imran Khan', 'en'), "Imran Khan's Tweet\n\nHello there");
}

// --- putting it in front of the post ---
console.log('\nthe name goes above the post');
{
  eq('the name sits above the text',
    withAuthorHeader('Hello there', 'Imran Khan'), "Imran Khan's Tweet\n\nHello there");
  eq('a post with no text is just the header',
    withAuthorHeader('', 'Imran Khan'), "Imran Khan's Tweet");
  eq('the text is trimmed at the seam only',
    withAuthorHeader('  Hello there  ', 'Imran Khan'), "Imran Khan's Tweet\n\nHello there");
  eq('with no author the text is untouched',
    withAuthorHeader('Hello there', null), 'Hello there');
  eq('a missing text and missing author stays empty', withAuthorHeader('', null), '');
  // The link-first order is arranged before this runs, so the header lands on
  // top of the link, not between it and the words.
  eq('the link stays first, under the name',
    withAuthorHeader('example.com\nHelllo\nhow are your?', 'Imran Khan'),
    "Imran Khan's Tweet\n\nexample.com\nHelllo\nhow are your?");
}

// --- wired into extraction ---
console.log('\nextraction carries the author');
{
  const time = { closest: (sel) => (sel === 'a' ? { href: 'https://x.com/ImranKhan/status/123456' } : null) };
  const art = {
    querySelector(sel) {
      if (sel === 'time') return time;
      if (sel === '[data-testid="tweetText"]') return { innerText: 'Hello world' };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-testid="User-Name"]') {
        return [userBlock([anchor('Imran Khan', '/ImranKhan')], { article: art })];
      }
      return [];
    },
  };
  const post = extractPost(art);
  eq('the extracted post carries the author', post.author, 'Imran Khan');
  eq('and still the rest of the post', { tweetId: post.tweetId, text: post.text }, { tweetId: '123456', text: 'Hello world' });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL AUTHOR-HEADER TESTS PASSED');
process.exit(failures ? 1 : 0);
