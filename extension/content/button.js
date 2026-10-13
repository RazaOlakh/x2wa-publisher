// Content script: inject the "Post to WhatsApp" button and delegate the
// actual work to the background worker.
//
// Both of the extension's actions live in a toolbar of their own, placed
// beneath the post's own action bar (see toolbar.js). Each button is a minimal
// outline icon with no background that shows one glyph per state:
//   idle    WhatsApp glyph   (grey)    -> post this to the Channel
//   idle    "@" glyph        (grey)    -> post it with the author's name
//   working spinner         (blue)    -> posting
//   success check mark      (green)   -> posted
//   partial warning         (amber)   -> partially posted
//   error   cross           (red)     -> not posted
//
// Icons are inline, outlined SVG (stroke, no fill, no solid shape) built with
// createElementNS and animated with SMIL, so nothing is fetched and no
// stylesheet is injected into the page. There is no visible label: the meaning
// is carried by the glyph and its colour, and by aria-label and title so
// assistive technology and hover still explain what it does and what state it
// is in.
const INJECTION_FLAG = '__xwapButtonInjected';
const SVG_NS = 'http://www.w3.org/2000/svg';

// No background, no border and no filled shape: a state is only the colour of
// the outline, the way X's own action icons work. The glyph itself carries the
// meaning, and the colour reinforces it.
const BUTTON_STYLES = {
  idle:    { fg: '#536471' },
  working: { fg: '#1d9bf0' },
  success: { fg: '#00a884' },
  partial: { fg: '#e8912d' },
  error:   { fg: '#f4212e' },
};

