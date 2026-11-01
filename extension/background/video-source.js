// Deciding which video a post's media item refers to.
//
// Kept out of the service worker so the rule that matters most here - never
// guess when the mapping is ambiguous - can be tested without a browser.
// The service worker loads this with importScripts().

// A video whose poster carries no id (older posts show a plain
// /media/<id>.jpg thumbnail) can still be named when this post's own
// document holds exactly one video: one video item maps 1:1 onto one
// manifest id. With more than one candidate the mapping is ambiguous, so
// the item is reported instead of guessed.
//
// Returns the resolved id, or null when it cannot be known.
function inferVideoId(videoId, hints, usedIds, videoCount) {
  // An id read straight from the post always wins: it is not a guess.
  if (videoId) return videoId;
  const candidates = Object.keys(hints || {}).filter((id) => hints[id] && hints[id].master);
  // Exactly one video in the post AND exactly one captured manifest. Two of
  // either makes the pairing a coin toss, and a wrong pair would publish the
  // wrong video - so nothing is returned.
  if (videoCount !== 1 || candidates.length !== 1) return null;
  // The one manifest available is already spoken for by another item in the
  // same post; reusing it would send the same video twice.
  if (usedIds.has(candidates[0])) return null;
  return candidates[0];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { inferVideoId };
}
