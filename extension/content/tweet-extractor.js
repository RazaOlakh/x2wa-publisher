// Content script: tweet detection and exact text/URL/media extraction.
function findTweetText(article) {
  // Walk direct children only within the current article to avoid picking up
  // nested tweet/quote text from deeper <article> elements.
  const searchRoot = article.querySelector('[data-testid="tweetText"]');
  if (!searchRoot) return '';
  // The first text in the post belongs to the post itself. Text inside a
  // quoted post's card belongs to that inner post, so a quote-tweet with no
  // words of its own has an empty text rather than the quoted post's words.
  if (searchRoot.closest && searchRoot.closest('[data-testid="quoteTweet"]')) return '';
  if (searchRoot.closest && searchRoot.closest('article') !== article) return '';
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

// --- Author name ---
// The author's display name sits in [data-testid="User-Name"], beside a link to
// the profile: the first anchor is the name, the second is the @handle, and a
// third (a /status/ link) is the timestamp. Only the name is wanted, so the
// handle and the timestamp are skipped rather than guessed from position.

// Collapse X's whitespace so a name that wraps cannot carry a newline into the
// middle of a post's first line.
function normalizeAuthorName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Pick the display name from the User-Name block's anchors. Pure, so the rule
// can be tested without a browser: the first anchor that is neither the @handle
// nor the timestamp link is the name.
function pickAuthorName(anchors) {
  for (const a of anchors || []) {
    const text = normalizeAuthorName(a && a.text);
    if (!text) continue;
    if (text.charAt(0) === '@') continue;                 // the @handle
    if (/\/status\//.test((a && a.href) || '')) continue;  // the timestamp
    if (/^[·•]$/.test(text)) continue;                     // the separator dot
    return text;
  }
  return null;
}

function pickAuthorHandle(anchors) {
  for (const a of anchors || []) {
    const text = normalizeAuthorName(a && a.text);
    if (!text) continue;
    if (text.charAt(0) === '@') return text;
  }
  return null;
}

function findTweetAuthor(article) {
  if (!article || !article.querySelectorAll) return null;
  const blocks = article.querySelectorAll('[data-testid="User-Name"]');
  for (const block of blocks) {
    // The post's own name block, never one belonging to a quoted post nested
    // inside this article (those render their own <article>).
    if (block.closest && block.closest('article') !== article) continue;
    if (block.closest && block.closest('[data-testid="quoteTweet"]')) continue;
    const anchors = [];
    const found = block.querySelectorAll ? block.querySelectorAll('a') : [];
    for (const a of found) {
      anchors.push({ text: a.innerText || a.textContent || '', href: a.getAttribute('href') || '' });
    }
    const name = pickAuthorName(anchors);
    if (name) return name;
  }
  return null;
}

function findTweetAuthorHandle(article) {
  if (!article || !article.querySelectorAll) return null;
  const blocks = article.querySelectorAll('[data-testid="User-Name"]');
  for (const block of blocks) {
    if (block.closest && block.closest('article') !== article) continue;
    if (block.closest && block.closest('[data-testid="quoteTweet"]')) continue;
    const anchors = [];
    const found = block.querySelectorAll ? block.querySelectorAll('a') : [];
    for (const a of found) {
      anchors.push({ text: a.innerText || a.textContent || '', href: a.getAttribute('href') || '' });
    }
    const handle = pickAuthorHandle(anchors);
    if (handle) return handle;
  }
  return null;
}

// --- The post's language ---
// Urdu is written in the Arabic script, and X hands us plain text with no
// language tag. Counting the Arabic-script letters against the Latin ones tells
// the two apart without a network call. Links are dropped first: an otherwise
// Urdu post carrying a long t.co URL is full of Latin letters, and that link
// must not decide the post is English.
const ARABIC_SCRIPT_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_LETTER = /[A-Za-z]/;

function withoutLinks(text) {
  return String(text == null ? '' : text)
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\bt\.co\/\S+/gi, ' ');
}

// True when a post reads as Urdu: it has Arabic-script letters and more of them
// than Latin ones. A single Urdu word inside an English post does not flip it,
// and a post with no letters at all (emoji, numbers) reads as English.
function isUrduText(text) {
  let arabic = 0;
  let latin = 0;
  for (const ch of withoutLinks(text)) {
    if (ARABIC_SCRIPT_LETTER.test(ch)) arabic++;
    else if (LATIN_LETTER.test(ch)) latin++;
  }
  return arabic > latin;
}

// The line that goes above a post when it is sent in "name the author" mode:
// the author's name, and nothing else. The name is written in the post's own
// language (see button.js - an Urdu post's name is translated first), so an
// English post is headed "Imran Khan" and an Urdu one "عمران خان". Empty when
// there is no name to show.
function authorHeader(name) {
  return normalizeAuthorName(name);
}

// Put the author's name above the post. The rest of the text is only trimmed at
// its ends, so the link-first reorder and any blank lines inside it survive
// untouched. With no name the text is returned exactly as it was.
function withAuthorHeader(text, name) {
  const header = authorHeader(name);
  if (!header) return text || '';
  const body = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
  return body ? header + '\n\n' + body : header;
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

// --- Mixed media extraction (images + videos, original order) ---
//
// X exposes a video through two URLs that share one id:
//   poster: pbs.twimg.com/amplify_video_thumb/<id>/img/<name>.jpg
//   stream: video.twimg.com/amplify_video/<id>/pl/<token>.m3u8
// (older posts use ext_tw_video_thumb / ext_tw_video for the same shape)
// That shared id is what lets the background worker match a captured HLS
// manifest to one specific video instead of "the newest one on the page".
const VIDEO_ID_RE = /(?:amplify|ext_tw)_video(?:_thumb)?\/([A-Za-z0-9_-]+)/;

function videoIdFromUrl(u) {
  const m = VIDEO_ID_RE.exec(u || '');
  return m ? m[1] : null;
}

// Master playlists carry every stream and their path holds no codec or
// resolution directory (/pl/k_<token>.m3u8, or /pu/pl/<token>.m3u8 for the
// older ext_tw_video shape); renditions nest those directories instead
// (/pl/avc1/720x720/tok.m3u8, audio-only /pl/mp4a/32000/tok.m3u8). Only the
// master is the right source to hand to ffmpeg.
const RENDITION_DIRS = /^(?:avc1|hev1|hvc1|vp9|av01|mp4a|vid|aud|\d+x\d+)$/;
function isMasterPlaylist(rest) {
  const parts = rest.replace(/\?.*$/, '').split('/');
  parts.pop();
  return !parts.some((seg) => RENDITION_DIRS.test(seg));
}

// All HLS manifests in a document, keyed by the video id in their path.
// Used on the server-rendered HTML, where the manifests live outside the
// <article> but still name their video explicitly.
function findHlsSources(html) {
  const out = {};
  const re = /https:\/\/video\.twimg\.com\/(?:amplify|ext_tw)_video\/([A-Za-z0-9_-]+)\/([^"'\s\\<>]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!/\.m3u8(?:\?|$)/.test(m[2])) continue;
    const rec = out[id] || (out[id] = { master: null, variants: [] });
    if (isMasterPlaylist(m[2])) { if (!rec.master) rec.master = m[0]; }
    else if (rec.variants.indexOf(m[0]) === -1 && rec.variants.length < 8) rec.variants.push(m[0]);
  }
  return out;
}

// Ordered media items of the clicked post, images and videos interleaved
// exactly as X renders them. The poster <img> X draws beside a <video> is
// folded into that video instead of being reported as an extra image, and
// a video whose poster carries no id is still reported (with a null id) so
// it surfaces as a failure rather than being dropped.
function findMediaItems(article) {
  const items = [];
  const seenVideo = new Set();
  const seenImage = new Set();
  const sel = 'video[poster], img[src*="pbs.twimg.com/media"], img[src*="amplify_video_thumb"], img[src*="ext_tw_video_thumb"]';
  for (const el of article.querySelectorAll(sel)) {
    // Skip media belonging to a nested quoted/reposted article.
    if (el.closest('article') !== article) continue;
    if (el.tagName === 'VIDEO') {
      const poster = el.getAttribute('poster') || '';
      const id = videoIdFromUrl(poster);
      const key = id || 'poster:' + poster;
      if (seenVideo.has(key)) continue;
      seenVideo.add(key);
      items.push({ type: 'video', videoId: id || null });
      continue;
    }
    const src = el.getAttribute('src') || '';
    const vid = videoIdFromUrl(src);
    if (vid) {
      if (seenVideo.has(vid)) continue;
      seenVideo.add(vid);
      items.push({ type: 'video', videoId: vid });
      continue;
    }
    // X serves one image at several sizes; the media id is the dedupe key.
    try {
      const u = new URL(src, location.origin);
      const id = u.pathname.split('/').pop();
      if (!id || seenImage.has(id)) continue;
      seenImage.add(id);
      u.searchParams.set('format', 'webp');
      u.searchParams.set('name', 'large');
      items.push({ type: 'image', url: u.href });
    } catch {}
  }
  return items;
}

// Distinct media image URLs in the clicked post, in original order.
// og:image on a /photo/ page only ever returns the FIRST image, so for
// multi-image posts we read the article's <img> elements directly.
function findMediaUrls(article) {
  return findMediaItems(article).filter((m) => m.type === 'image').map((m) => m.url);
}

// Reliable media recovery fallback. X's SPA can defer lazy images in
// headless / low-activity contexts so the live DOM ends up with no
// rendered <img> even though the post has photos (the /photo/ links
// remain). In that case, fetch the tweet's server-rendered HTML and
// read the media elements straight from the clicked post's own article,
// excluding nested quoted-tweet articles. That document also carries the
// HLS manifests, each naming its own video id, so videos the live DOM
// could not identify are recovered here too.
async function recoverMedia(article, post) {
  const expected = post.photoHrefs ? post.photoHrefs.length : 0;
  const items = post.mediaItems || [];
  const haveImages = items.filter((m) => m.type === 'image').length;
  const unidentifiedVideo = items.some((m) => m.type === 'video' && !m.videoId);
  // The live DOM already accounts for every photo the post has (or the
  // post rendered image elements without /photo/ wrappers) and every
  // video it rendered carries an id: nothing left to recover.
  if (!unidentifiedVideo && haveImages >= expected && (expected > 0 || haveImages > 0)) return post;
  if (!post.hasImage && !post.hasVideo) return post;
  try {
    const resp = await fetch(post.tweetUrl, { credentials: 'omit' });
    if (!resp.ok) {
      _xlog('warn', 'tweet-media-fetch-failed', { tweetId: post.tweetId, status: resp.status });
      return post;
    }
    const html = await resp.text();
    const hls = findHlsSources(html);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const target = '/status/' + post.tweetId;
    for (const art of doc.querySelectorAll('article')) {
      // Skip nested articles (a quoted tweet rendered inside another article).
      if (art.parentElement && art.parentElement.closest('article')) continue;
      // The server-rendered article has no <time> element (that is added
      // during hydration), so match by the post's own permalink link
      // (/.../status/<id>). /photo/ links share the id but end in
      // /photo/<n> and therefore never match.
      let isTarget = false;
      for (const a of art.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const path = href.split('?')[0].split('#')[0];
        if (path.endsWith(target)) { isTarget = true; break; }
      }
      if (!isTarget) continue;
      const recovered = findMediaItems(art);
      // A video the live DOM rendered without a poster id can still be
      // named here; carry that id back onto the live item in place.
      for (let i = 0; i < recovered.length; i++) {
        const r = recovered[i];
        if (r.type !== 'video' || r.videoId) continue;
        const live = items.find((m) => m.type === 'video' && !m.videoId);
        if (live) { live.videoId = r.videoId; break; }
      }
      _xlog('info', 'tweet-media-recovered', { tweetId: post.tweetId, items: recovered.length, hls: Object.keys(hls).length });
      const next = { ...post, hlsSources: hls };
      if (recovered.length) {
        next.mediaItems = recovered;
        next.mediaUrls = recovered.filter((m) => m.type === 'image').map((m) => m.url);
        next.hasImage = post.hasImage || next.mediaUrls.length > 0;
        next.hasVideo = post.hasVideo || recovered.some((m) => m.type === 'video');
      }
      return next;
    }
    _xlog('warn', 'tweet-media-not-found', { tweetId: post.tweetId });
    return Object.keys(hls).length ? { ...post, hlsSources: hls } : post;
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

// Close the gap a removed link leaves behind, without disturbing the lines on
// either side of it. A link that had a line to itself leaves no blank line; one
// that sat inside a sentence leaves a single space, not two.
function joinAroundLink(before, after) {
  const aloneOnLine = (before === '' || /\n[ \t]*$/.test(before))
    && (after === '' || /^[ \t]*\n/.test(after));
  if (aloneOnLine) {
    // The link's line goes away, so the neighbouring lines end up separated by
    // the one newline that was already between them (or by nothing at either
    // end of the text).
    const join = (before === '' || after === '') ? '' : '\n';
    return before.replace(/\n[ \t]*$/, '') + join + after.replace(/^[ \t]*\n/, '');
  }
  // Inline: drop the link and keep at most one of the spaces around it.
  const leftWs = (before.match(/[ \t]*$/) || [''])[0];
  const rightWs = (after.match(/^[ \t]*/) || [''])[0];
  const sep = (leftWs && rightWs) ? ' ' : '';
  return before.slice(0, before.length - leftWs.length) + sep + after.slice(rightWs.length);
}

// Only a post with no media of its own is just its text, and only then is a
// link better off first. A post with media keeps its words as written: there
// the text is a caption beside the picture, not the whole post.
function shouldLinkFirst(post) {
  return Boolean(post) && !post.hasImage && !post.hasVideo;
}

// Move the first link in the text to the top, on a line of its own, leaving the
// rest of the text in order. The Channel then shows the link preview above the
// words instead of buried inside them.
function moveFirstLinkToFront(text, urls) {
  if (!text || !urls || !urls.length) return text;
  let hit = null;
  for (const url of urls) {
    if (!url) continue;
    const at = text.indexOf(url);
    if (at === -1) continue;
    if (!hit || at < hit.at) hit = { at, url };
  }
  if (!hit || hit.at === 0) return text;
  const before = text.slice(0, hit.at);
  const after = text.slice(hit.at + hit.url.length);
  // Tidy only the seam the link left: no trailing spaces on a line, and no more
  // than one blank line where the link used to be.
  const rest = joinAroundLink(before, after)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
  return rest ? hit.url + '\n' + rest : hit.url;
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
  const finalUrls = [];
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
    finalUrls.push(finalUrl);
    if (link.inText) {
      text = replaceDisplayInText(text, link.display, finalUrl);
    }
    if (!textIncludesUrl(text, finalUrl)) appended.push(finalUrl);
  }
  if (appended.length) {
    text = text.trim();
    text = (text ? text + '\n' : '') + appended.join('\n');
  }
  // Text-only posts put their link first (see shouldLinkFirst).
  if (shouldLinkFirst(post) && finalUrls.length) {
    const reordered = moveFirstLinkToFront(text, finalUrls);
    if (reordered !== text) {
      text = reordered;
      _xlog('info', 'tweet-link-moved-first', { tweetId: post.tweetId });
    }
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
  const mediaItems = findMediaItems(article);
  const photoHrefs = findPhotoLinks(article);
  return {
    tweetId: id,
    tweetUrl: url,
    author: findTweetAuthor(article),
    authorHandle: findTweetAuthorHandle(article),
    text,
    hasImage: photoHrefs.length > 0 || mediaItems.some((m) => m.type === 'image'),
    hasVideo: hasVideo(article) || mediaItems.some((m) => m.type === 'video'),
    photoHrefs,
    mediaUrls: mediaItems.filter((m) => m.type === 'image').map((m) => m.url),
    // Images and videos in the order X renders them; the background worker
    // turns each video id into its own captured HLS manifest.
    mediaItems,
  };
}

// A quote-tweet is published as a picture of the post it quotes, captioned with
// the outer post's own words (see button.js/shot.js). Only those words are
// needed: the quoted post's media is never primed, fetched or attached, and its
// words are not read either (findTweetText stops at the quote card). Link
// recovery runs exactly as it does for an ordinary post, on this post's own
// links.
async function extractQuotePost(article) {
  const post = extractPost(article);
  if (post.error) return post;
  return recoverPostLinks(article, post);
}

// X renders <video preload="none">, so a post's stream is only requested
// once the player is engaged. Nudging each of the clicked post's players
// (muted, so no autoplay gate) makes the background webRequest capture see
// the real manifests for exactly these videos instead of relying on the
// user having happened to play them.
async function primeVideos(article, timeoutMs) {
  const videos = [...article.querySelectorAll('video')].filter((v) => v.closest('article') === article);
  if (!videos.length) return false;
  for (const v of videos) {
    try { v.muted = true; } catch {}
    try { v.setAttribute('preload', 'auto'); } catch {}
    try { v.load(); } catch {}
    try { v.play().catch(() => {}); } catch {}
  }
  _xlog('info', 'tweet-videos-primed', { count: videos.length });
  const deadline = Date.now() + (timeoutMs || 2500);
  while (Date.now() < deadline) {
    await sleep(250);
    const ready = videos.some((v) => v.readyState >= 1 || (v.currentSrc && v.currentSrc.indexOf('blob:') !== 0));
    if (ready) break;
  }
  return true;
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

  // Ask X for the clicked post's own video streams so the background
  // worker captures manifests for these videos and not for whatever else
  // the page happened to load.
  if (post.hasVideo) {
    try { await primeVideos(article, 2500); } catch (e) { _xlog('warn', 'tweet-video-prime-failed', { tweetId: post.tweetId, error: e && e.message }); }
    const after = extractPost(article);
    if (!after.error) post = after;
  }

  // Recover media from the server-rendered HTML when the live DOM has no
  // rendered images (headless / lazy-load deferral) or could not name a
  // video. This also carries the HLS manifests for those video ids.
  post = await recoverMedia(article, post);

  // Recover canonical URLs hidden behind X link previews / wrapped link displays.
  return recoverPostLinks(article, post);
}

window.__xwapExtractPostAsync = extractPostAsync;
