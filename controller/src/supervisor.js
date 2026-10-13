// Keeps the controller running on a machine with no service manager.
//
// Linux hands the controller to systemd, which restarts it on failure
// (Restart=on-failure) but stops after a burst (StartLimitBurst) so a crash
// loop cannot spin forever. Windows has no such thing here: the Startup-folder
// launcher starts one process and exits, so if the controller stops there is
// nothing to bring it back until the next logon - which is exactly the "it did
// not connect on startup, and sometimes it just stops" report.
//
// This is the missing half. It runs the controller and starts it again
// whenever it stops, with the same shape of guarantees: a bounded number of
// quick restarts, then it gives up loudly rather than spinning.
//
// The Windows launcher runs it; Linux does not (systemd already does this).
//
//   node src/supervisor.js [path/to/server.js]
//
// The decision logic is a pure function so it can be tested without spawning
// anything; see controller/test/supervisor.test.js.

const path = require('path');
const { spawn } = require('child_process');

const DEFAULTS = {
  // First restart wait; it doubles for each quick exit in a row.
  restartMs: 5000,
  // A run this long counts as healthy: the next restart is a fresh start, not
  // part of a crash loop, so the failure count starts over.
  healthyRunMs: 60000,
  // This many quick exits in a row and the fault is not transient. systemd
  // stops after StartLimitBurst; this is the same idea.
  maxFastExits: 5,
};

// What to do after the supervised process exits: restart it (and how soon), or
// give up. `consecutive` is the number of quick exits counted so far.
function afterExit(consecutive, ranForMs, options) {
  const cfg = Object.assign({}, DEFAULTS, options);
  if (ranForMs >= cfg.healthyRunMs) {
    return { action: 'restart', delayMs: cfg.restartMs, consecutive: 0 };
  }
  const next = consecutive + 1;
  if (next > cfg.maxFastExits) return { action: 'give-up', delayMs: 0, consecutive: next };
  return { action: 'restart', delayMs: Math.min(cfg.restartMs * Math.pow(2, next - 1), 60000), consecutive: next };
}

// The three numbers are overridable so tests can watch a restart happen in a
// fraction of a second instead of a minute. Nothing else sets them.
function readConfig(env) {
  const cfg = Object.assign({}, DEFAULTS);
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : null; };
  const restart = num(env.X2WA_SUPERVISOR_RESTART_MS);
  if (restart !== null) cfg.restartMs = restart;
  const healthy = num(env.X2WA_SUPERVISOR_HEALTHY_MS);
  if (healthy !== null) cfg.healthyRunMs = healthy;
  const max = num(env.X2WA_SUPERVISOR_MAX_FAST_EXITS);
  if (max !== null) cfg.maxFastExits = max;
  return cfg;
}

function main(argv, env) {
  const target = argv && argv[2] ? path.resolve(argv[2]) : path.join(__dirname, 'server.js');
  const cfg = readConfig(env);

  const log = (level, event, data) => {
    const rec = { ts: new Date().toISOString(), level, component: 'supervisor', event, ...(data || {}) };
    try { process.stdout.write(JSON.stringify(rec) + '\n'); } catch { /* stdout closed */ }
  };

  let child = null;
  let consecutive = 0;
  let stopping = false;

  const launch = () => {
    const startedAt = Date.now();
    log('info', 'supervise-start', { target, consecutive });
    child = spawn(process.execPath, [target], { stdio: 'inherit', env });
    child.on('error', (e) => log('error', 'spawn-error', { error: e && e.message }));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) { log('info', 'supervised-exit', { code, signal }); return; }
      const ranForMs = Date.now() - startedAt;
      // Exit 3 is the controller refusing to start because another one owns the
      // session. Restarting would only collide again, so stop quietly.
      if (code === 3) { log('warn', 'session-locked', { code }); process.exit(0); }
      const decision = afterExit(consecutive, ranForMs, cfg);
      consecutive = decision.consecutive;
      if (decision.action === 'give-up') {
        log('error', 'give-up', { code, signal, ranForMs, consecutive, restartMs: cfg.restartMs });
        process.exit(1);
      }
      log('warn', 'restarting', { code, signal, ranForMs, delayMs: decision.delayMs, consecutive });
      // Not unref'd: with no child running, this timer is the only thing
      // keeping the supervisor alive through the wait. Unref'd, the process
      // would simply exit instead of restarting the controller.
      setTimeout(launch, decision.delayMs);
    });
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      log('info', 'supervisor-stop', { signal: sig });
      // With a child, pass the signal on and let it shut down cleanly (the
      // controller closes the WhatsApp browser on the way out). Without one,
      // there is nothing to wait for.
      if (child) { try { child.kill(sig); } catch { /* already gone */ } }
      else process.exit(0);
    });
  }

  launch();
}

if (require.main === module) main(process.argv, process.env);

module.exports = { afterExit, readConfig, DEFAULTS };
