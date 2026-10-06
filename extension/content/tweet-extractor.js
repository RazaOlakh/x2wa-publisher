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
