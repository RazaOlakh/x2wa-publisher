// Duplicate-job guard tests - no WhatsApp needed.
//
// The guard is what stops the same post being published twice: once while
// the first job is still running, and again shortly after it finished.
//
//   node controller/test/duplicate-guard.test.js
const { isDuplicate, WINDOW_MS } = require('../src/duplicate-guard');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const NOW = 1_000_000_000;

console.log('a first send is never a duplicate');
check('no prior attempt', isDuplicate(undefined, NOW) === false);

console.log('a job still running blocks a second one for the same post');
{
  // status 'pending' is written before processing starts, so a second click
  // while the first is in flight is refused rather than queued or duplicated.
  const pending = { ts: NOW, status: 'pending' };
  check('pending, same instant', isDuplicate(pending, NOW) === true);
  check('pending, part-way through', isDuplicate(pending, NOW + 60_000) === true);
}

console.log('a completed send blocks a rapid repeat but not a later one');
{
  const done = { ts: NOW, status: 'completed' };
  check('completed just now', isDuplicate(done, NOW) === true);
  check('completed inside the window', isDuplicate(done, NOW + WINDOW_MS - 1) === true);
  check('completed right at the window edge is allowed', isDuplicate(done, NOW + WINDOW_MS) === false);
  check('completed long ago is allowed', isDuplicate(done, NOW + WINDOW_MS * 10) === false);
}

console.log('a failed send is immediately retryable');
{
  const failed = { ts: NOW, status: 'failed' };
  check('the user can press the button again', isDuplicate(failed, NOW) === false);
}

console.log('a partial send still counts as delivered');
{
  // Something reached the channel, so a repeat would post it a second time.
  const partial = { ts: NOW, status: 'partial' };
  check('partial is treated as done', isDuplicate(partial, NOW) === true);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DUPLICATE-GUARD TESTS PASSED');
process.exit(failures ? 1 : 0);
