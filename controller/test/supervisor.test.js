// Supervisor tests - no WhatsApp, no browser.
//
// The supervisor is what keeps the controller running on Windows (systemd does
// this on Linux). The restart decisions are a pure function, so most of this
// asserts them directly; the last three run the real supervisor against a stub
// to prove it restarts, stops when the session is already owned, and stops on a
// signal.
//
//   node controller/test/supervisor.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { afterExit, readConfig, DEFAULTS } = require('../src/supervisor');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) { check(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

console.log('what happens after the controller exits');
{
  const cfg = { restartMs: 5000, healthyRunMs: 60000, maxFastExits: 5 };

  const first = afterExit(0, 1000, cfg);
  eq('a quick exit restarts at the base delay', first, { action: 'restart', delayMs: 5000, consecutive: 1 });

  const second = afterExit(1, 1000, cfg);
  eq('the next one waits twice as long', second, { action: 'restart', delayMs: 10000, consecutive: 2 });

  const fifth = afterExit(4, 1000, cfg);
  eq('the last allowed quick exit still restarts', fifth.action, 'restart');
  eq('and the wait is capped, not unbounded', fifth.delayMs, 60000);

  const sixth = afterExit(5, 1000, cfg);
  eq('one too many quick exits gives up instead of spinning', sixth.action, 'give-up');
  eq('and counts the failed attempt', sixth.consecutive, 6);

  const healthy = afterExit(4, 90000, cfg);
  eq('a long, healthy run clears the failure count', healthy, { action: 'restart', delayMs: 5000, consecutive: 0 });
  check('a healthy run is judged by the run length, not the count', afterExit(99, 60000, cfg).consecutive === 0);
}

console.log('the tunables read from the environment (tests only)');
{
  eq('defaults when unset', readConfig({}), DEFAULTS);
  eq('overrides when set', readConfig({ X2WA_SUPERVISOR_RESTART_MS: '50', X2WA_SUPERVISOR_HEALTHY_MS: '10', X2WA_SUPERVISOR_MAX_FAST_EXITS: '2' }),
    { restartMs: 50, healthyRunMs: 10, maxFastExits: 2 });
  eq('garbage is ignored, not obeyed', readConfig({ X2WA_SUPERVISOR_RESTART_MS: 'soon', X2WA_SUPERVISOR_MAX_FAST_EXITS: '-3' }), DEFAULTS);
}

const SUPERVISOR = path.join(__dirname, '..', 'src', 'supervisor.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-supervisor-'));

// A stand-in controller: bumps a counter, then exits with a chosen code (or
// stays up if no code is given).
const stub = path.join(tmp, 'stub.js');
fs.writeFileSync(stub, `
  const fs = require('fs');
  const counter = process.env.X2WA_STUB_COUNTER;
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch {}
  fs.writeFileSync(counter, String(n + 1));
  if (process.env.X2WA_STUB_STAY === '1') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  } else {
    process.exit(parseInt(process.env.X2WA_STUB_EXIT || '0', 10));
  }
`);

function runSupervisor(env, timeout) {
  return spawnSync(process.execPath, [SUPERVISOR, stub], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeout || 20000,
  });
}
function reads(p) { try { return parseInt(fs.readFileSync(p, 'utf8'), 10); } catch { return 0; } }

console.log('the real supervisor, against a stand-in controller');
{
  // Exits immediately, so it should be started again, then given up on.
  const counter = path.join(tmp, 'restart-count');
  const r = runSupervisor({ X2WA_STUB_COUNTER: counter, X2WA_SUPERVISOR_RESTART_MS: '50', X2WA_SUPERVISOR_MAX_FAST_EXITS: '2' });
  eq('the controller is run, restarted twice, then not again', reads(counter), 3);
  check('it exits non-zero once it gives up', r.status !== 0, r.status);
  check('and says why', /"event":"give-up"/.test(r.stdout || ''), (r.stdout || '').slice(-160));
  check('each restart is logged', (r.stdout || '').split('"event":"restarting"').length - 1 === 2);
}
{
  // Another controller owns the session (exit 3): stop, do not fight over it.
  const counter = path.join(tmp, 'locked-count');
  const r = runSupervisor({ X2WA_STUB_COUNTER: counter, X2WA_STUB_EXIT: '3' });
  eq('a locked session stops the supervisor at once', reads(counter), 1);
  check('which is a clean stop, not a failure', r.status === 0, r.status);
  check('and it is reported', /"event":"session-locked"/.test(r.stdout || ''), (r.stdout || '').slice(-160));
}
{
  // A stop signal: forwarded to the child, then the supervisor exits cleanly.
  const counter = path.join(tmp, 'signal-count');
  const child = spawn(process.execPath, [SUPERVISOR, stub], {
    env: { ...process.env, X2WA_STUB_COUNTER: counter, X2WA_STUB_STAY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ code: 'timeout' }); }, 15000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  // Wait for the stand-in controller to actually be up before signalling, so a
  // slow machine cannot kill the supervisor mid-launch and pass by accident.
  (async () => {
    for (let i = 0; i < 100 && reads(counter) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    try { child.kill('SIGTERM'); } catch {}
  })();
  done.then(({ code }) => {
    check('a stop signal stops the supervisor cleanly', code === 0, code);
    eq('and the controller was run once', reads(counter), 1);
    finish();
  });
}

function finish() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SUPERVISOR TESTS PASSED');
  process.exit(failures ? 1 : 0);
}
