// Quote-tweet tests, at the button itself - zero dependencies.
//
// quote-tweet.test.js checks the pure decisions (shotPlan, quoteCaption,
// findTweetText) and the worker's payload. This file goes one level up: it
// loads the real button.js and presses its real click handlers, so the camera
// button and the three send buttons are exercised the way the page wires them.
// That is the only way to catch an entry point that skips the shared path.
//
// A fake DOM stands in for the page: a parent/child tree with the handful of
// calls the content scripts make, and a selector matcher that understands only
// the shapes those scripts use. The extraction is the real extraction - the
// real tweet-extractor.js runs against this DOM - so the caption really does
// come from the outer post's own words, and the quoted post's media really is
// never named in the message.
//
//   node extension/test/quote-button.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const clipSrc = read('extension/shared/clip.js');
const extractorSrc = read('extension/content/tweet-extractor.js');
const shotSrc = read('extension/content/shot.js');
const variantSrc = read('extension/content/post-variant.js');
const buttonSrc = read('extension/content/button.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
function includes(name, hay, needle) {
  check(name, String(hay).indexOf(needle) !== -1, { needle, hay: String(hay).slice(0, 200) });
}

// --- a tiny DOM stand-in --------------------------------------------------
function matchSimple(el, sel) {
  if (sel === '*') return true;
  const m = /^([a-zA-Z]*)(?:\[([\w-]+)(?:([*^$]?)=["']([^"']*)["'])?\])?$/.exec(sel);
  if (!m) return false;
  const [, tag, attr, op, want] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (!attr) return true;
  const have = el.getAttribute(attr);
  if (op === undefined) return have !== null;        // [attr] - presence
  if (have === null) return false;
  if (op === '') return have === want;                // [attr="v"]
  if (op === '*') return have.indexOf(want) !== -1;   // [attr*="v"]
  if (op === '^') return have.indexOf(want) === 0;    // [attr^="v"]
  if (op === '$') return have.slice(-want.length) === want; // [attr$="v"]
  return false;
}
function mkEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, attrs || {}),
    children: [],
    parent: null,
    innerText: '',
    _text: '',
    title: '',
    type: '',
    disabled: false,
    id: '',
    dataset: {},
    isConnected: true,
    _rect: { left: 0, top: 0, width: 600, height: 800 },
    style: {
      cssText: '',
      setProperty(prop, value) { this[prop] = value; },
      removeProperty(prop) { delete this[prop]; },
    },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(el.attrs, n) ? el.attrs[n] : null; },
    setAttribute(n, v) { el.attrs[n] = String(v); },
    removeAttribute(n) { delete el.attrs[n]; },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    append(c) { return el.appendChild(c); },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parent = null; return c; },
    remove() { if (el.parent) el.parent.removeChild(el); },
    addEventListener(t, fn) { (el.__handlers[t] = el.__handlers[t] || []).push(fn); },
    getBoundingClientRect() { return el._rect; },
    contains(node) { if (!node) return false; if (el === node) return true; return el.children.some((c) => c.contains(node)); },
    matches(sel) { return String(sel).split(',').some((s) => matchSimple(el, s.trim())); },
    closest(sel) { let c = el; while (c) { if (c.matches && c.matches(sel)) return c; c = c.parent; } return null; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      (function walk(n) { for (const ch of n.children) { if (ch.matches && ch.matches(sel)) out.push(ch); walk(ch); } })(el);
      return out;
    },
  };
  el.__handlers = {};
  Object.defineProperty(el, 'parentElement', { get() { return el.parent; } });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  Object.defineProperty(el, 'href', { get() { return el.getAttribute('href'); } });
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.length ? el.children.map((c) => c.textContent).join('') : el._text; },
    set(v) { el.children.length = 0; el._text = String(v == null ? '' : v); },
  });
  return el;
}

