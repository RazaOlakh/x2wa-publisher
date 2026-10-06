// Content script: tweet detection and exact text/URL/media extraction.
function findTweetText(article) {
  const el = article.querySelector('div[data-testid="tweetText"]');
  return el ? el.innerText : '';
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
  const out = [];
  for (const a of article.querySelectorAll('a[href*="/photo/"]')) {
    try {
      out.push(new URL(a.href, location.origin).href);
    } catch {}
  }
  return Array.from(new Set(out));
}

function hasVideo(article) {
  return Boolean(article.querySelector('video'));
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
