// Content script: tweet detection and exact text/URL/media extraction.
function findTweetText(article) {
  // Walk direct children only within the current article to avoid picking up
  // nested tweet/quote text from deeper <article> elements.
  const searchRoot = article.querySelector('[data-testid="tweetText"]');
  if (!searchRoot) return '';
  // `tweetText` itself can contain paragraphs; innerText preserves them.
  return searchRoot.innerText;
}

function findTweetUrl(article) {
  const t = article.querySelector('time');
  const a = t && t.closest('a');
  return a ? a.href : null;
}

function findTweetId(url) {
  const m = /\/status\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

function findPhotoLinks(article) {
  // Only keep media links whose nearest <article> is the article we were
  // asked about (not nested quotes/reposts in another article).
  const out = [];
  for (const a of article.querySelectorAll('a[href*="/photo/"]')) {
    if (a.closest('article') !== article) continue;
    try {
      out.push(new URL(a.href, location.origin).href);
    } catch {}
  }
  return Array.from(new Set(out));
}

// Distinct media image URLs in the clicked post, in original order.
// og:image on a /photo/ page only ever returns the FIRST image, so for
// multi-image posts we read the article's <img> elements directly. The
// media id (path before the query) is the dedupe key; X serves the same
// image at multiple sizes/formats.
function findMediaUrls(article) {
  const seen = new Set();
  const out = [];
  for (const img of article.querySelectorAll('img[src*="pbs.twimg.com/media"]')) {
    if (img.closest('article') !== article) continue;
    let src = img.getAttribute('src') || img.src;
    try {
      const u = new URL(src, location.origin);
      const id = u.pathname.split('/').pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Prefer a large variant; X ignores unknown params but honours name.
      u.searchParams.set('format', 'webp');
      u.searchParams.set('name', 'large');
      out.push(u.href);
    } catch {}
  }
  return out;
}

// Reliable media recovery fallback. X's SPA can defer lazy images in
// headless / low-activity contexts so the live DOM ends up with no
// rendered <img> even though the post has photos (the /photo/ links
// remain). In that case, fetch the tweet's server-rendered HTML and
// read the media <img> elements straight from the clicked post's own
// article, excluding nested quoted-tweet articles.
async function recoverMediaUrls(article, post) {
  const expected = post.photoHrefs ? post.photoHrefs.length : 0;
  const have = post.mediaUrls ? post.mediaUrls.length : 0;
  // The live DOM already accounts for every photo the post has (or
  // the post rendered image elements without /photo/ wrappers):
  // there is nothing left to recover.
  if (have >= expected && (expected > 0 || have > 0)) return post;
  if (!post.hasImage) return post;
  try {
    const resp = await fetch(post.tweetUrl, { credentials: 'omit' });
    if (!resp.ok) {
      _xlog('warn', 'tweet-media-fetch-failed', { tweetId: post.tweetId, status: resp.status });
      return post;
    }
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const target = '/status/' + post.tweetId;
    for (const art of doc.querySelectorAll('article')) {
      // Skip nested articles (a quoted tweet rendered inside another article).
      if (art.parentElement && art.parentElement.closest('article')) continue;
      // The server-rendered article has no <time> element (that is added
      // during hydration), so match by the post's own permalink link
      // (/…/status/<id>). /photo/ links share the id but end in
      // /photo/<n> and therefore never match.
      let isTarget = false;
      for (const a of art.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const path = href.split('?')[0].split('#')[0];
        if (path.endsWith(target)) { isTarget = true; break; }
      }
      if (!isTarget) continue;
      const urls = findMediaUrls(art);
      if (urls.length > 0) {
        _xlog('info', 'tweet-media-recovered', { tweetId: post.tweetId, count: urls.length });
        return { ...post, mediaUrls: urls, hasImage: true };
      }
    }
    _xlog('warn', 'tweet-media-not-found', { tweetId: post.tweetId });
  } catch (e) {
    _xlog('warn', 'tweet-media-recover-error', { tweetId: post.tweetId, error: e && e.message });
  }
  return post;
}

function hasVideo(article) {
  const v = article.querySelector('video');
  if (!v) return false;
  // If the video element is attributed to a nested <article>, skip it.
  return v.closest('article') === article;
}

// --- Link recovery ---
// X renders post links as <a href="https://t.co/..."> anchors whose visible
// text is the (often wrapped and "…"-truncated) display URL. For posts where
// the URL renders as a link-preview card, the anchor lives inside
// [data-testid="card.wrapper"] and the URL is absent from tweetText entirely.
// The canonical URL is recovered by resolving the t.co href.

function isContentLinkAnchor(a, opts) {
  const href = a.href || '';
  if (!href.startsWith('http')) return false;
  // Media and telemetry links are not post content.
  if (href.includes('/photo/') || href.includes('/analytics')) return false;
  try {
    const u = new URL(href);
    if (u.hostname === 'x.com' || u.hostname === 'twitter.com') {
      const path = u.pathname;
      if (path.startsWith('/hashtag/')) return false;
      // Links to other X posts are content when the author placed
      // them inside the tweet text. Inside a preview card they belong
      // to a quoted tweet and must stay excluded.
      if (/\/status\/\d+/.test(path) && !(opts && opts.allowStatusLinks)) return false;
      // Profile links (no deeper path) are mentions, not content links.
      if (path.split('/').filter(Boolean).length <= 1) return false;
    }
  } catch { return false; }
  return true;
}

function findTweetLinks(article) {
  const out = [];
  const push = (a, inText, opts) => {
    // Only links whose nearest <article> is this article (excludes quoted
    // tweets rendered as nested articles) and not inside a quote container.
    if (!a || a.closest('article') !== article) return;
    if (a.closest('[data-testid="quoteTweet"]')) return;
    const href = a.href;
    // No href dedup: the same shortlink may appear both inline and in the
    // preview card (and even twice inline); each occurrence must be
    // processed so every wrapped display gets replaced.
    if (!href || !isContentLinkAnchor(a, opts)) return;
    out.push({ href, display: a.innerText || '', inText });
  };
  const tweetText = article.querySelector('[data-testid="tweetText"]');
  if (tweetText) {
    // Links inside the tweet text were placed by the author,
    // including links to other X posts.
    for (const a of tweetText.querySelectorAll('a')) push(a, true, { allowStatusLinks: true });
  }
  // Link-preview cards: large cards keep the URL only inside the card.
  const card = article.querySelector('[data-testid="card.wrapper"]');
  if (card) {
    for (const a of card.querySelectorAll('a')) push(a, false);
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flatDisplayUrl(display) {
  return (display || '').replace(/\n+/g, '').trim();
}

// Display URL as a URL: wrapped display text collapsed, with X's
// trailing truncation marker stripped.
function cleanDisplayUrl(display) {
  return flatDisplayUrl(display).replace(/…+\s*$/, '').trim();
}

// Replace a wrapped/truncated URL display inside the extracted text with
// the canonical URL, preserving its logical position. The display text
// may be split across lines at arbitrary points, so newlines are
// tolerated between every character when matching.
function replaceDisplayInText(text, display, replacement) {
  const flat = flatDisplayUrl(display);
  if (!flat || !replacement) return text;
  const pattern = flat.split('').map(escapeRegExp).join('\\n?');
  try {
    // Global: the same URL can appear more than once in a post
    // (e.g. repeated links); every occurrence must be recovered.
    return text.replace(new RegExp(pattern, 'g'), replacement);
  } catch { return text; }
}

function textIncludesUrl(text, url) {
  return Boolean(text && url && (text.includes(url) || text.includes(cleanDisplayUrl(url))));
}

async function resolveLinkUrls(hrefs) {
  if (!hrefs.length) return {};
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RESOLVE_LINKS', hrefs });
    if (resp && resp.ok && resp.resolved) return resp.resolved;
  } catch (e) {
    _xlog('warn', 'link-resolve-unavailable', { error: e && e.message });
  }
  return {};
}

async function recoverPostLinks(article, post) {
  const links = findTweetLinks(article);
  if (!links.length) return post;
  const resolvedMap = await resolveLinkUrls(links.map((link) => link.href));
  let text = post.text;
  const appended = [];
  for (const link of links) {
    const resolved = resolvedMap[link.href];
    // Fallbacks: inline links keep their (possibly truncated) display
    // URL; card-only links keep the t.co href itself — a card's
    // display text is its title and must never be sent as a URL.
    const finalUrl = resolved
      || (link.inText ? cleanDisplayUrl(link.display) : null)
      || link.href;
    if (!finalUrl) continue;
    if (link.inText) {
      text = replaceDisplayInText(text, link.display, finalUrl);
    }
    if (!textIncludesUrl(text, finalUrl)) appended.push(finalUrl);
  }
  if (appended.length) {
    text = text.trim();
    text = (text ? text + '\n' : '') + appended.join('\n');
  }
  if (text !== post.text) {
    _xlog('info', 'tweet-links-recovered', { tweetId: post.tweetId, links: links.length, appended: appended.length });
    return { ...post, text };
  }
  return post;
}

function extractPost(article) {
  const url = findTweetUrl(article);
  if (!url) return { error: 'no-tweet-url' };
  const id = findTweetId(url);
  if (!id) return { error: 'no-tweet-id', url };
  const text = findTweetText(article);
  return {
    tweetId: id,
    tweetUrl: url,
    text,
    hasImage: findPhotoLinks(article).length > 0 || findMediaUrls(article).length > 0,
    hasVideo: hasVideo(article),
    photoHrefs: findPhotoLinks(article),
    mediaUrls: findMediaUrls(article),
  };
}

window.__xwapExtractPost = extractPost;

function _xlog(level, event, data) {
  const rec = { ts: new Date().toISOString(), level, component: 'content', event, ...(data || {}) };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`${level} ${event}`); }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _findExpandControl(article) {
  const candidates = article.querySelectorAll('a, button, span, div[role="button"]');
  for (const el of candidates) {
    const txt = (el.innerText || '').trim().toLowerCase();
    if (txt === 'read more' || txt === 'show more' || txt.startsWith('read more') || txt.startsWith('show more')) {
      return el;
    }
  }
  return null;
}

async function extractPostAsync(article) {
  // Sync extraction first; this preserves normal short posts.
  let post = extractPost(article);
  if (post.error) return post;

  const expand = _findExpandControl(article);
  if (expand) {
    _xlog('info', 'tweet-expand-started', { tweetId: post.tweetId });
    try {
      expand.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch {}
    try { expand.click(); } catch {}

    const originalLength = post.text.length;
    let expanded = false;
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      const next = extractPost(article);
      if (next && !next.error && next.text && next.text.length > originalLength) {
        post = next;
        expanded = true;
        break;
      }
    }

    if (!expanded) {
      _xlog('warn', 'tweet-expand-failed', { tweetId: post.tweetId, info: 'text-length-unchanged' });
      return { error: 'tweet-text-truncated', url: post.tweetUrl, tweetId: post.tweetId };
    }

    _xlog('info', 'tweet-expanded', { tweetId: post.tweetId, before: originalLength, after: post.text.length });
  } else {
    _xlog('info', 'tweet-truncated-no-expand-control', { tweetId: post.tweetId });
  }

  // Recover media URLs from the server-rendered HTML when the live DOM
  // has no rendered images (headless / lazy-load deferral).
  post = await recoverMediaUrls(article, post);

  // Recover canonical URLs hidden behind X link previews / wrapped link displays.
  return recoverPostLinks(article, post);
}

window.__xwapExtractPostAsync = extractPostAsync;
