// Quote-tweet tests - zero dependencies.
//
// A quote-tweet is one post carrying another inside it. Every send button must
// publish a picture of the post it quotes, captioned with the outer post's own
// words, and never publish the quoted post's media on its own. An ordinary post
// must go through the pipeline exactly as before.
//
// These cover the three decisions that can be checked without a browser:
// which element to photograph (shotPlan), which words become the caption
// (findTweetText + quoteCaption), and what the worker sends the controller
// (the screenshot payload). The capture itself needs a real Chrome and is
// verified by hand.
//
//   node extension/test/quote-tweet.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const extractorSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'tweet-extractor.js'), 'utf8');
const shotSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'shot.js'), 'utf8');
const variantSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'post-variant.js'), 'utf8');
const buttonSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'button.js'), 'utf8');
const clipSrc = fs.readFileSync(path.join(ROOT, 'extension', 'shared', 'clip.js'), 'utf8');
const videoSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background', 'video-source.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'extension', 'background', 'service-worker.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// --- the content scripts, loaded the way the page loads them ---------------
// All three are globals in the browser, so they share one sandbox in the order
// the manifest lists them.
const sandbox = { module: undefined, window: {}, console: { log() {} } };
vm.createContext(sandbox);
vm.runInContext(extractorSrc, sandbox);
vm.runInContext(shotSrc, sandbox);
vm.runInContext(variantSrc, sandbox);
const { shotPlan, shotQuoteCard, findTweetText, quoteCaption, shotClip } = sandbox;
const SHOT_QUOTE_SELECTOR = vm.runInContext('SHOT_QUOTE_SELECTOR', sandbox);