function xlog(level, event, data) {
  const rec = { ts: new Date().toISOString(), level, component: 'content', event, ...(data || {}) };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`${level} ${event}`); }
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// --- icons ---------------------------------------------------------------
// Outline, not solid: every glyph is drawn as a stroke with no fill, so the
// whole set reads as one line-icon family. The colour of the button behind it
// carries the state, so the glyph only has to say what the action is.
const ICON_CANVAS = { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' };

function lineIcon(children) {
  const svg = svgEl('svg', Object.assign({
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, ICON_CANVAS));
  for (const child of children) svg.appendChild(svgEl(child[0], child[1]));
  return svg;
}

function whatsappIcon() {
  // A speech bubble with its tail, and the handset outlined inside it.
  return lineIcon([
    ['path', { d: 'M12 3.2a8.8 8.8 0 0 0-7.5 13.4L3.2 20.8l4.3-1.2A8.8 8.8 0 1 0 12 3.2Z' }],
    ['path', { 'stroke-width': '1.5', d: 'M9.1 8.2c-.2 0-.5 0-.7.3-.2.3-.8.8-.8 1.9s.8 2.2 1 2.4c.1.2 1.6 2.4 3.8 3.3 1.9.8 2.2.6 2.6.6.4 0 1.3-.5 1.5-1.1.2-.5.2-1 .1-1.1 0-.1-.2-.2-.4-.3-.3-.1-1.3-.7-1.5-.7-.2-.1-.4-.1-.5.1-.2.2-.6.8-.7.9-.1.1-.3.2-.5 0-.3-.1-1-.4-1.8-1.1-.7-.6-1.1-1.3-1.3-1.5-.1-.2 0-.4.1-.5l.4-.4c.1-.1.1-.2.2-.4 0-.1 0-.3 0-.4-.1-.1-.5-1.2-.7-1.6-.2-.4-.4-.3-.5-.3Z' }],
  ]);
}

function atIcon() {
  // The "@" in the same outline family: the inner ring and the outer ring with
  // its tail. It marks the send button that names the author, so the two send
  // buttons read apart at a glance.
  return lineIcon([
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94' }],
  ]);
}

function spinnerIcon() {
  const svg = svgEl('svg', Object.assign({}, ICON_CANVAS));
  svg.appendChild(svgEl('circle', {
    cx: '12', cy: '12', r: '9',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '2.5', 'stroke-linecap': 'round',
    'stroke-dasharray': '42 14', 'stroke-dashoffset': '0', opacity: '0.9',
  }));
  // Rotated by SMIL: self-contained, no keyframes/stylesheet needed.
  svg.firstChild.appendChild(svgEl('animateTransform', {
    attributeName: 'transform', type: 'rotate',
    from: '0 12 12', to: '360 12 12', dur: '0.9s', repeatCount: 'indefinite',
  }));
  return svg;
}

function checkIcon() {
  return lineIcon([['path', { d: 'M5 12.5 9.5 17 19 7.5' }]]);
}

function crossIcon() {
  return lineIcon([['path', { d: 'M6.5 6.5 17.5 17.5' }], ['path', { d: 'M17.5 6.5 6.5 17.5' }]]);
}

function alertIcon() {
  // Drawn entirely with strokes: the dot is a round-capped zero-length line,
  // so nothing in the icon set is a filled shape.
  return lineIcon([
    ['line', { x1: '12', y1: '6.5', x2: '12', y2: '12.5' }],
    ['line', { x1: '12', y1: '16.6', x2: '12.01', y2: '16.6' }],
  ]);
}

const ICONS = {
  success: () => checkIcon(),
  error:   () => crossIcon(),
  partial: () => alertIcon(),
};

// --- rendering -----------------------------------------------------------
function renderButton(btn, state, label) {
  const tone = BUTTON_STYLES[state] || BUTTON_STYLES.idle;
  const named = btn.getAttribute('data-xwap-named') === '1';
  // The two send buttons share every state glyph; only the idle mark differs,
  // the "@" for the one that names the author versus the WhatsApp bubble.
  const icon = state === 'idle' ? (named ? atIcon() : whatsappIcon())
    : state === 'working' ? spinnerIcon()
    : (ICONS[state] || ICONS.error)();

  btn.textContent = '';
  btn.appendChild(icon);

  // The page's own stylesheet targets buttons in an action bar, and an
  // overfull bar squeezes a flex item's width while leaving its height
  // alone. Either one can distort the icon. Setting these with the important
  // flag means a stylesheet rule -- even one that is itself important --
  // cannot resize the button, and fixing the minimum as well stops the flex
  // layout compressing it.
  const fixed = (prop, value) => btn.style.setProperty(prop, value, 'important');
  const SIZE = '26px';
  fixed('box-sizing', 'border-box');
  fixed('width', SIZE);
  fixed('height', SIZE);
  fixed('min-width', SIZE);
  fixed('max-width', SIZE);
  fixed('min-height', SIZE);
  fixed('max-height', SIZE);
  fixed('padding', '0');
  fixed('flex', '0 0 auto');
  fixed('align-self', 'center');

  // No background, no border, no filled shape: the icon is all there is, so
  // the colour of the stroke is what shows the state.
  fixed('background', 'transparent');
  fixed('border', '0');
  fixed('color', tone.fg);
  fixed('display', 'inline-flex');
  fixed('align-items', 'center');
  fixed('justify-content', 'center');
  fixed('font', 'inherit');
  fixed('cursor', 'pointer');
  // No left margin: the toolbar spaces its icons with a gap, so each button
  // sits flush and the spacing lives in one place.
  fixed('margin-left', '0');
  fixed('flex-shrink', '0');
  fixed('transition', 'color .18s ease, transform .12s ease');
  fixed('opacity', '1');

  // Icon-only: name the control and its state for assistive tech and hover.
  // The "name the author" variant is otherwise an exact copy, so the two are
  // told apart by this label (and by position) rather than by a different glyph.
  const action = buttonAction(btn);
  const stateText = state === 'idle' ? '' : (label || '');
  btn.setAttribute('aria-label', stateText ? action + ': ' + stateText : action);
  btn.title = stateText ? action + ' \u2014 ' + stateText : action;
  btn.dataset.state = state;
}

// The two send buttons share one glyph and one handler; only this name differs.
function buttonAction(btn) {
  return btn.getAttribute('data-xwap-named') === '1' ? 'Post with author name' : 'Post to WhatsApp';
}

// --- screenshot button ---------------------------------------------------
// A camera button beside the WhatsApp one, capturing this post alone. It
// has its own states and its own icons: it is a different action, and the
// tick on the WhatsApp button means "this was posted", which is not what a
// screenshot does.
const SHOT_STYLES = {
  idle:    { fg: '#536471' },
  working: { fg: '#1d9bf0' },
  success: { fg: '#00a884' },
  error:   { fg: '#f4212e' },
};

function cameraIcon() {
  // Body, lens and the small viewfinder bump, all stroked.
  return lineIcon([
    ['path', { d: 'M3 8.6A2.6 2.6 0 0 1 5.6 6h1.8l1.2-2h6.8l1.2 2h1.8A2.6 2.6 0 0 1 21 8.6v7.8A2.6 2.6 0 0 1 18.4 19H5.6A2.6 2.6 0 0 1 3 16.4Z' }],
    ['circle', { cx: '12', cy: '12.4', r: '3.2' }],
  ]);
}

function shotSpinnerIcon() {
  // Same spinner, coloured by the button's current colour like every other
  // glyph: no white override, because there is no coloured disc behind it.
  return spinnerIcon();
}

const SHOT_ICONS = {
  idle: () => cameraIcon(),
  working: () => shotSpinnerIcon(),
  success: () => checkIcon(),
  error: () => crossIcon(),
};

const SHOT_LABELS = {
  idle: 'Screenshot this post',
  working: 'Capturing…',
  success: 'Screenshot sent',
  error: 'Screenshot failed',
};

function renderShotButton(btn, state) {
  const tone = SHOT_STYLES[state] || SHOT_STYLES.idle;
  btn.textContent = '';
  btn.appendChild((SHOT_ICONS[state] || SHOT_ICONS.idle)());
  const fixed = (prop, value) => btn.style.setProperty(prop, value, 'important');
  fixed('box-sizing', 'border-box');
  fixed('width', '26px');
  fixed('height', '26px');
  fixed('min-width', '26px');
  fixed('max-width', '26px');
  fixed('min-height', '26px');
  fixed('max-height', '26px');
  fixed('padding', '0');
  fixed('flex', '0 0 auto');
  fixed('align-self', 'center');
  fixed('background', 'transparent');
  fixed('border', '0');
  fixed('color', tone.fg);
  fixed('display', 'inline-flex');
  fixed('align-items', 'center');
  fixed('justify-content', 'center');
  fixed('font', 'inherit');
  fixed('cursor', 'pointer');
  // Spaced by the toolbar's gap, like the post button beside it.
  fixed('margin-left', '0');
  fixed('flex-shrink', '0');
  fixed('transition', 'color .18s ease, transform .12s ease');
  fixed('opacity', '1');
  const label = SHOT_LABELS[state] || SHOT_LABELS.idle;
  btn.setAttribute('aria-label', 'Post to WhatsApp: ' + label);
  btn.title = 'Post to WhatsApp — ' + label;
  btn.dataset.shotState = state;
}

// Screenshot button wiring. Kept beside the post button so the two share
// the same feedback path.
function wireShotButton(btn) {
  renderShotButton(btn, 'idle');

  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // One screenshot at a time per button: a second click while the first
    // is still in flight would queue a duplicate send.
    if (btn.disabled) return;
    const requestId = 'shot-' + Date.now();

    // The post is found from where the button actually is, so the crop is of
    // this post alone - never the timeline or a thread wrapper, which holds
    // more than one post and is refused.
    const currentArticle = shotContainer(btn);
    if (!currentArticle) {
      renderShotButton(btn, 'error');
      showSnackbar('error', 'Could not capture', shotErrorHint('no-article'));
      setTimeout(() => renderShotButton(btn, 'idle'), 4000);
      return;
    }

    btn.disabled = true;
    renderShotButton(btn, 'working');

    // Bring the post into view before measuring: captureBeyondViewport can
    // reach below the fold, but a post scrolled off entirely has nothing to
    // anchor to, and this also means the user sees what was captured.
    const rect = currentArticle.getBoundingClientRect();
    const clip = shotClip(
      rect, window.scrollX, window.scrollY,
      document.documentElement.scrollWidth, document.documentElement.scrollHeight,
    );
    if (!clip) {
      btn.disabled = false;
      renderShotButton(btn, 'error');
      showSnackbar('error', 'Could not capture', shotErrorHint('capture-too-small'));
      setTimeout(() => renderShotButton(btn, 'idle'), 4000);
      return;
    }

    let tweetId = null;
    let tweetUrl = null;
    try { tweetId = tweetIdFromArticle(currentArticle); } catch { /* no id */ }
    try {
      const link = currentArticle.querySelector('a[href*="/status/"]');
      if (link) tweetUrl = new URL(link.href, location.href).href;
    } catch { /* no permalink */ }

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'SEND_SCREENSHOT',
        requestId,
        clip,
        dedupeKey: shotKey(tweetId) || `shot:${requestId}`,
        post: { tweetId, tweetUrl },
      });
    } catch (e) {
      result = { ok: false, error: 'Failed to fetch' };
    }

    btn.disabled = false;
    const where = await channelName();
    if (result && result.ok) {
      renderShotButton(btn, 'success');
      showSnackbar('success',
        where ? 'Screenshot sent to ' + where : 'Screenshot sent',
        'The image of this post is in the channel.');
    } else if (result && result.partial) {
      renderShotButton(btn, 'error');
      showSnackbar('info', 'Screenshot partly sent',
        'The channel received it, but something did not send cleanly.');
    } else {
      const code = (result && result.error) || 'capture-failed';
      renderShotButton(btn, 'error');
      showSnackbar('error', 'Could not capture', shotErrorHint(code));
    }
    // Unlike the post button this returns to idle: a screenshot is a
    // one-off, and leaving a permanent tick would claim the post has been
    // captured when it may not have been.
    setTimeout(() => { if (btn.isConnected) renderShotButton(btn, 'idle'); }, 4000);
  });
}