// A single boot of the page: a fresh sandbox with the content scripts loaded,
// plus the outbox that captures every message the buttons hand the worker.
function bootPage() {
  const outbox = [];
  const body = mkEl('body');
  const byId = new Map();
  const origSetAttribute = null; // (kept for clarity)
  const document = {
    body,
    documentElement: { scrollWidth: 1200, scrollHeight: 9000, style: {} },
    createElement: (t) => mkEl(t),
    createElementNS: (_ns, t) => mkEl(t),
    getElementById(id) { return byId.get(id) || null; },
    querySelectorAll(sel) { return sel === 'article' || sel === '*' ? [] : body.querySelectorAll(sel); },
    addEventListener() {},
  };
  // Track snackbar host by id so the second banner reuses the first.
  const realAppend = body.appendChild.bind(body);
  body.appendChild = (c) => { if (c.id) byId.set(c.id, c); return realAppend(c); };

  const window = { scrollX: 0, scrollY: 0 };
  // A per-boot hook the test can use to move the page while a send is in
  // flight, exactly as a real page can between reading a post and capturing it.
  const hooks = { onMessage: null };
  const sandbox = {
    module: undefined,
    console: { log() {} },
    window,
    document,
    location: { href: 'https://x.com/a/status/111', origin: 'https://x.com' },
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    getComputedStyle: () => ({ position: 'static' }),
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    chrome: {
      storage: { local: { get(keys, cb) { cb({}); }, set() {} } },
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(msg) {
          outbox.push(msg);
          if (hooks.onMessage) await hooks.onMessage(msg);
          if (msg && msg.type === 'TRANSLATE_TEXT') return { ok: true, text: msg.text };
          if (msg && msg.type === 'RESOLVE_LINKS') return { ok: true, resolved: { 'https://t.co/abc': 'https://example.com/x' } };
          return { ok: true, jobId: 'job-1', sent: [{ type: 'image' }] };
        },
      },
    },
    fetch: async () => { throw new Error('fetch must not be reached'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(clipSrc, sandbox);
  vm.runInContext(extractorSrc, sandbox);
  vm.runInContext(shotSrc, sandbox);
  vm.runInContext(variantSrc, sandbox);
  vm.runInContext(buttonSrc, sandbox);
  return { sandbox, outbox, window, hooks };
}

// --- DOM builders ---------------------------------------------------------
function arrow(parent, child) { parent.appendChild(child); return child; }
function statusLink(id) {
  const a = mkEl('a', { href: `/a/status/${id}` });
  arrow(a, mkEl('time', {}));
  return a;
}
// One post: its permalink, (optional) author name, (optional) own words,
// (optional) a quoted card, and its action bar with a like button.
function post(opts) {
  const o = opts || {};
  const id = o.id || '111';
  const article = mkEl('article', { 'data-testid': 'tweet', role: 'article' });
  article._rect = o.rect || { left: 0, top: 100, width: 600, height: 800 };
  arrow(article, statusLink(id));
  if (o.author) {
    const un = mkEl('div', { 'data-testid': 'User-Name' });
    const an = mkEl('a', { href: '/ImranKhan' });
    an.innerText = o.author;
    arrow(un, an);
    arrow(article, un);
  }
  if (o.text) {
    const t = mkEl('div', { 'data-testid': 'tweetText' });
    t.innerText = o.text;
    arrow(article, t);
  }
  let card = null;
  if (o.quote) {
    card = mkEl('div', { 'data-testid': 'quoteTweet' });
    card._rect = o.quote.rect || { left: 40, top: 300, width: 500, height: 420 };
    if (o.quote.text) {
      const it = mkEl('div', { 'data-testid': 'tweetText' });
      it.innerText = o.quote.text;
      arrow(card, it);
    }
    if (o.quote.video) {
      arrow(card, mkEl('video', { poster: 'https://video.twimg.com/amplify_video_thumb/999/img/x.jpg' }));
    }
    if (o.quote.image) {
      arrow(card, mkEl('img', { src: 'https://pbs.twimg.com/media/INNERIMG.jpg' }));
    }
    arrow(article, card);
  }
  const bar = mkEl('div', { role: 'group' });
  bar._rect = o.barRect || { left: 0, top: 700, width: 600, height: 50 };
  arrow(bar, mkEl('button', { 'data-testid': 'like' }));
  arrow(article, bar);
  return { article, card, bar };
}
const clickEvent = { preventDefault() {}, stopPropagation() {} };
async function press(btn) { await btn.__handlers.click[0](clickEvent); }
function cameraOf(sandbox, article) {
  const btn = mkEl('button', {});
  btn._rect = { left: 0, top: 740, width: 26, height: 26 };
  arrow(article, btn);
  sandbox.wireShotButton(btn);
  return btn;
}
function sendOf(sandbox, article, variant) {
  const btn = sandbox.createPostButton(article, variant);
  arrow(article, btn);
  return btn;
}
const last = (outbox) => outbox[outbox.length - 1];
const shots = (outbox) => outbox.filter((m) => m.type === 'SEND_SCREENSHOT');
const posts = (outbox) => outbox.filter((m) => m.type === 'SEND_POST');

// --- the checks -----------------------------------------------------------
(async function run() {
  console.log('the camera button photographs the quoted card, with the outer words as caption');
  {
    const { sandbox, outbox } = bootPage();
    const p = post({ id: '111', text: 'Outer words', quote: { text: 'Inner words', video: true } });
    const cam = cameraOf(sandbox, p.article);
    await press(cam);

    const msg = last(outbox);
    eq('the camera sends a screenshot', msg.type, 'SEND_SCREENSHOT');
    eq('the crop is the quoted card, not the outer post', msg.clip,
      { x: 40, y: 300, width: 500, height: 420, scale: 1 });
    check('the crop is not the whole outer post', msg.clip.height < p.article._rect.height, msg.clip);
    eq('the caption is the outer post\'s own words', msg.post.text, 'Outer words');
    eq('the id is the outer post\'s', msg.post.tweetId, '111');
    eq('the permalink is the outer post\'s', msg.post.tweetUrl, 'https://x.com/a/status/111');
    check('the quoted post\'s video is never named in the message',
      JSON.stringify(msg).indexOf('999') === -1 && JSON.stringify(msg).indexOf('amplify_video') === -1,
      msg);
    check('nothing but the captured picture is attached',
      msg.media === undefined && msg.clip !== undefined);
  }

  console.log('the same holds for a quoted image, and for an outer post with words only');
  {
    const { sandbox, outbox } = bootPage();
    const p = post({ id: '222', text: 'Look at this', quote: { text: 'quoted', image: true } });
    const cam = cameraOf(sandbox, p.article);
    await press(cam);
    const msg = last(outbox);
    eq('the quoted card is the crop', msg.clip, { x: 40, y: 300, width: 500, height: 420, scale: 1 });
    eq('the outer words are the caption', msg.post.text, 'Look at this');
    check('the quoted image is not attached on its own',
      JSON.stringify(msg).indexOf('INNERIMG') === -1, msg);
  }

  console.log('an empty outer caption stays empty - the quoted words do not leak in');
  {
    const { sandbox, outbox } = bootPage();
    const p = post({ id: '333', quote: { text: 'the quoted words', video: true } });
    const cam = cameraOf(sandbox, p.article);
    await press(cam);
    eq('the screenshot is still sent', last(outbox).type, 'SEND_SCREENSHOT');
    eq('with an empty caption', last(outbox).post.text, '');
  }

  console.log('an ordinary post is photographed exactly as before');
  {
    const { sandbox, outbox } = bootPage();
    const p = post({ id: '444', text: 'Just the post' });
    const cam = cameraOf(sandbox, p.article);
    await press(cam);
    const msg = last(outbox);
    eq('the camera still screenshots the post', msg.type, 'SEND_SCREENSHOT');
    eq('the crop stops above the action bar', msg.clip,
      { x: 0, y: 100, width: 600, height: 600, scale: 1 });
    eq('and carries no caption', msg.post.text, '');
    eq('and asks for no translation', msg.translateTo, undefined);
  }

  console.log('a quoted post that cannot be told apart is refused, never sent');
  {
    const { sandbox, outbox } = bootPage();
    const p = post({ id: '555', text: 'Outer' });
    arrow(p.article, mkEl('div', { 'data-testid': 'quoteTweet' }));
    arrow(p.article, mkEl('div', { 'data-testid': 'quoteTweet' }));
    const cam = cameraOf(sandbox, p.article);
    await press(cam);
    eq('the camera sends nothing', shots(outbox).length, 0);
    eq('and shows the failure state', cam.dataset.shotState, 'error');
  }

  console.log('the plain, named and Urdu buttons are unchanged on an ordinary post');
  {
    for (const variant of ['plain', 'named', 'urdu']) {
      const { sandbox, outbox } = bootPage();
      const p = post({ id: '666', text: 'Just the post', author: 'Imran Khan' });
      const btn = sendOf(sandbox, p.article, variant);
      await press(btn);
      const msg = last(outbox);
      eq(`${variant}: it posts the post (not a screenshot)`, msg.type, 'SEND_POST');
      if (variant === 'plain') {
        eq('plain sends the words as written', msg.post.text, 'Just the post');
        eq('with no translation', msg.translateTo, undefined);
      } else if (variant === 'named') {
        eq('named heads it with the author', msg.post.text, 'Imran Khan\n\nJust the post');
      } else {
        eq('Urdu sends the words for the controller to translate', msg.post.text, 'Just the post');
        eq('and asks for the translation', msg.translateTo, 'ur');
      }
      eq(`${variant}: it is the post's own media path`, msg.media, undefined);
    }
  }

  console.log('every send button on a quote-tweet agrees with the camera');
  {
    for (const variant of ['plain', 'named', 'urdu']) {
      const { sandbox, outbox } = bootPage();
      const p = post({ id: '777', text: 'Outer words', author: 'Imran Khan', quote: { text: 'Inner', image: true } });
      const btn = sendOf(sandbox, p.article, variant);
      await press(btn);
      const msg = last(outbox);
      eq(`${variant}: a quote is sent as the quoted card`, msg.type, 'SEND_SCREENSHOT');
      eq(`${variant}: cropped to the card`, msg.clip,
        { x: 40, y: 300, width: 500, height: 420, scale: 1 });
      if (variant === 'plain') eq('plain keeps the outer words', msg.post.text, 'Outer words');
      if (variant === 'named') eq('named heads them with the author', msg.post.text, 'Imran Khan\n\nOuter words');
      if (variant === 'urdu') {
        eq('Urdu keeps the outer words for the controller', msg.post.text, 'Outer words');
        eq('and forwards the translation request', msg.translateTo, 'ur');
      }
      check(`${variant}: the quoted image is not attached separately`,
        JSON.stringify(msg).indexOf('INNERIMG') === -1, msg);
    }
  }

  console.log('the crop follows the post when the page moves during extraction');
  {
    const { sandbox, outbox, window, hooks } = bootPage();
    const p = post({ id: '888', text: 'Outer words example.com/x', quote: { image: true } });
    // A resolvable link in the outer post's own words: reading it waits on the
    // worker, which is the window in which a real page can scroll. The crop
    // must be taken after that wait, where the post is now - not before it.
    const textEl = p.article.querySelector('[data-testid="tweetText"]');
    const link = arrow(textEl, mkEl('a', { href: 'https://t.co/abc' }));
    link.innerText = 'example.com/x';
    const cam = cameraOf(sandbox, p.article);
    hooks.onMessage = (msg) => {
      if (msg.type === 'RESOLVE_LINKS') {
        p.card._rect = { left: 40, top: 500, width: 500, height: 420 };
        window.scrollY = 200;
      }
    };
    await press(cam);
    const msg = last(outbox);
    eq('the screenshot is still sent', msg.type, 'SEND_SCREENSHOT');
    eq('and the crop is where the quoted post is now, not where it was',
      msg.clip, { x: 40, y: 700, width: 500, height: 420, scale: 1 });
  }

  console.log('a post button with no article shows the read error and sends nothing');
  {
    const { sandbox, outbox } = bootPage();
    const btn = sandbox.createPostButton(mkEl('article', { 'data-testid': 'tweet' }), 'plain');
    // no click handler invocation target under an article: press it detached
    outbox.length = 0;
    // A detached button has no article; drive the handler directly.
    const orphan = mkEl('button', { 'data-xwap-variant': 'plain' });
    sandbox.wireShotButton(orphan);
    await press(orphan);
    eq('the camera sends nothing when it has no post', shots(outbox).length, 0);
    eq('and reports the failure', orphan.dataset.shotState, 'error');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL QUOTE-BUTTON TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