// --- a tiny DOM stand-in --------------------------------------------------
// A parent/child tree with the handful of calls the real code makes. Only the
// selectors it uses are understood, which is the point: the test asserts the
// decision, not a general CSS engine.
function fakeEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: attrs || {},
    parent: null,
    children: [],
    innerText: '',
    style: { visibility: '' },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    setAttribute(name, value) { el.attrs[name] = value; },
    append(child) { child.parent = el; el.children.push(child); return child; },
    contains(node) {
      if (!node) return false;
      if (el === node) return true;
      return el.children.some((c) => c.contains && c.contains(node));
    },
    matches(sel) { return String(sel).split(',').some((s) => matchSimple(el, s.trim())); },
    closest(sel) { let c = el; while (c) { if (c.matches && c.matches(sel)) return c; c = c.parent; } return null; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { for (const ch of n.children) { if (ch.matches && ch.matches(sel)) out.push(ch); walk(ch); } })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'parentElement', { get() { return el.parent; } });
  return el;
}
// `tag`, `tag[attr="v"]`, or a bare `[attr="v"]` - the shapes the real code uses.
function matchSimple(el, sel) {
  let m = /^([a-zA-Z]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
  if (m) {
    if (el.tagName !== m[1].toUpperCase()) return false;
    return m[2] ? el.getAttribute(m[2]) === m[3] : true;
  }
  m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (m) return el.getAttribute(m[1]) === m[2];
  return false;
}
function textNode(text) {
  const el = fakeEl('div', { 'data-testid': 'tweetText' });
  el.innerText = text;
  return el;
}
// An ordinary post: an article with its action bar.
function fakePost(attrs) {
  const article = fakeEl('article', Object.assign({ 'data-testid': 'tweet', role: 'article' }, attrs || {}));
  const bar = fakeEl('div', { role: 'group' });
  article.append(bar);
  return { article, bar };
}
// A quote-tweet: the outer post's words, and the post it quotes as a card.
// `outerText`/`innerText` are the two sets of words; `innerMedia` adds an image
// inside the quoted post.
function fakeQuoteTweet(opts) {
  const o = opts || {};
  const { article, bar } = fakePost();
  article.append(fakeEl('div', { 'data-testid': 'User-Name' }));
  if (o.outerText) article.append(textNode(o.outerText));
  const card = fakeEl('div', { 'data-testid': 'quoteTweet' });
  article.append(card);
  if (o.innerText) card.append(textNode(o.innerText));
  if (o.innerMedia) card.append(fakeEl('img', { src: 'https://pbs.twimg.com/media/inner.jpg' }));
  bar.append(fakeEl('button', { 'data-testid': 'like' }));
  return { article, bar, card };
}

// ------------------------------------------------------ which post to send
console.log('an ordinary post is still sent as it stands');
{
  const { article, bar } = fakePost();
  const btn = fakeEl('button', {}); bar.append(btn);
  const plan = shotPlan(article);
  eq('the post itself is the target', plan.mode, 'post');
  check('and it is the article', plan.element === article);
  check('no quoted post is invented', shotQuoteCard(article) === null);
}

console.log('a quote-tweet photographs the post it quotes, not the outer post');
{
  const q = fakeQuoteTweet({ outerText: 'Look at this', innerText: 'the quoted words', innerMedia: true });
  const plan = shotPlan(q.article);
  eq('the quoted post is the target', plan.mode, 'quote');
  check('and it is the quote card', plan.element === q.card);
  check('never the outer post', plan.element !== q.article);
  check('the card is inside the outer post', q.article.contains(q.card));
  eq('the selector is X\'s quote card', SHOT_QUOTE_SELECTOR, 'div[data-testid="quoteTweet"]');
}

console.log('a quoted post that itself quotes is still told apart');
{
  // The quoted post quotes a third: its card is nested inside the first. The
  // post this one quotes is the outermost card, never the inner one.
  const q = fakeQuoteTweet({ outerText: 'Look', innerText: 'middle' });
  const inner = fakeEl('div', { 'data-testid': 'quoteTweet' });
  inner.append(textNode('innermost'));
  q.card.append(inner);
  const plan = shotPlan(q.article);
  eq('the outermost quoted post is used', plan.mode, 'quote');
  check('it is the outer card', plan.element === q.card);
  check('not the card nested inside it', plan.element !== inner);
}

console.log('a quoted post that cannot be told apart is refused, not guessed');
{
  // Two separate quote cards under one post would be two different posts with
  // no way to know which was meant.
  const { article } = fakePost();
  article.append(fakeEl('div', { 'data-testid': 'quoteTweet' }));
  article.append(fakeEl('div', { 'data-testid': 'quoteTweet' }));
  const plan = shotPlan(article);
  eq('the send is refused', plan.mode, 'error');
  eq('with a clear reason', plan.error, 'quote-ambiguous');
  check('and no element to photograph', plan.element === undefined);
}

console.log('a quote inside another article is not this post\'s quote');
{
  const { article } = fakePost();
  const nested = fakeEl('article', { 'data-testid': 'tweet', role: 'article' });
  nested.append(fakeEl('div', { 'data-testid': 'quoteTweet' }));
  article.append(nested);
  check('the nested article\'s quote is ignored', shotQuoteCard(article) === null);
  eq('so the post is sent as it stands', shotPlan(article).mode, 'post');
}

console.log('a quote-tweet only ever yields the inner post\'s box');
{
  // The crop is computed from the quote card's own rectangle, so the picture
  // is the quoted post alone - not the outer wrapper, and not the neighbours.
  const articleRect = { left: 0, top: 100, width: 600, height: 800 };
  const cardRect = { left: 40, top: 300, width: 500, height: 420 };
  const clip = shotClip(cardRect, 0, 1200, 1200, 9000);
  eq('the crop is the card, in document coordinates',
    { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    { x: 40, y: 1500, width: 500, height: 420 });
  check('it is narrower than the outer post', clip.width <= articleRect.width);
  check('it is shorter than the outer post', clip.height < articleRect.height);
  check('and it sits inside the outer post',
    clip.y >= articleRect.top + 1200 && clip.y + clip.height <= articleRect.top + 1200 + articleRect.height,
    { clipTop: clip.y, articleTop: articleRect.top + 1200, articleBottom: articleRect.top + 1200 + articleRect.height });
}

// ------------------------------------------------------ what the caption is
console.log('the caption is the outer post\'s own words, never the quoted post\'s');
{
  const both = fakeQuoteTweet({ outerText: 'Outer words', innerText: 'Inner words' }).article;
  eq('the outer words win', findTweetText(both), 'Outer words');
}
{
  // Empty outer caption: the quoted post's words must not leak into it.
  const innerOnly = fakeQuoteTweet({ innerText: 'Inner words', innerMedia: true }).article;
  eq('a quote with no words of its own has an empty caption', findTweetText(innerOnly), '');
}
{
  const plain = fakePost().article;
  plain.append(textNode('Just the post'));
  eq('an ordinary post reads normally', findTweetText(plain), 'Just the post');
  eq('a post with no text is empty', findTweetText(fakePost().article), '');
}

console.log('the caption is presented the way the pressed button presents a post');
{
  eq('plain keeps the outer words', quoteCaption('Outer words', 'plain', 'Imran Khan'), 'Outer words');
  eq('named heads them with the author', quoteCaption('Outer words', 'named', 'Imran Khan'), 'Imran Khan\n\nOuter words');
  eq('Urdu leaves them for the controller to translate',
    quoteCaption('Outer words', 'urdu', 'Imran Khan'), 'Outer words');
  eq('an empty outer caption stays empty', quoteCaption('', 'plain', 'Imran Khan'), '');
  eq('a missing outer caption stays empty', quoteCaption(null, 'plain', 'Imran Khan'), '');
  eq('named with no words is just the name', quoteCaption('', 'named', 'Imran Khan'), 'Imran Khan');
  eq('a missing name adds no header', quoteCaption('Outer words', 'named', null), 'Outer words');
}

// ------------------------------------------- every entry point agrees
console.log('both send entry points go through the same decision');
{
  // Slice out one function body so the check names the function that does the
  // work, not a neighbour that happens to sit nearby.
  function functionBody(name) {
    const m = new RegExp('(?:async )?function ' + name + '\\(').exec(buttonSrc);
    if (!m) return '';
    const rest = buttonSrc.slice(m.index + m[0].length);
    const next = rest.search(/\n(?:async )?function /);
    return next === -1 ? rest : rest.slice(0, next);
  }
  const wire = functionBody('wireShotButton');
  const postShot = functionBody('postQuoteShot');
  const onPost = functionBody('onPostClick');
  check('the camera button consults shotPlan', wire.includes('shotPlan('));
  check('the post buttons consult shotPlan', onPost.includes('shotPlan('));
  check('both send the picture through the same capture',
    wire.includes('await sendElementShot(') && postShot.includes('await sendElementShot('));
  check('a quote is read with extractQuotePost, never the full post', postShot.includes('extractQuotePost('));
  check('a quote\'s caption is shaped by the variant', postShot.includes('quoteCaption('));
}

// ------------------------------------------------- what the worker sends
//
// The worker is loaded in a sandbox with a stubbed chrome and fetch, so the
// exact payload it hands the controller can be read back.
function loadWorker() {
  const w = { module: undefined, console: { log() {} } };
  w.importScripts = () => {};
  w.fetch = async () => ({ json: async () => ({ ok: true, jobId: 'job-1', sent: [{ type: 'image' }] }) });
  w.chrome = {
    webRequest: { onBeforeRequest: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { w.__onMessage = fn; } } },
    storage: { local: { get(keys, cb) { cb({ selectedChannelId: 'chan-1' }); } } },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target, method) => {
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { zoom: 1 } };
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
        return {};
      },
    },
  };
  vm.createContext(w);
  vm.runInContext(clipSrc, w);
  vm.runInContext(videoSrc, w);
  vm.runInContext(swSrc, w);
  return w;
}
function screenshotRaw(worker, msg) {
  return new Promise((resolve) => {
    let sent = null;
    worker.fetch = async (url, opts) => {
      sent = { url, body: JSON.parse(opts.body) };
      return { json: async () => ({ ok: true, jobId: 'job-1', sent: [{ type: 'image' }] }) };
    };
    worker.__onMessage(msg, { tab: { id: 7 } }, (resp) => resolve({ resp, sent }));
  });
}