// --- snackbar ------------------------------------------------------------
// The button is icon-only, so the outcome is also reported in a snackbar at
// the bottom centre. It is built from inline styles only (like the button),
// because injecting a stylesheet into the page can be blocked by its CSP;
// the slide-in is a transition triggered by a style change, which needs no
// keyframes.
const SNACKBAR_TONES = {
  success: { accent: '#00a884', icon: 'check' },
  error:   { accent: '#f4212e', icon: 'cross' },
  info:    { accent: '#1d9bf0', icon: 'info' },
};
const SNACKBAR_MS = { success: 4500, info: 5000, error: 8000 };

function snackbarHost() {
  let host = document.getElementById('__xwap-snackbar-host');
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.id = '__xwap-snackbar-host';
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Post to WhatsApp notifications');
  host.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'z-index:2147483647', 'display:flex', 'flex-direction:column-reverse',
    'align-items:center', 'gap:8px', 'pointer-events:none',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    'max-width:100vw',
  ].join(';') + ';';
  (document.body || document.documentElement).appendChild(host);
  return host;
}

// A disc in the tone colour with the glyph punched out of it, so the glyph
// shows the dark card behind it. evenodd punches the glyph out regardless of
// which way each subpath happens to wind; without it the "i" disappears.
function snackbarIcon(kind, color) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' });
  const path = (d) => svg.appendChild(svgEl('path', { fill: color, 'fill-rule': 'evenodd', d }));
  if (kind === 'check') {
    path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-1.2 14.6-4.2-4.2 1.6-1.6 2.6 2.6 5.4-5.4 1.6 1.6z');
  } else if (kind === 'cross') {
    path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m5 13.59-1.41 1.42L12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12z');
  } else {
    path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-1 15h2v-2h-2zm0-4h2V7h-2z');
  }
  return svg;
}

