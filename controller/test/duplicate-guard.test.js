// Duplicate-job guard tests - no WhatsApp needed.
//
// Duplicate prevention is disabled: users can send any post as many times as they want.
//
//   node controller/test/duplicate-guard.test.js
const { isDuplicate, WINDOW_MS } = require('../src/duplicate-guard');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const NOW = 1_000_000_000;

console.log('duplicate prevention is disabled (allows repeat sends)');
check('WINDOW_MS is 0', WINDOW_MS === 0);
check('first send is allowed', isDuplicate(undefined, NOW) === false);
check('pending send is allowed', isDuplicate({ ts: NOW, status: 'pending' }, NOW) === false);
check('completed send is allowed', isDuplicate({ ts: NOW, status: 'completed' }, NOW) === false);
check('failed send is allowed', isDuplicate({ ts: NOW, status: 'failed' }, NOW) === false);
check('partial send is allowed', isDuplicate({ ts: NOW, status: 'partial' }, NOW) === false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DUPLICATE-GUARD TESTS PASSED');
process.exit(failures ? 1 : 0);
