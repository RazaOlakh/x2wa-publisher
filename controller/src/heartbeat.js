// Liveness watchdog decisions.
//
// Putting a machine to sleep freezes the WhatsApp page without any
// 'disconnected' event ever arriving, so the controller goes on reporting
// "ready" while nothing works. Two signals catch that, and both are decided
// here so they can be tested without a browser or a live connection:
//
//   * a heartbeat that arrives far later than it should -- timers do not fire
//     while a machine is suspended, so the gap is about the length of the
//     sleep;
//   * the connection state the page reports, which stops being CONNECTED
//     once the page underneath it is gone.
//
// The module owns no timers and no WhatsApp client; the caller does that.

const DEFAULTS = {
  beatMs: 30000,
  // One odd page state is usually momentary (a reconnecting socket, a
  // navigation, a page swap), so it takes several in a row to act on.
  missesBeforeRestart: 3,
};

function createHeartbeat(options) {
  const opts = Object.assign({}, DEFAULTS, options);
  // A machine that was merely busy can stretch one beat a little; a gap this
  // wide means it was suspended.
  const resumeGapMs = opts.beatMs * 2.5;
  let misses = 0;

  return {
    resumeGapMs,
    missesBeforeRestart: opts.missesBeforeRestart,

    // Number of non-CONNECTED reports seen since the last good one.
    misses: () => misses,

    // True when this beat is so late that the process must have been
    // suspended (machine asleep, or stopped).
    sleptFor: (gapMs) => gapMs > resumeGapMs,

    // A page reported its connection state.
    // -> { verdict: 'ok' | 'recovered' | 'wait' | 'restart', misses: number }
    observe(waState) {
      if (waState === 'CONNECTED') {
        const had = misses;
        misses = 0;
        return { verdict: had ? 'recovered' : 'ok', misses: had };
      }
      misses += 1;
      return {
        verdict: misses >= opts.missesBeforeRestart ? 'restart' : 'wait',
        misses,
      };
    },

    // Forget the run of bad reports (a reconnect succeeded, or we restarted).
    reset() { misses = 0; },
  };
}

module.exports = { createHeartbeat, DEFAULTS };