// type: 'success' | 'error' | 'info'
function showSnackbar(type, title, detail) {
  const tone = SNACKBAR_TONES[type] || SNACKBAR_TONES.info;
  const host = snackbarHost();

  // Never let them pile up.
  while (host.children.length >= 3) host.removeChild(host.firstChild);

  const card = document.createElement('div');
  card.setAttribute('role', type === 'error' ? 'alert' : 'status');
  card.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  card.style.cssText = [
    'pointer-events:auto', 'display:flex', 'align-items:flex-start', 'gap:10px',
    'max-width:min(90vw,400px)', 'background:#15202b', 'color:#e7e9ea',
    'border-radius:12px', 'padding:12px 14px', 'font-size:13px', 'line-height:1.4',
    'box-shadow:0 10px 30px rgba(0,0,0,.38)', 'border-left:3px solid ' + tone.accent,
    'transform:translateY(14px)', 'opacity:0',
    'transition:transform .22s ease,opacity .22s ease',
  ].join(';') + ';';

  const iconWrap = document.createElement('span');
  iconWrap.style.cssText = 'display:flex;flex:0 0 auto;margin-top:1px;color:' + tone.accent + ';';
  iconWrap.appendChild(snackbarIcon(tone.icon, tone.accent));

  const text = document.createElement('div');
  text.style.cssText = 'flex:1 1 auto;min-width:0;';
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:600;';
  head.textContent = title;
  text.appendChild(head);
  if (detail) {
    const sub = document.createElement('div');
    sub.style.cssText = 'color:#8b98a5;font-size:12px;margin-top:2px;word-break:break-word;';
    sub.textContent = detail;
    text.appendChild(sub);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '\u00d7';
  close.style.cssText = 'background:none;border:0;color:#8b98a5;font-size:18px;line-height:1;cursor:pointer;padding:0 2px;flex:0 0 auto;';
  close.addEventListener('click', () => dismissSnackbar(card));

  card.appendChild(iconWrap);
  card.appendChild(text);
  card.appendChild(close);
  host.appendChild(card);

  // Next frame so the transition actually runs (initial -> final).
  requestAnimationFrame(() => {
    card.style.transform = 'translateY(0)';
    card.style.opacity = '1';
  });

  setTimeout(() => dismissSnackbar(card), SNACKBAR_MS[type] || 5000);
  return card;
}

function dismissSnackbar(card) {
  if (!card || !card.isConnected) return;
  card.style.transform = 'translateY(14px)';
  card.style.opacity = '0';
  setTimeout(() => { try { card.remove(); } catch {} }, 240);
}

// Plain-language explanations for the error codes the controller returns.
const ERROR_HINTS = {
  'whatsapp-not-ready': 'The controller is still connecting to WhatsApp. Try again in a moment.',
  'channel-not-permitted': 'This account cannot post in that channel. Pick a different one in the extension popup.',
  'permission-check-failed': 'Could not confirm posting permission just now. Please try again.',
  'duplicate-send': 'This post was already sent to that channel moments ago.',
  'empty-post': 'There was nothing to send.',
  'no-default-channel': 'Choose a destination channel in the extension popup first.',
  'video-media-unavailable': 'X did not provide a usable stream for this video.',
  'Failed to fetch': 'Lost contact with the controller. Check that it is running.',
};

function errorDetail(code) {
  return ERROR_HINTS[code] || code || 'unknown error';
}

// Name of the destination channel, for the success message.
function channelName() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['selectedChannelName', 'defaultChannelName'], (r) => {
        resolve((r && (r.selectedChannelName || r.defaultChannelName)) || '');
      });
    } catch { resolve(''); }
  });
}

