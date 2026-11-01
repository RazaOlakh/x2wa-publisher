// Video-source ambiguity tests - no browser needed.
//
// The rule under test is the one that protects against publishing the wrong
// video: when a post's video cannot be identified with certainty, nothing is
// sent and the item is reported instead.
//
//   node extension/test/video-source.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'extension', 'background', 'video-source.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// The service worker loads this as a classic script, so its function is a
// global rather than an export.
const sandbox = { module: undefined, window: {} };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { inferVideoId } = sandbox;

const HINTS_ONE = { 111: { master: 'https://video.twimg.com/a/pl/1.m3u8' } };
const HINTS_TWO = {
  111: { master: 'https://video.twimg.com/a/pl/1.m3u8' },
  222: { master: 'https://video.twimg.com/a/pl/2.m3u8' },
};
const HINTS_NO_MASTER = { 111: {} };

console.log('an id read from the post is used as-is');
{
  eq('an explicit id is returned even alongside several candidates',
    inferVideoId(999, HINTS_TWO, new Set(), 2), 999);
}

console.log('a missing id is inferred only when it is unambiguous');
{
  eq('one video, one captured manifest -> that manifest',
    inferVideoId(null, HINTS_ONE, new Set(), 1), '111');
}

console.log('an ambiguous mapping is refused rather than guessed');
{
  eq('two captured manifests, one video -> refused',
    inferVideoId(null, HINTS_TWO, new Set(), 1), null);
  eq('two videos, one manifest -> refused',
    inferVideoId(null, HINTS_ONE, new Set(), 2), null);
  eq('no videos -> refused',
    inferVideoId(null, HINTS_ONE, new Set(), 0), null);
  eq('no captured manifests -> refused',
    inferVideoId(null, {}, new Set(), 1), null);
  eq('a candidate with no master is not a candidate',
    inferVideoId(null, HINTS_NO_MASTER, new Set(), 1), null);
}

console.log('a source already used by another item is not reused');
{
  eq('the only candidate already used -> refused',
    inferVideoId(null, HINTS_ONE, new Set(['111']), 1), null);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL VIDEO-SOURCE TESTS PASSED');
process.exit(failures ? 1 : 0);