async function workerChecks() {
  console.log('the quoted post travels as one inline image with the outer words as its caption');
  {
    const worker = loadWorker();
    const msg = {
      type: 'SEND_SCREENSHOT',
      requestId: 'req-1',
      clip: { x: 0, y: 0, width: 100, height: 100 },
      dedupeKey: 'shot:123',
      post: { tweetId: '123', tweetUrl: 'https://x.com/a/status/123', text: 'Outer words' },
    };
    const { resp, sent } = await screenshotRaw(worker, msg);
    check('the send succeeds', resp && resp.ok === true, resp);
    eq('it goes to the same endpoint', sent && sent.url, 'http://127.0.0.1:47825/send');
    eq('the caption is the outer words', sent.body.text, 'Outer words');
    eq('the media is the single captured image', sent.body.media, [{ type: 'image', source: 'data:image/jpeg;base64,AAAA' }]);
    check('the image is inline, not a URL', String(sent.body.media[0].source).indexOf('data:image/') === 0);
    eq('keyed apart from posting the post', sent.body.tweetId, 'shot:123');
    check('no separate media is attached', sent.body.media.length === 1 && sent.body.media[0].type === 'image');

    // The Urdu button asks the controller to translate the caption.
    const worker2 = loadWorker();
    const msg2 = Object.assign({}, msg, { requestId: 'req-2', translateTo: 'ur' });
    const { resp: r2, sent: s2 } = await screenshotRaw(worker2, msg2);
    check('the Urdu send succeeds', r2 && r2.ok === true, r2);
    eq('and asks for the caption to be translated', s2.body.translateTo, 'ur');
  }

  console.log('an ordinary camera screenshot is unchanged');
  {
    const worker = loadWorker();
    const msg = {
      type: 'SEND_SCREENSHOT',
      requestId: 'shot-1',
      clip: { x: 0, y: 0, width: 100, height: 100 },
      dedupeKey: 'shot:9',
      post: { tweetId: '9', tweetUrl: 'https://x.com/a/status/9' },
    };
    const { resp, sent } = await screenshotRaw(worker, msg);
    check('it still sends', resp && resp.ok === true, resp);
    eq('with no caption', sent.body.text, '');
    check('and no translation is asked for', sent.body.translateTo === undefined);
    eq('still one inline image', sent.body.media.length, 1);
  }
}

workerChecks().then(() => {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL QUOTE-TWEET TESTS PASSED');
  process.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