// --- remembering what has been sent --------------------------------------
// A sent post keeps its tick. X re-creates post elements as you scroll, so
// holding that state only in the DOM would quietly turn the tick back into
// the WhatsApp icon; the ids are remembered instead, so the tick comes back
// with the post.
const SENT_KEY = 'sentPosts';
const SENT_MAX = 200;

// The permalink is the one thing every kind of post view agrees on.
function tweetIdFromArticle(article) {
  const fromAttr = article.getAttribute('data-tweet-id');
  if (fromAttr) return fromAttr;
  const link = article.querySelector('a[href*="/status/"]');
  const m = link && link.getAttribute('href').match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

// Reading storage is asynchronous, and a post that has already been sent must
// never be painted as the WhatsApp icon first. So the list is fetched once,
// as early as the content script runs, and kept in memory: by the time
// anything is injected the answer is already there and the tick can be
// applied synchronously, on the very first frame the post appears.
let sentMap = null;

const sentMapReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get([SENT_KEY], (r) => {
      sentMap = (r && r[SENT_KEY]) || {};
      resolve(sentMap);
    });
  } catch {
    sentMap = {};
    resolve(sentMap);
  }
});

function rememberSent(tweetId, where) {
  if (!tweetId) return;
  sentMapReady.then((map) => {
    map[tweetId] = { at: Date.now(), channel: where || '' };
    const keys = Object.keys(map);
    const oldest = keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      .slice(0, Math.max(0, keys.length - SENT_MAX));
    for (const k of oldest) delete map[k];
    try { chrome.storage.local.set({ [SENT_KEY]: map }); } catch { /* quota */ }
  });
}

