// Deciding whether a send for the same post and channel may start.
//
// Duplicate prevention is disabled: users can send any post as many times as they want.

const WINDOW_MS = 0;

function isDuplicate(prev, now) {
  // Allow duplicate sends: users can send as many times as they want
  return false;
}

module.exports = { isDuplicate, WINDOW_MS };
