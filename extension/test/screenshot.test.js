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
const clipSrc = fs.readFileSync(path.join(ROOT, 'extension', 'shared', 'clip.js'), 'utf8');
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
// exports in the browser; load it the same way the page does, with the shared
// clip geometry loaded first because it loads first in the manifest.
const sandbox = { module: undefined, window: {} };
vm.createContext(sandbox);
vm.runInContext(clipSrc, sandbox);
vm.runInContext(shotSrc, sandbox);
const { shotClip, shotContainer, shotActionBar, shotContentRect, shotHideChrome, shotShowChrome, shotKey, shotCaption, shotMarkerToken, shotErrorHint } = sandbox;
const { pageZoom, validClip, clipToDip, rectsAgree, markerSelector } = sandbox;
const SHOT_MARKER_ATTR = vm.runInContext('SHOT_MARKER_ATTR', sandbox);

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
{
  // Adjacent posts: each crop covers only its own post, with no overlap that
  // could carry a neighbour into the picture.
  const a = shotClip({ left: 0, top: 100, width: 600, height: 300 }, 0, 0, 1200, 5000);
  const b = shotClip({ left: 0, top: 420, width: 600, height: 300 }, 0, 0, 1200, 5000);
  check('adjacent posts do not overlap', a.y + a.height <= b.y, { aEnd: a.y + a.height, bStart: b.y });
  check('adjacent posts keep their own heights', a.height === 300 && b.height === 300);
}
{
  // A post taller than the window is still captured whole: the screen is not
  // the limit, the document is. Here the post is 3000px tall and scrolled so
  // its top is 1200px above the fold.
  const rect = { left: 0, top: -1200, width: 600, height: 3000 };
  const clip = shotClip(rect, 0, 1800, 1200, 20000);
  eq('a post taller than the viewport is captured whole',
    { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    { x: 0, y: 600, width: 600, height: 3000 });
  check('and it is taller than the window', clip.height > 900);
}

// ------------------------------------------------- post container selection
//
// A tiny element stand-in: a parent/child tree, an attribute bag, and the two
// selector calls shotContainer makes. Only the selectors shot.js uses are
// understood, which is the point - the test asserts the *decision*, not a
// general CSS engine.
function fakeEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: attrs || {},
    parent: null,
    children: [],
    // Mirror the DOM: reading a style property that was never set gives ''.
    style: { visibility: '' },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    append(child) { child.parent = el; el.children.push(child); return child; },
    contains(node) {
      if (!node) return false;
      if (el === node) return true;
      return el.children.some((c) => c.contains && c.contains(node));
    },
    matches(sel) { return sel.split(',').some((s) => matchSimple(el, s.trim())); },
    closest(sel) { let c = el; while (c) { if (c.matches && c.matches(sel)) return c; c = c.parent; } return null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { for (const ch of n.children) { if (ch.matches && ch.matches(sel)) out.push(ch); walk(ch); } })(el);
      return out;
    },
  };
  return el;
}
function matchSimple(el, sel) {
  const m = /^([a-zA-Z]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
  if (!m) return false;
  if (el.tagName !== m[1].toUpperCase()) return false;
  return m[2] ? el.getAttribute(m[2]) === m[3] : true;
}
// One post plus the action bar the button lives in, mirroring X's article.
function fakePost(extraAttrs) {
  const article = fakeEl('article', Object.assign({ 'data-testid': 'tweet', role: 'article' }, extraAttrs || {}));
  const bar = fakeEl('div', { role: 'group' });
  article.append(bar);
  return { article, bar };
}

console.log('the crop is taken from the clicked button\'s own post');
{
  // A timeline: a list container holding several posts. The button is in the
  // second post, so that post - not the list - is the container.
  const list = fakeEl('div', {});
  const p1 = fakePost();
  const p2 = fakePost();
  const p3 = fakePost();
  list.append(p1.article); list.append(p2.article); list.append(p3.article);
  const btn = fakeEl('button', {});
  p2.bar.append(btn);

  check('the second post is selected, not the timeline list', shotContainer(btn) === p2.article);
  check('and not the first or third post', shotContainer(btn) !== p1.article && shotContainer(btn) !== p3.article);
  check('the chosen container holds a single post', shotContainer(btn).querySelectorAll('article').length === 0);
}
{
  // Two buttons, two different posts: each resolves to its own article, which
  // is what makes two posts on one page crop to two different boxes.
  const list = fakeEl('div', {});
  const a = fakePost(); const b = fakePost();
  list.append(a.article); list.append(b.article);
  const btnA = fakeEl('button', {}); a.bar.append(btnA);
  const btnB = fakeEl('button', {}); b.bar.append(btnB);
  check('each button finds its own post', shotContainer(btnA) === a.article && shotContainer(btnB) === b.article);
  check('the two posts are different', shotContainer(btnA) !== shotContainer(btnB));
}
{
  // A quoted post is rendered inside this post as a link card, not as a
  // nested post - verified against live X. The outer article therefore still
  // holds a single post and is the container.
  const outer = fakePost();
  const quoteCard = fakeEl('div', { role: 'link' });
  outer.article.append(quoteCard);
  const btn = fakeEl('button', {}); outer.bar.append(btn);
  check('a post with a quoted card still selects the outer post', shotContainer(btn) === outer.article);
}
{
  // The guard: whatever X does, a container that holds more than one post is
  // never cropped. Capturing it would include the neighbouring posts. Here the
  // button's nearest post ancestor is itself a wrapper holding two posts.
  const wrapper = fakeEl('article', { 'data-testid': 'tweet', role: 'article' });
  const inner1 = fakePost(); const inner2 = fakePost();
  wrapper.append(inner1.article); wrapper.append(inner2.article);
  const btn = fakeEl('button', {}); wrapper.append(btn);
  check('a container holding other posts is refused', shotContainer(btn) === null);
  check('even when it is itself marked as a post', wrapper.querySelectorAll('article').length === 2);
  // A button inside a real post is unaffected by a multi-post wrapper above it.
  const deepBtn = fakeEl('button', {}); inner2.bar.append(deepBtn);
  check('a button inside one of its posts still resolves to that post', shotContainer(deepBtn) === inner2.article);
}
{
  const btn = fakeEl('button', {});
  fakeEl('div', {}).append(btn); // somewhere that is not a post
  check('a button outside any post yields nothing', shotContainer(btn) === null);
  check('nothing at all yields nothing', shotContainer(null) === null);
  check('something without closest() yields nothing', shotContainer({}) === null);
}
{
  // The selector is anchored on the post element, so a status-page article
  // and a timeline article are both found the same way.
  const roleOnly = fakeEl('article', { role: 'article' });
  const bar = fakeEl('div', { role: 'group' }); roleOnly.append(bar);
  const btn = fakeEl('button', {}); bar.append(btn);
  check('an article without the testid is still a post', shotContainer(btn) === roleOnly);
}

// ------------------------------------------------ cropping out the controls
//
// A screenshot is of the post, not of the interface around it. X's action bar
// (reply / repost / like / share) and the extension's own toolbar sit at the
// bottom of the post, so the crop stops where the action bar begins.
console.log('the crop stops above the action bar');
{
  // The action bar is found from its like button, which only the bar has.
  const { article, bar } = fakePost();
  bar.append(fakeEl('button', { 'data-testid': 'like' }));
  bar.append(fakeEl('button', { 'data-testid': 'reply' }));
  check('the bar is found from its like button', shotActionBar(article) === bar);
}
{
  // A quoted post renders its own like row inside this post. That row is not
  // this post's action bar and must not be mistaken for it.
  const article = fakeEl('article', { 'data-testid': 'tweet', role: 'article' });
  const quote = fakeEl('div', { 'data-testid': 'quoteTweet' });
  const quoteBar = fakeEl('div', { role: 'group' });
  quoteBar.append(fakeEl('button', { 'data-testid': 'like' }));
  quote.append(quoteBar);
  const realBar = fakeEl('div', { role: 'group' });
  realBar.append(fakeEl('button', { 'data-testid': 'like' }));
  article.append(quote);
  article.append(realBar);
  check('a quoted post\'s like row is skipped', shotActionBar(article) === realBar);
  check('and the quoted row is not chosen', shotActionBar(article) !== quoteBar);
}
{
  // No like button to key on: the first action-bar-like group is still better
  // than cropping the whole post and including the controls.
  const { article, bar } = fakePost();
  check('a bar without a like button is still found', shotActionBar(article) === bar);
}
{
  const noBar = fakeEl('article', { 'data-testid': 'tweet' });
  check('a post with no action bar has no bar', shotActionBar(noBar) === null);
  check('nothing at all has no bar', shotActionBar(null) === null);
  check('something without querySelectorAll has no bar', shotActionBar({}) === null);
}

console.log('the post\'s content rectangle stops where the controls begin');
{
  // The bar's top is in viewport coordinates, the same space as the rect.
  const rect = { left: 10, top: 100, width: 500, height: 600 };
  eq('the crop ends at the action bar', shotContentRect(rect, 500), { left: 10, top: 100, width: 500, height: 400 });
}
{
  const rect = { left: 10, top: -300, width: 500, height: 600 };
  // Scrolled up: a negative top with a bar still below the top of the post.
  eq('a post scrolled partly off the top still crops to its content', shotContentRect(rect, -40), { left: 10, top: -300, width: 500, height: 260 });
}
{
  const rect = { left: 10, top: 100, width: 500, height: 600 };
  eq('no bar leaves the whole post', shotContentRect(rect, undefined), rect);
  eq('a non-numeric bar position leaves the whole post', shotContentRect(rect, NaN), rect);
  eq('a bar above the top of the post leaves the whole post', shotContentRect(rect, 50), rect);
  eq('a bar past the bottom is cut to the post', shotContentRect(rect, 9000), rect);
  check('no rectangle yields nothing', shotContentRect(null, 500) === null);
}

console.log('the controls are absent from the clip that is actually sent');
{
  // End to end through the same two steps the button takes: measure the post,
  // trim to the action bar, then convert to page coordinates.
  const rect = { left: 20, top: -300, width: 560, height: 700 };
  const barTop = -300 + 580; // content ends 580px below the post's top
  const content = shotContentRect(rect, barTop);
  const clip = shotClip(content, 0, 400, 1200, 9000);
  eq('the clip keeps the post\'s width and position', { x: clip.x, y: clip.y, width: clip.width }, { x: 20, y: 100, width: 560 });
  eq('and stops above the bar', clip.height, 580);
  check('so the picture is shorter than the whole post', clip.height < rect.height, { clip: clip.height, post: rect.height });
}

// ---------------------------------------------------- hiding the page chrome
//
// A capture may be taller than the window, and Chrome then paints the page's
// fixed and sticky furniture into the shot, on top of the post. That chrome is
// hidden for the capture and restored afterwards; the post is never touched.
console.log('the page\'s own chrome is hidden for the capture, then put back');
{
  const root = fakeEl('div', {});
  const topBar = fakeEl('div', {}); topBar._position = 'fixed';   // the app bar
  const tabs = fakeEl('div', {}); tabs._position = 'sticky';      // For you / Following
  const plain = fakeEl('div', {}); plain._position = 'static';    // ordinary content
  const wrapper = fakeEl('div', {}); wrapper._position = 'fixed'; // a fixed ancestor
  const article = fakeEl('article', { 'data-testid': 'tweet' });
  const insideFixed = fakeEl('div', {}); insideFixed._position = 'fixed'; // fixed, but in the post
  wrapper.append(article);
  article.append(insideFixed);
  for (const el of [topBar, tabs, plain, wrapper, article, insideFixed]) root.append(el);

  const all = [root, topBar, tabs, plain, wrapper, article, insideFixed];
  const doc = { querySelectorAll: () => all };
  const styleOf = (el) => ({ position: el._position || 'static' });

  const hidden = shotHideChrome(article, doc, styleOf);
  check('the fixed app bar is hidden', topBar.style.visibility === 'hidden');
  check('the sticky For you / Following strip is hidden', tabs.style.visibility === 'hidden');
  check('an ordinary element is left alone', plain.style.visibility === '');
  check('a fixed ancestor of the post is left visible', wrapper.style.visibility === '');
  check('something fixed inside the post is left visible', insideFixed.style.visibility === '');
  eq('only the page chrome was recorded', hidden.length, 2);

  shotShowChrome(hidden);
  check('the app bar is shown again', topBar.style.visibility === '');
  check('the tab strip is shown again', tabs.style.visibility === '');
}
{
  // Anything already hidden inline is put back exactly as it was found.
  const root = fakeEl('div', {});
  const bar = fakeEl('div', {}); bar._position = 'fixed'; bar.style.visibility = 'collapse';
  root.append(bar);
  const doc = { querySelectorAll: () => [root, bar] };
  const styleOf = (el) => ({ position: el._position || 'static' });
  const hidden = shotHideChrome(null, doc, styleOf);
  check('with no post to protect, chrome is still hidden', bar.style.visibility === 'hidden');
  shotShowChrome(hidden);
  check('and its own prior value comes back', bar.style.visibility === 'collapse');
}
{
  // Nothing to hide, and nothing to put back, must still be safe.
  const doc = { querySelectorAll: () => [] };
  eq('no chrome yields nothing to restore', shotHideChrome(null, doc, () => ({ position: 'static' })), []);
  check('restoring nothing is harmless', (shotShowChrome([]), shotShowChrome(null), true));
}

// --------------------------------------------------- page zoom (CSS vs DIP)
//
// Page.captureScreenshot's clip is in DIP, not CSS pixels: CSS pixels scaled
// by the page's zoom factor. The crop is measured in CSS pixels, so the worker
// converts it. At 100% zoom nothing changes; at any other browser zoom an
// unconverted clip lands on the wrong part of the page, at the wrong size.
console.log('the crop is converted from CSS pixels to the capture command\'s pixels');
{
  eq('at 100% the crop is unchanged',
    clipToDip({ x: 500, y: 1700, width: 600, height: 200 }, 1),
    { x: 500, y: 1700, width: 600, height: 200, scale: 1 });
  // The table for 125% is the one measured against a real zoomed browser.
  eq('at 125% the crop is scaled by the zoom',
    clipToDip({ x: 500, y: 1700, width: 600, height: 200 }, 1.25),
    { x: 625, y: 2125, width: 750, height: 250, scale: 1 });
  eq('at 80% the crop shrinks',
    clipToDip({ x: 100, y: 200, width: 400, height: 300 }, 0.8),
    { x: 80, y: 160, width: 320, height: 240, scale: 1 });
}
{
  // The factor comes from the browser; a browser that does not report one must
  // not break the capture.
  eq('a missing layout metric means no zoom', pageZoom(undefined), 1);
  eq('a missing viewport means no zoom', pageZoom({}), 1);
  eq('a zero zoom is ignored', pageZoom({ cssVisualViewport: { zoom: 0 } }), 1);
  eq('a negative zoom is ignored', pageZoom({ cssVisualViewport: { zoom: -2 } }), 1);
  eq('a non-numeric zoom is ignored', pageZoom({ cssVisualViewport: { zoom: 'big' } }), 1);
  eq('a reported zoom is used', pageZoom({ cssVisualViewport: { zoom: 1.25 } }), 1.25);
}
{
  // A scaled crop is rounded to whole pixels, since the command takes integers
  // and rejects a fractional box.
  const clip = clipToDip({ x: 10.4, y: 20.6, width: 100.5, height: 50.2 }, 1.25);
  check('a scaled crop is whole pixels',
    [clip.x, clip.y, clip.width, clip.height].every((v) => Number.isInteger(v)), clip);
}
console.log('a clip that is not a real box is refused, not sent');
{
  check('a positive box is valid', validClip({ x: 0, y: 0, width: 10, height: 10 }) === true);
  check('a zero-width box is refused', clipToDip({ x: 0, y: 0, width: 0, height: 100 }, 1) === null);
  check('a negative box is refused', clipToDip({ x: 0, y: 0, width: -5, height: 100 }, 1) === null);
  check('a missing crop is refused', clipToDip(null, 1) === null);
  check('a NaN crop is refused', clipToDip({ x: 0, y: 0, width: NaN, height: 100 }, 1) === null);
  check('an infinite crop is refused', clipToDip({ x: Infinity, y: 0, width: 10, height: 10 }, 1) === null);
}

// --------------------------------------- re-checking the post at capture time
//
// The crop is measured in the content script but captured later, by the
// worker. The post is tagged so the worker can find that exact node again and
// confirm it is still where it was measured; a post that has gone or moved is
// refused rather than photographed in the wrong place.
console.log('a post is only captured where it was measured');
{
  const a = { left: 10, top: 20, width: 500, height: 600 };
  check('the same box agrees', rectsAgree(a, { left: 10.5, top: 20.4, width: 500.2, height: 600.1 }, 2) === true);
  check('a box that moved does not agree', rectsAgree(a, { left: 10, top: 80, width: 500, height: 600 }, 2) === false);
  check('a box that resized does not agree', rectsAgree(a, { left: 10, top: 20, width: 500, height: 400 }, 2) === false);
  check('a missing box does not agree', rectsAgree(a, null, 2) === false);
  check('a non-numeric box does not agree', rectsAgree(a, { left: NaN, top: 20, width: 500, height: 600 }, 2) === false);
}
{
  const token = shotMarkerToken();
  check('a marker token is a plain token', typeof token === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(token), token);
  check('the token makes a selector on our own attribute',
    markerSelector(token) === `[${SHOT_MARKER_ATTR}="${token}"]`, markerSelector(token));
  check('two captures get different tokens', shotMarkerToken() !== token);
  check('a hostile value cannot become a selector', markerSelector('"] , body, [x="') === null);
  check('an empty token is refused', markerSelector('') === null);
  check('a non-string token is refused', markerSelector({}) === null);
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