function markSent(btn) {
  renderButton(btn, 'success', 'Sent');
  const action = buttonAction(btn);
  btn.title = action + ' \u2014 already sent';
  btn.setAttribute('aria-label', action + ': already sent');
}

// Restores the tick on a post that has already been sent. Synchronous once
// the list has arrived, which is the case for every post injected after the
// first moment of the page; the first one waits, and stays invisible rather
// than flashing the WhatsApp icon first.
function restoreSentState(article, btn) {
  const tweetId = tweetIdFromArticle(article);
  if (!tweetId) return Promise.resolve();
  if (sentMap) {
    if (sentMap[tweetId]) markSent(btn);
    return Promise.resolve();
  }
  return sentMapReady.then(() => {
    if (btn.isConnected && sentMap[tweetId]) markSent(btn); // may have scrolled away
  });
}

// Build one of the two send buttons. They are identical apart from what they
// send: the second also puts the author's name above the post. `named` lives on
// the element so every later state - including the restored "already sent"
// tick - keeps the right name for assistive tech and hover.
function createPostButton(article, named) {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (named) btn.setAttribute('data-xwap-named', '1');
  renderButton(btn, 'idle', 'Post to WhatsApp');
  // Hidden for the moment it takes to find out whether this post has already
  // been sent, so it can never be seen as untried first.
  btn.style.setProperty('visibility', 'hidden', 'important');
  restoreSentState(article, btn).then(() => {
    btn.style.setProperty('visibility', 'visible', 'important');
  }, () => { btn.style.setProperty('visibility', 'visible', 'important'); });
  btn.addEventListener('click', (ev) => onPostClick(ev, btn, named));
  return btn;
}

