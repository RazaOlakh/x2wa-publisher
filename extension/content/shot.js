// Screenshot of a single post.
//
// Split out from button.js so the parts that decide *what* to capture and
// *how* to describe the result can be tested without a browser: the only DOM
// this file touches is finding the post and finding its action bar. The crop
// is computed from rectangles.
//
// Only this post's own box is ever captured. The crop is computed in page
// coordinates (scroll included) because that is the space the capture API
// addresses, and it is clamped to the document so a post scrolled partly
// off-screen still yields the part that exists.

// The capture API wants integers and a positive box.
function shotClip(rect, scrollX, scrollY, docWidth, docHeight) {
  const x = Math.max(0, Math.round(rect.left + scrollX));
  const y = Math.max(0, Math.round(rect.top + scrollY));
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width < 1 || height < 1) return null;
  // A post that runs past the bottom of the document cannot be captured
  // beyond it; asking for the extra pixels just wastes the encode.
  const capped = docHeight ? Math.min(height, Math.max(1, docHeight - y)) : height;
  const cappedW = docWidth ? Math.min(width, Math.max(1, docWidth - x)) : width;
  return { x, y, width: cappedW, height: capped, scale: 1 };
}

// Which element one post occupies.
//
// X renders every post as <article data-testid="tweet">, and the buttons are
// injected into a toolbar inside that article, so the nearest such ancestor of
// the clicked button is the post. The href is not used at all: the box that
// matters is the one the page is actually showing.
//
// The failure to guard against is a container that holds several posts - the
// timeline list, or a thread module. Cropping one of those would photograph
// the neighbouring posts too, so a candidate that contains another post is
// refused rather than cropped. The caller reports that instead of sending a
// picture of the wrong thing.
const SHOT_POST_SELECTOR = 'article[data-testid="tweet"], article[role="article"]';

function shotContainer(start) {
  if (!start || typeof start.closest !== 'function') return null;
  const el = start.closest(SHOT_POST_SELECTOR);
  if (!el) return null;
  // A post never contains another post. If this one does, it is a wrapper
  // whose box spans things that are not this post.
  if (typeof el.querySelectorAll === 'function' && el.querySelectorAll(SHOT_POST_SELECTOR).length > 0) return null;
  return el;
}

// --- what part of the post is the post ---
//
// The post's action bar - the reply / repost / like / share row - is a row of
// controls, and the extension's own toolbar sits directly beneath it. Neither
// is part of the post, so a screenshot stops above them: the picture is the
// post's author, text and media, not the buttons around it.
//
// The bar is found from the like button, which only the bar has, and never
// from a quoted post's own bar rendered inside this one.
const SHOT_ACTION_BAR_SELECTOR = 'div[role="group"]';
const SHOT_LIKE_SELECTOR = 'button[data-testid="like"]';
const SHOT_QUOTE_SELECTOR = 'div[data-testid="quoteTweet"]';

function shotActionBar(article) {
  if (!article || typeof article.querySelectorAll !== 'function') return null;
  const likes = article.querySelectorAll(SHOT_LIKE_SELECTOR);
  for (const like of likes) {
    // A quoted post carries its own like row inside this post; that is not
    // this post's action bar, so skip it and keep looking.
    if (typeof like.closest === 'function' && like.closest(SHOT_QUOTE_SELECTOR)) continue;
    const bar = typeof like.closest === 'function' ? like.closest(SHOT_ACTION_BAR_SELECTOR) : null;
    if (bar) return bar;
  }
  // No like button to key on (X rendered the bar differently, or the post has
  // none): fall back to the first action-bar-like group so the post is still
  // cropped above its controls.
  const groups = article.querySelectorAll(SHOT_ACTION_BAR_SELECTOR);
  return groups.length ? groups[0] : null;
}

// The post's own rectangle: the article's box up to where its action bar
// begins. A bar that is missing, or that sits at or above the top of the post,
// leaves the whole post captured rather than less than the post.
function shotContentRect(rect, actionTop) {
  if (!rect) return rect;
  if (typeof actionTop !== 'number' || !isFinite(actionTop)) return rect;
  const height = actionTop - rect.top;
  if (!(height > 0)) return rect;
  return { left: rect.left, top: rect.top, width: rect.width, height: Math.min(height, rect.height) };
}

// A screenshot is deduplicated against screenshots, not against posting the
// same post: taking a picture of a post must not stop you from posting it,
// and vice versa.
function shotKey(tweetId) {
  return tweetId ? `shot:${tweetId}` : '';
}

// The image already contains the post's text, so the caption is the
// permalink: short, clickable, and not a second copy of the same words.
function shotCaption(tweetUrl) {
  return tweetUrl || '';
}

const SHOT_ERROR_HINTS = {
  'no-article': 'The post could not be read from the page.',
  'capture-unavailable': 'Chrome would not let the extension capture this tab. Close any Developer Tools window for this tab and try again.',
  'capture-failed': 'The screenshot came back empty. Try scrolling the post into view and pressing again.',
  'capture-too-small': 'The post is not on screen, so there was nothing to capture.',
  'empty-screenshot': 'Nothing could be captured from this post.',
  'no-default-channel': 'Choose a destination channel in the extension popup first.',
  'Failed to fetch': 'Lost contact with the controller. Check that it is running.',
};

function shotErrorHint(code) {
  return SHOT_ERROR_HINTS[code] || code || 'unknown error';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shotClip, shotContainer, SHOT_POST_SELECTOR, shotActionBar, shotContentRect, shotKey, shotCaption, shotErrorHint, SHOT_ERROR_HINTS };
}