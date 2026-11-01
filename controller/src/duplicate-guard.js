// Deciding whether a send for the same post and channel may start.
//
// Pure so it can be tested directly: the guard's job is to stop a second
// job for the same post while one is still running, and to stop a rapid
// repeat of one that has already gone through.

// How long a completed send keeps a post "done".
const WINDOW_MS = 120000;

// `prev` is the last recorded attempt for this tweetId|channelId, or
// undefined when there is none. A failed attempt is immediately retryable -
// pressing the button again after an error should work - but a job that is
// still pending, or one that succeeded within the window, is not.
function isDuplicate(prev, now) {
  if (!prev) return false;
  if (prev.status === 'failed') return false;
  return now - prev.ts < WINDOW_MS;
}

module.exports = { isDuplicate, WINDOW_MS };