async function onPostClick(ev, btn, named) {
  ev.preventDefault();
  ev.stopPropagation();
  if (btn.disabled) return;
  const requestId = 'req-' + Date.now();
  try { xlog('info', 'button-click', { requestId, named: !!named, articleUrl: location.href }); } catch {}

  const currentArticle = btn.closest('article');
  if (!currentArticle) {
    renderButton(btn, 'error', 'Err');
    showSnackbar('error', 'Could not post', 'The post could not be read from the page.');
    xlog('error', 'extraction-failed', { requestId, error: 'no article' });
    return;
  }

  try { xlog('info', 'extraction-started', { requestId }); } catch {}
  let post = await window.__xwapExtractPostAsync(currentArticle);
  try { xlog('info', 'extraction-succeeded', { requestId, tweetId: post && post.tweetId, textLength: post && post.text ? post.text.length : 0, mediaTypes: post ? [post.hasImage ? 'image' : null, post.hasVideo ? 'video' : null].filter(Boolean) : [], error: post ? post.error : 'missing' }); } catch {}

  if (post.error) {
    renderButton(btn, 'error', 'Unsupported');
    showSnackbar('error', 'Could not post this one', 'X did not expose the text, link or media of this post.');
    xlog('error', 'extraction-failed', { requestId, error: post.error });
    setTimeout(() => renderButton(btn, 'idle', 'Post to WhatsApp'), 4000);
    return;
  }

  // Only the "name the author" button changes the post, and it changes only
  // the front of it, so the link-first order arranged above stays beneath the
  // name. With no author found the text goes through untouched.
  if (named) post = { ...post, text: withAuthorHeader(post.text, post.author) };

  btn.disabled = true;
  renderButton(btn, 'working', 'Sending…');
  // Once it is sent the tick stays put; only a failure reverts, so the
  // post can be tried again.
  let sent = false;
  try {
    const started = Date.now();
    try { xlog('info', 'send-started', { requestId, tweetId: post.tweetId, named: !!named, mediaTypes: post.hasImage ? ['image'] : [] }); } catch {}
    const result = await chrome.runtime.sendMessage({ type: 'SEND_POST', post, requestId });
    try { xlog('info', 'response-received', { requestId, jobId: result && result.jobId, durationMs: Date.now() - started }); } catch {}
    const total = (result && result.sent ? result.sent.length : 0) + (result && result.failures ? result.failures.length : 0);
    const where = await channelName();
    if (result && result.ok) {
      sent = true;
      renderButton(btn, 'success', 'Sent');
      rememberSent(post.tweetId, where);
      const count = result.sent ? result.sent.length : 0;
      showSnackbar('success', where ? 'Posted to ' + where : 'Posted to WhatsApp',
        count > 1 ? count + ' messages sent.' : 'Your post is in the channel.');
      try { xlog('info', 'send-succeeded', { requestId, tweetId: post.tweetId, jobId: result.jobId }); } catch {}
    } else if (result && result.partial) {
      const sentCount = result.sent ? result.sent.length : 0;
      renderButton(btn, 'partial', `Partial ${sentCount}/${total}`);
      showSnackbar('info', 'Partly posted',
        sentCount + ' of ' + total + ' items reached the channel — some media could not be fetched.');
      try { xlog('warn', 'send-partial', { requestId, tweetId: post.tweetId, jobId: result.jobId, sent: sentCount, failures: result.failures }); } catch {}
    } else {
      const code = (result && result.error) || 'failed';
      renderButton(btn, 'error', `Err: ${code}`);
      showSnackbar('error', 'Could not post', errorDetail(code));
      try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: result ? result.error : 'unknown' }); } catch {}
    }
  } catch (e) {
    renderButton(btn, 'error', 'Err');
    showSnackbar('error', 'Could not post', errorDetail('Failed to fetch'));
    try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: e && e.message }); } catch {}
  } finally {
    btn.disabled = false;
  }
  // Never wipe a tick: neither one this send just produced, nor one
  // restored while the send was running. A send still in flight is
  // left alone too, or a second click would be reset out from under
  // itself.
  if (!sent) {
    setTimeout(() => {
      const s = btn.dataset.state;
      if (s !== 'success' && s !== 'working') renderButton(btn, 'idle', 'Post to WhatsApp');
    }, 4000);
  }
}

function injectButton(article) {
  if (article[INJECTION_FLAG]) return;
  article[INJECTION_FLAG] = true;

  const bar = article.querySelector('div[role="group"]');
  if (!bar) return;

  // Both actions live in our own row beneath X's icons, not inside X's action
  // bar: the page's flex layout can no longer squeeze them, and later actions
  // have somewhere obvious to go.
  const toolbar = toolbarFor(bar);

  // The plain send button, and beside it a duplicate that also puts the
  // author's name above the post ("Imran Khan's Tweet").
  toolbar.appendChild(createPostButton(article, false));
  toolbar.appendChild(createPostButton(article, true));

  // The screenshot button sits beside the pair so the row reads as one group.
  const shotBtn = document.createElement('button');
  shotBtn.type = 'button';
  wireShotButton(shotBtn);
  toolbar.appendChild(shotBtn);
}

function scan() {
  for (const art of document.querySelectorAll('article')) {
    injectButton(art);
  }
}

const mo = new MutationObserver(scan);
mo.observe(document.body, { childList: true, subtree: true });
scan();