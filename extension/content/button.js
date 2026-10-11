// Content script: inject the "Post to WhatsApp" button and delegate the
// actual work to the background worker.
//
// The button is a minimal icon that shows one glyph per state:
//   idle    WhatsApp glyph   (green)   -> post this to the Channel
//   working spinner         (grey)    -> posting
//   success check mark      (teal)    -> posted
//   partial warning         (amber)   -> partially posted
//   error   cross           (red)     -> not posted
//
// Icons are inline SVG built with createElementNS and animated with SMIL, so
// nothing is fetched and no stylesheet is injected into the page. There is no
// visible label: the meaning is carried by the glyph, and by aria-label and
// title so assistive technology and hover still explain what it does and what
// state it is in.
const INJECTION_FLAG = '__xwapButtonInjected';
const SVG_NS = 'http://www.w3.org/2000/svg';

const BUTTON_STYLES = {
  idle:    { bg: '#25d366', fg: '#fff', border: 'transparent' },
  working: { bg: '#eff3f4', fg: '#536471', border: '#cfd9de' },
  success: { bg: '#00a884', fg: '#fff', border: 'transparent' },
  partial: { bg: '#e8912d', fg: '#fff', border: 'transparent' },
  error:   { bg: '#f4212e', fg: '#fff', border: 'transparent' },
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
function whatsappIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(svgEl('path', {
    fill: 'currentColor',
    d: 'M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2m0 18.15h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.17 8.17 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23a8.2 8.2 0 0 1 5.83 2.42 8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.23-8.24 8.23m4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.79.97-.14.16-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.24-1.47-1.38-1.72-.15-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.41-.56-.42h-.48c-.16 0-.43.06-.65.31s-.86.84-.86 2.05.88 2.38 1 2.54c.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.23-.16-.48-.28',
  }));
  return svg;
}

function spinnerIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true', focusable: 'false' });
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

function badgeIcon(pathD, bg) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '15', height: '15', 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(svgEl('circle', { cx: '12', cy: '12', r: '11', fill: 'rgba(255,255,255,0.22)' }));
  svg.appendChild(svgEl('path', { fill: '#fff', d: pathD }));
  return svg;
}

const ICONS = {
  success: () => badgeIcon('M9.55 17.6 4.4 12.45l1.65-1.65 3.5 3.5 8.1-8.1 1.65 1.65z', '#00a884'),
  error:   () => badgeIcon('M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z', '#f4212e'),
  partial: () => badgeIcon('M11 5h2v8h-2zm0 10h2v2h-2z', '#e8912d'),
};

// --- rendering -----------------------------------------------------------
function renderButton(btn, state, label) {
  const tone = BUTTON_STYLES[state] || BUTTON_STYLES.idle;
  const icon = state === 'idle' ? whatsappIcon()
    : state === 'working' ? spinnerIcon()
    : (ICONS[state] || ICONS.error)();

  btn.textContent = '';
  btn.appendChild(icon);
  btn.style.background = tone.bg;
  btn.style.color = tone.fg;
  btn.style.border = '1px solid ' + tone.border;
  btn.style.borderRadius = '50%';
  btn.style.width = '26px';
  btn.style.height = '26px';
  btn.style.padding = '0';
  btn.style.display = 'inline-flex';
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.font = 'inherit';
  btn.style.cursor = 'pointer';
  btn.style.marginLeft = '6px';
  btn.style.verticalAlign = 'middle';
  btn.style.flexShrink = '0';
  btn.style.transition = 'background-color .18s ease, transform .12s ease';
  btn.style.opacity = '1';
  // Icon-only: name the control and its state for assistive tech and hover.
  btn.setAttribute('aria-label', 'Post to WhatsApp: ' + label);
  btn.title = 'Post to WhatsApp — ' + label;
  btn.dataset.state = state;
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

function rememberSent(tweetId, where) {
  if (!tweetId) return;
  try {
    chrome.storage.local.get([SENT_KEY], (r) => {
      const map = (r && r[SENT_KEY]) || {};
      map[tweetId] = { at: Date.now(), channel: where || '' };
      const keys = Object.keys(map);
      const oldest = keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
        .slice(0, Math.max(0, keys.length - SENT_MAX));
      for (const k of oldest) delete map[k];
      try { chrome.storage.local.set({ [SENT_KEY]: map }); } catch { /* quota */ }
    });
  } catch { /* no storage available */ }
}

// Restores the tick on a post that has already been sent. The read is async,
// so the button is drawn first and corrected a moment later.
function restoreSentState(article, btn) {
  const tweetId = tweetIdFromArticle(article);
  if (!tweetId) return;
  try {
    chrome.storage.local.get([SENT_KEY], (r) => {
      if (!btn.isConnected) return; // the post scrolled away mid-read
      if (r && r[SENT_KEY] && r[SENT_KEY][tweetId]) {
        renderButton(btn, 'success', 'Sent');
        btn.title = 'Post to WhatsApp \u2014 already sent';
        btn.setAttribute('aria-label', 'Post to WhatsApp: already sent');
      }
    });
  } catch { /* no storage available */ }
}

function injectButton(article) {
  if (article[INJECTION_FLAG]) return;
  article[INJECTION_FLAG] = true;

  const bar = article.querySelector('div[role="group"]');
  if (!bar) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  renderButton(btn, 'idle', 'Post to WhatsApp');
  restoreSentState(article, btn);

  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    const requestId = 'req-' + Date.now();
    try { xlog('info', 'button-click', { requestId, articleUrl: location.href }); } catch {}

    const currentArticle = btn.closest('article');
    if (!currentArticle) {
      renderButton(btn, 'error', 'Err');
      showSnackbar('error', 'Could not post', 'The post could not be read from the page.');
      xlog('error', 'extraction-failed', { requestId, error: 'no article' });
      return;
    }

    try { xlog('info', 'extraction-started', { requestId }); } catch {}
    const post = await window.__xwapExtractPostAsync(currentArticle);
    try { xlog('info', 'extraction-succeeded', { requestId, tweetId: post && post.tweetId, textLength: post && post.text ? post.text.length : 0, mediaTypes: post ? [post.hasImage ? 'image' : null, post.hasVideo ? 'video' : null].filter(Boolean) : [], error: post ? post.error : 'missing' }); } catch {}

    if (post.error) {
      renderButton(btn, 'error', 'Unsupported');
      showSnackbar('error', 'Could not post this one', 'X did not expose the text, link or media of this post.');
      xlog('error', 'extraction-failed', { requestId, error: post.error });
      setTimeout(() => renderButton(btn, 'idle', 'Post to WhatsApp'), 4000);
      return;
    }

    btn.disabled = true;
    renderButton(btn, 'working', 'Sending…');
    // Once it is sent the tick stays put; only a failure reverts, so the
    // post can be tried again.
    let sent = false;
    try {
      const started = Date.now();
      try { xlog('info', 'send-started', { requestId, tweetId: post.tweetId, mediaTypes: post.hasImage ? ['image'] : [] }); } catch {}
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
  });

  bar.appendChild(btn);
}

function scan() {
  for (const art of document.querySelectorAll('article')) {
    injectButton(art);
  }
}

const mo = new MutationObserver(scan);
mo.observe(document.body, { childList: true, subtree: true });
scan();