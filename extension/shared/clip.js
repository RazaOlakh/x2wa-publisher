// Capture geometry shared by the content script and the worker.
//
// The crop is decided in the content script, in CSS pixels: the post's box
// comes from getBoundingClientRect, so it is viewport-relative, and the page's
// scroll is added back to address the document. The DevTools capture command,
// however, does not address CSS pixels. Its clip is in device-independent
// pixels, which are CSS pixels scaled by the page's zoom factor.
//
// At 100% zoom the two are the same, which is why a clip passed straight
// through looks right - until the page is zoomed, and then the same clip lands
// on the wrong part of the page at the wrong size. The zoom factor is not
// visible to the content script, only to the debugger, so the conversion
// happens in the worker, next to the capture. The arithmetic lives here so the
// two sides agree on it and it can be tested without a browser.

// The page's zoom factor, or 1 when the browser does not report one. 1 is the
// safe default: it is what the capture command assumes with nothing zoomed.
function pageZoom(metrics) {
  const z = metrics && metrics.cssVisualViewport && metrics.cssVisualViewport.zoom;
  return typeof z === 'number' && isFinite(z) && z > 0 ? z : 1;
}

// A clip the capture command will accept: finite numbers and a positive box.
// Anything else is refused here rather than sent on as a wrong or empty shot.
function validClip(clip) {
  return !!clip
    && [clip.x, clip.y, clip.width, clip.height].every((n) => typeof n === 'number' && isFinite(n))
    && clip.width > 0 && clip.height > 0;
}

// CSS pixels (document space) -> DIP (document space), whole and positive.
// Rounded because the command takes integers and rejects a fractional box.
function clipToDip(clip, zoom) {
  if (!validClip(clip)) return null;
  const z = typeof zoom === 'number' && isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = Math.max(0, Math.round(clip.x * z));
  const y = Math.max(0, Math.round(clip.y * z));
  const width = Math.round(clip.width * z);
  const height = Math.round(clip.height * z);
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height, scale: 1 };
}

// Two rectangles agree when every edge is within a pixel or two: enough for
// the rounding of a sub-pixel layout, far too little for a post that has moved
// since it was measured.
function rectsAgree(a, b, tolerance) {
  if (!a || !b) return false;
  const tol = typeof tolerance === 'number' ? tolerance : 2;
  return ['left', 'top', 'width', 'height'].every((k) =>
    typeof a[k] === 'number' && isFinite(a[k])
    && typeof b[k] === 'number' && isFinite(b[k])
    && Math.abs(a[k] - b[k]) <= tol);
}

// The attribute a post is tagged with so the worker can find the exact node it
// was told to capture. Kept here, in one place, so the content script and the
// selector built in the worker cannot drift apart.
const SHOT_MARKER_ATTR = 'data-xwap-shot';

// A selector for a marker token, or null when the token is not one this
// extension would have issued. So a value that arrives wrong can never become
// an arbitrary selector - it can only ever name our own attribute.
function markerSelector(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(token)) return null;
  return `[${SHOT_MARKER_ATTR}="${token}"]`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pageZoom, validClip, clipToDip, rectsAgree, markerSelector, SHOT_MARKER_ATTR };
}
