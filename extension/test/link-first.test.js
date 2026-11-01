// Link-first tests - zero dependencies.
//
// A post with no media of its own is only its text. When that text carries a
// link, the link moves to the top so the Channel shows the preview above the
// words. These assert the reorder on the text alone, and the guard that keeps
// posts with media (where the text is a caption) untouched.
//
//   node extension/test/link-first.test.js
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
// browser, so load it the same way the page does. Only `window` is touched at
// the top level; everything else it uses lives inside function bodies.
const sandbox = { window: {}, console: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { moveFirstLinkToFront, joinAroundLink, shouldLinkFirst } = sandbox;

console.log('a text-only post puts its link first');
{
  // The user's first example: a link on its own line in the middle.
  eq('a link line in the middle moves to the top',
    moveFirstLinkToFront('Helllo\nexample.com\nhow are your?', ['example.com']),
    'example.com\nHelllo\nhow are your?');
}
{
  // The user's second example: a link on its own line at the end.
  eq('a link line at the end moves to the top',
    moveFirstLinkToFront('Helllo, how are your?\nexample.com', ['example.com']),
    'example.com\nHelllo, how are your?');
}
{
  // A real resolved URL keeps its scheme and path.
  eq('a full URL moves as-is',
    moveFirstLinkToFront('Read this\nhttps://example.com/a/b?c=1\nthanks', ['https://example.com/a/b?c=1']),
    'https://example.com/a/b?c=1\nRead this\nthanks');
}
{
  // A link inside a sentence keeps the sentence on one line.
  eq('an inline link leaves a single space, not two',
    moveFirstLinkToFront('Check out example.com now', ['example.com']),
    'example.com\nCheck out now');
}
{
  eq('a link at the end of a sentence moves cleanly',
    moveFirstLinkToFront('read example.com', ['example.com']),
    'example.com\nread');
}
{
  // Nothing to do: it is already first.
  eq('a link already first is left alone',
    moveFirstLinkToFront('example.com\nHello there', ['example.com']),
    'example.com\nHello there');
}
{
  // The text is unchanged and no URL is present.
  eq('a post whose URL never made it into the text is left alone',
    moveFirstLinkToFront('Hello world', ['nope.example']),
    'Hello world');
}
{
  eq('no urls means no change', moveFirstLinkToFront('Hello world', []), 'Hello world');
  eq('empty text is left alone', moveFirstLinkToFront('', ['example.com']), '');
}
{
  // The first link in the text wins, not the first in the list: the order the
  // links are collected must not decide which one ends up on top.
  eq('the earliest link in the text moves, not the earliest in the list',
    moveFirstLinkToFront('a\nsecond.example\nb\nfirst.example', ['first.example', 'second.example']),
    'second.example\na\nb\nfirst.example');
}
{
  // A link that was appended (it lived only in a preview card) also comes up.
  eq('an appended link comes to the top too',
    moveFirstLinkToFront('Just some words\nexample.com', ['example.com']),
    'example.com\nJust some words');
}
{
  // Blank lines elsewhere in the post are preserved.
  eq('other blank lines are left as they were',
    moveFirstLinkToFront('one\n\nexample.com\n\ntwo', ['example.com']),
    'example.com\none\n\ntwo');
}
{
  // Two links in the text: only the first in the text moves; the other stays
  // where it was.
  eq('only the first link in the text moves, the rest stay put',
    moveFirstLinkToFront('see a.example then b.example', ['a.example', 'b.example']),
    'a.example\nsee then b.example');
}

console.log('\nthe guard: only posts with no media of their own');
{
  check('text only gets the link moved', shouldLinkFirst({ hasImage: false, hasVideo: false }) === true);
  check('a post with an image is left as written', shouldLinkFirst({ hasImage: true, hasVideo: false }) === false);
  check('a post with a video is left as written', shouldLinkFirst({ hasImage: false, hasVideo: true }) === false);
  check('a missing post is not treated as text-only', shouldLinkFirst(undefined) === false);
}

console.log('\nclosing the gap the link leaves behind');
{
  eq('a link alone on a line joins its neighbours with one newline',
    joinAroundLink('Helllo\n', '\nhow are your?'), 'Helllo\nhow are your?');
  eq('a link on the first line leaves no leading blank',
    joinAroundLink('', '\nHelllo'), 'Helllo');
  eq('a link on the last line leaves no trailing blank',
    joinAroundLink('Helllo\n', ''), 'Helllo');
  eq('an inline link keeps a single space',
    joinAroundLink('Check out ', ' now'), 'Check out now');
  eq('an inline link with no space on the right leaves none',
    joinAroundLink('read ', ''), 'read');
  eq('an inline link with no space on the left leaves none',
    joinAroundLink('', ' now'), 'now');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LINK-FIRST TESTS PASSED');
process.exit(failures ? 1 : 0);
