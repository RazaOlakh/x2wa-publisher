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

function hasVideo(article) {
  const v = article.querySelector('video');
  if (!v) return false;
  // If the video element is attributed to a nested <article>, skip it.
  return v.closest('article') === article;
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
    hasImage: findPhotoLinks(article).length > 0,
    hasVideo: hasVideo(article),
    photoHrefs: findPhotoLinks(article),
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
  const textEl = article.querySelector('div[data-testid="tweetText"]');
  if (!textEl) return null;
  const candidates = textEl.querySelectorAll('a, button, span, div[role="button"]');
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
  if (!expand) {
    _xlog('info', 'tweet-truncated-no-expand-control', { tweetId: post.tweetId });
    return post;
  }

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
  return post;
}

window.__xwapExtractPostAsync = extractPostAsync;
