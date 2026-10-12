// Screenshot tests - zero dependencies.
//
// Covers the two halves that can be checked without a browser: choosing
// what to capture (the crop), and the controller's handling of the image
// that comes back. Capture itself needs a real Chrome and is verified by
// hand; these assert the decisions either side of it.
//
//   node extension/test/screenshot.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const shotSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'shot.js'), 'utf8');
const { decodeInlineImage, isInlineImage, MAX_INLINE_BYTES } = require(path.join(ROOT, 'controller', 'src', 'inline-media.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// shot.js is a content script, so its functions are globals rather than
// exports in the browser; load it the same way the page does.
const sandbox = { module: undefined, window: {} };
vm.createContext(sandbox);
vm.runInContext(shotSrc, sandbox);
const { shotClip, shotKey, shotCaption, shotErrorHint } = sandbox;

// ------------------------------------------------------- capture targeting
console.log('captures this post alone, in page coordinates');
{
  const clip = shotClip({ left: 99, top: 53, width: 598, height: 736 }, 0, 0, 1200, 4000);
  eq('a post already in view is captured where it is', clip, { x: 99, y: 53, width: 598, height: 736, scale: 1 });
}
{
  // Scrolled down the page: the capture API addresses the document, not the
  // viewport, so the scroll has to be added back in or the wrong part of the
  // page is photographed.
  const clip = shotClip({ left: 12, top: -400, height: 600, width: 500 }, 0, 1200, 1200, 9000);
  eq('scroll is added back to find the post in the document', { x: clip.x, y: clip.y }, { x: 12, y: 800 });
}
{
  const clip = shotClip({ left: -30, top: -30, width: 500, height: 400 }, 0, 0, 1200, 900);
  eq('a negative origin is clamped to the document', { x: clip.x, y: clip.y }, { x: 0, y: 0 });
}
{
  // A post running off the end of the document cannot be captured past it.
  const clip = shotClip({ left: 10, top: 800, width: 400, height: 900 }, 0, 0, 1000, 1000);
  eq('a post past the end of the document is cut to what exists', clip.height, 200);
}
{
  check('a post that is not on screen yields nothing', shotClip({ left: 0, top: 0, width: 0, height: 500 }, 0, 0, 1000, 1000) === null);
  check('a zero-height post yields nothing', shotClip({ left: 0, top: 0, width: 500, height: 0 }, 0, 0, 1000, 1000) === null);
}
{
  // Sub-pixel rects are normal from getBoundingClientRect and must not
  // produce a fractional crop, which the capture API rejects.
  const clip = shotClip({ left: 10.4, top: 20.6, width: 500.5, height: 300.2 }, 0.3, 0.2, 2000, 2000);
  check('fractional rects are rounded to whole pixels',
    [clip.x, clip.y, clip.width, clip.height].every((v) => Number.isInteger(v)), clip);
}
{
  // Two posts on the same page must not produce the same capture.
  const a = shotClip({ left: 0, top: 0, width: 500, height: 200 }, 0, 0, 1000, 2000);
  const b = shotClip({ left: 0, top: 700, width: 500, height: 200 }, 0, 0, 1000, 2000);
  check('two different posts give two different crops', a.y !== b.y, { a: a.y, b: b.y });
}

// ------------------------------------------------------------- duplicate
console.log('a screenshot does not collide with posting the same post');
{
  eq('a screenshot is keyed apart from the post', shotKey('123'), 'shot:123');
  check('the screenshot key differs from the post key', shotKey('123') !== '123');
  eq('a post with no id has no key', shotKey(null), '');
}
{
  // The image already carries the post's text, so the caption is the link.
  eq('the caption is the permalink', shotCaption('https://x.com/a/status/1'), 'https://x.com/a/status/1');
  eq('with no permalink there is no caption', shotCaption(''), '');
}

// ------------------------------------------------------------- messaging
console.log('failures are explained rather than shown as codes');
{
  for (const code of ['capture-unavailable', 'capture-failed', 'capture-too-small', 'no-default-channel']) {
    check(`${code} has a plain-language explanation`, shotErrorHint(code) !== code);
  }
  check('an unknown code still says something', shotErrorHint('something-new').length > 0);
  check('no code at all still says something', shotErrorHint(undefined).length > 0);
  check('devtools is named, since that is the usual cause',
    /Developer Tools/i.test(shotErrorHint('capture-unavailable')));
}

// -------------------------------------------------------- inline transfer
console.log('the captured image survives the trip to the controller');
{
  // A real 1x1 PNG, the smallest thing that can legitimately arrive.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  check('an inline image is recognised', isInlineImage(`data:image/png;base64,${png}`) === true);
  const r = decodeInlineImage(`data:image/png;base64,${png}`);
  check('it decodes', !r.error, r);
  eq('to the right media type', r.type, 'image/png');
  check('to real PNG bytes', r.buffer.length > 0 && r.buffer[0] === 0x89 && r.buffer[1] === 0x50);
}
{
  check('a normal https image is not treated as inline', isInlineImage('https://pbs.twimg.com/x.jpg') === false);
  check('a plain path is not treated as inline', isInlineImage('/tmp/x.png') === false);
}
console.log('a malformed or oversized inline image is rejected, not guessed at');
{
  eq('a non-data source is refused', decodeInlineImage('https://x/y.png').error, 'media-source-invalid');
  eq('base64 that is not base64 is refused', decodeInlineImage('data:image/png;base64,not*base64!').error, 'media-source-invalid');
  eq('an unknown media type is refused', decodeInlineImage('data:image/svg+xml;base64,AAAA').error, 'media-type-unsupported');
  eq('a video data url is refused', decodeInlineImage('data:video/mp4;base64,AAAA').error, 'media-type-unsupported');
  eq('an empty payload is refused', decodeInlineImage('data:image/png;base64,').error, 'media-source-invalid');
  eq('a truncated payload is refused', decodeInlineImage('data:image/png;base64,A').error, 'media-source-invalid');
  // Trailing junk after the payload must not be silently dropped.
  check('trailing junk is refused', decodeInlineImage('data:image/png;base64,AAAA,extra').error === 'media-source-invalid');
  check('a non-base64 data url is refused', decodeInlineImage('data:image/png,raw').error === 'media-source-invalid');
}
{
  // Bounded before decoding, so an oversized payload cannot exhaust memory.
  const huge = 'A'.repeat(Math.ceil(((MAX_INLINE_BYTES + 1024) * 4) / 3) + 4);
  eq('an oversized image is refused', decodeInlineImage(`data:image/png;base64,${huge}`).error, 'media-too-large');
  check('the limit is a sane size', MAX_INLINE_BYTES > 1024 * 1024 && MAX_INLINE_BYTES <= 64 * 1024 * 1024, MAX_INLINE_BYTES);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SCREENSHOT TESTS PASSED');
process.exit(failures ? 1 : 0);