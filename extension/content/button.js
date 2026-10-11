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

function injectButton(article) {
  if (article[INJECTION_FLAG]) return;
  article[INJECTION_FLAG] = true;

  const bar = article.querySelector('div[role="group"]');
  if (!bar) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  renderButton(btn, 'idle', 'Post to WhatsApp');

  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    const requestId = 'req-' + Date.now();
    try { xlog('info', 'button-click', { requestId, articleUrl: location.href }); } catch {}

    const currentArticle = btn.closest('article');
    if (!currentArticle) {
      renderButton(btn, 'error', 'Err');
      xlog('error', 'extraction-failed', { requestId, error: 'no article' });
      return;
    }

    try { xlog('info', 'extraction-started', { requestId }); } catch {}
    const post = await window.__xwapExtractPostAsync(currentArticle);
    try { xlog('info', 'extraction-succeeded', { requestId, tweetId: post && post.tweetId, textLength: post && post.text ? post.text.length : 0, mediaTypes: post ? [post.hasImage ? 'image' : null, post.hasVideo ? 'video' : null].filter(Boolean) : [], error: post ? post.error : 'missing' }); } catch {}

    if (post.error) {
      renderButton(btn, 'error', 'Unsupported');
      xlog('error', 'extraction-failed', { requestId, error: post.error });
      setTimeout(() => renderButton(btn, 'idle', 'Post to WhatsApp'), 4000);
      return;
    }

    btn.disabled = true;
    renderButton(btn, 'working', 'Sending…');
    try {
      const started = Date.now();
      try { xlog('info', 'send-started', { requestId, tweetId: post.tweetId, mediaTypes: post.hasImage ? ['image'] : [] }); } catch {}
      const result = await chrome.runtime.sendMessage({ type: 'SEND_POST', post, requestId });
      try { xlog('info', 'response-received', { requestId, jobId: result && result.jobId, durationMs: Date.now() - started }); } catch {}
      const total = (result && result.sent ? result.sent.length : 0) + (result && result.failures ? result.failures.length : 0);
      if (result && result.ok) {
        renderButton(btn, 'success', 'Sent');
        try { xlog('info', 'send-succeeded', { requestId, tweetId: post.tweetId, jobId: result.jobId }); } catch {}
      } else if (result && result.partial) {
        renderButton(btn, 'partial', `Partial ${result.sent ? result.sent.length : 0}/${total}`);
        try { xlog('warn', 'send-partial', { requestId, tweetId: post.tweetId, jobId: result.jobId, sent: result.sent && result.sent.length, failures: result.failures }); } catch {}
      } else {
        renderButton(btn, 'error', `Err: ${(result && result.error) || 'failed'}`);
        try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: result ? result.error : 'unknown' }); } catch {}
      }
    } catch (e) {
      renderButton(btn, 'error', 'Err');
      try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: e && e.message }); } catch {}
    } finally {
      btn.disabled = false;
    }
    setTimeout(() => renderButton(btn, 'idle', 'Post to WhatsApp'), 4000);
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