// Controller-side tests: session paths, single-instance lock, and the
// channel eligibility rule. No WhatsApp connection required.
//
//   node controller/test/controller.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// ------------------------------------------------------- session location
console.log('session directory is stable and per-user');
{
  const savedEnv = { SESSION_DIR: process.env.SESSION_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  delete process.env.SESSION_DIR;
  const { sessionDir, userDataRoot, tmpRoot } = require('../src/platform');

  const root = userDataRoot();
  check('root is inside the user data dir', root.includes('x-whatsapp-poster'), root);
  eq('session path is derived from the root', sessionDir(), path.join(root, 'whatsapp-session'));
  eq('tmp path is derived from the root', tmpRoot(), path.join(root, 'tmp'));

  // Same value on repeat calls (no randomness, no per-launch directory).
  check('stable across calls', sessionDir() === sessionDir());

  process.env.SESSION_DIR = '/custom/session';
  eq('SESSION_DIR overrides the default', sessionDir(), '/custom/session');

  // Windows layout (drive by overriding LOCALAPPDATA + platform).
  delete process.env.SESSION_DIR;
  const savedPlat = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const savedLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
  // Simulating win32 on a POSIX host still uses POSIX separators, so
  // compare with separators normalised.
  const norm = (s) => s.replace(/\\/g, '/');
  check('windows uses LOCALAPPDATA', norm(sessionDir()).includes('AppData/Local/x-whatsapp-poster/whatsapp-session'), sessionDir());
  Object.defineProperty(process, 'platform', { value: savedPlat, configurable: true });
  if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;

  if (savedEnv.SESSION_DIR === undefined) delete process.env.SESSION_DIR; else process.env.SESSION_DIR = savedEnv.SESSION_DIR;
  if (savedEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedEnv.XDG_DATA_HOME;
}

// ----------------------------------------------------------- the browser
console.log('the browser is chosen per platform, and never guessed wrong');
{
  const { chromePath } = require('../src/platform');
  const all = () => true;
  const none = () => false;
  const endsChrome = (p) => typeof p === 'string' && p.endsWith('chrome.exe');

  eq('an explicit CHROME_PATH wins', chromePath({ platform: 'linux', env: { CHROME_PATH: '/opt/chrome' }, exists: all }), '/opt/chrome');

  // Windows: the three conventional installs, in order. Distinct directory
  // names let each candidate be singled out without depending on separators.
  const winEnv = { ProgramFiles: 'PF_dir', 'ProgramFiles(x86)': 'PF86_dir', LOCALAPPDATA: 'LA_dir' };
  const standard = chromePath({ platform: 'win32', env: winEnv, exists: (p) => p.includes('PF_dir') });
  check('windows uses the standard install when it exists', endsChrome(standard) && standard.includes('PF_dir'), standard);
  const perUser = chromePath({ platform: 'win32', env: winEnv, exists: (p) => p.includes('LA_dir') });
  check('windows falls back to the per-user install', endsChrome(perUser) && perUser.includes('LA_dir'), perUser);
  eq('windows with no Chrome hands the choice to puppeteer', chromePath({ platform: 'win32', env: winEnv, exists: none }), undefined);
  eq('windows without LOCALAPPDATA still tries the machine-wide installs', chromePath({ platform: 'win32', env: { ProgramFiles: 'PF_dir' }, exists: none }), undefined);

  // Linux / macOS: the usual locations, else puppeteer.
  eq('linux prefers google-chrome-stable', chromePath({ platform: 'linux', env: {}, exists: all }), '/usr/bin/google-chrome-stable');
  eq('linux can fall through to another browser', chromePath({ platform: 'linux', env: {}, exists: (p) => p === '/usr/bin/chromium' }), '/usr/bin/chromium');
  eq('linux with none found hands the choice to puppeteer', chromePath({ platform: 'linux', env: {}, exists: none }), undefined);
  const mac = chromePath({ platform: 'darwin', env: {}, exists: all });
  check('macos uses the app bundle', typeof mac === 'string' && mac.includes('Google Chrome.app'), mac);
}

// ------------------------------------------------------ single instance
console.log('second controller cannot share a session directory');
{
  const { acquireSessionLock } = require('../src/platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-lock-'));

  const lockPath = path.join(dir, 'controller.lock');
  fs.writeFileSync(lockPath, String(process.pid)); // this process "owns" it

  // A lock naming a live foreign pid must be refused.
  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
  fs.writeFileSync(lockPath, String(child.pid));
  let refused = false;
  try { acquireSessionLock(dir); } catch (e) { refused = e.code === 'ESESSIONLOCKED'; }
  check('refuses a live foreign owner', refused);
  child.kill();

  // A stale lock (dead pid) must be taken over.
  fs.writeFileSync(lockPath, '999999');
  let tookOver = false;
  try { acquireSessionLock(dir); tookOver = fs.readFileSync(lockPath, 'utf8') === String(process.pid); } catch (e) { tookOver = false; }
  check('takes over a stale lock', tookOver);

  fs.rmSync(dir, { recursive: true, force: true });
}

// -------------------------------------------------- eligibility filtering
console.log('only channels with admin/owner rights are offered');
{
  const { partitionChannels } = require('../src/channels');
  // Shaped like a real account: one owned channel, one followed channel,
  // one terminated channel, one whose check failed.
  const all = [
    { id: { _serialized: '111@newsletter' }, name: 'Owned' },
    { id: { _serialized: '222@newsletter' }, name: 'Followed' },
    { id: { _serialized: '333@newsletter' }, name: 'Gone' },
    { id: { _serialized: '444@newsletter' }, name: 'Unchecked' },
  ];
  const verdicts = [
    { id: '111@newsletter', role: 'owner', state: 'active', canPost: true },
    { id: '222@newsletter', role: 'subscriber', state: 'active', canPost: false },
    { id: '333@newsletter', role: 'admin', state: 'terminated', canPost: true },
    { id: '444@newsletter', role: null, state: null, canPost: false, error: 'metadata query failed' },
  ];
  const r = partitionChannels(all, verdicts);
  eq('only the owned channel is offered', r.channels.map((c) => c.id), ['111@newsletter']);
  eq('owner role is reported', r.channels[0].role, 'owner');
  eq('checked every channel', r.checked, 4);
  eq('follower is listed as ineligible', r.ineligible.map((c) => c.id), ['222@newsletter', '333@newsletter', '444@newsletter']);
  eq('subscriber role preserved for diagnostics', r.ineligible[0].role, 'subscriber');
  check('a failed check is flagged', r.degraded === true);
  check('no ineligible channel leaks into the list', !r.channels.some((c) => c.id === '222@newsletter'));

  // An admin (not owner) is eligible too.
  const r2 = partitionChannels([{ id: { _serialized: '555@newsletter' }, name: 'Admin' }],
    [{ id: '555@newsletter', role: 'admin', state: 'active', canPost: true }]);
  eq('admin is eligible', r2.channels.map((c) => c.id), ['555@newsletter']);

  // Visibility alone must never imply eligibility.
  const r3 = partitionChannels([{ id: { _serialized: '666@newsletter' }, name: 'Visible' }],
    [{ id: '666@newsletter', role: 'guest', state: 'active', canPost: false }]);
  eq('a merely visible channel is filtered out', r3.channels.length, 0);
}
// --------------------------------------------------------- liveness watchdog
console.log('sleep/wake is noticed instead of posting into a dead page');
{
  const { createHeartbeat } = require('../src/heartbeat');

  // The gap between beats: a beat that is very late means we were suspended.
  const b = createHeartbeat({ beatMs: 30000 });
  check('an on-time beat is not a resume', !b.sleptFor(30000));
  check('a slightly late beat is not a resume', !b.sleptFor(50000));
  check('a beat late by the length of a sleep is a resume', b.sleptFor(5 * 60 * 1000));
  check('an overnight gap is a resume', b.sleptFor(9 * 60 * 60 * 1000));
  check('the resume threshold scales with the beat', createHeartbeat({ beatMs: 5000 }).resumeGapMs === 12500);

  // A healthy page: no action, ever.
  eq('a connected page is fine', b.observe('CONNECTED'), { verdict: 'ok', misses: 0 });
  for (let i = 0; i < 5; i++) check('staying connected stays fine', b.observe('CONNECTED').verdict === 'ok');
  eq('no misses accumulated while connected', b.misses(), 0);

  // A transient state must not tear down a working client.
  const t = createHeartbeat({ beatMs: 30000, missesBeforeRestart: 3 });
  eq('first odd state waits', t.observe('OPENING'), { verdict: 'wait', misses: 1 });
  eq('second odd state waits', t.observe('OPENING'), { verdict: 'wait', misses: 2 });
  eq('a recovered page cancels the run', t.observe('CONNECTED'), { verdict: 'recovered', misses: 2 });
  eq('the run is cleared after recovery', t.misses(), 0);
  eq('the run starts over after recovery', t.observe('TIMEOUT'), { verdict: 'wait', misses: 1 });

  // Persistent trouble is acted on.
  const p = createHeartbeat({ beatMs: 30000, missesBeforeRestart: 3 });
  eq('miss 1 waits', p.observe('TIMEOUT').verdict, 'wait');
  eq('miss 2 waits', p.observe('TIMEOUT').verdict, 'wait');
  eq('miss 3 restarts', p.observe('TIMEOUT').verdict, 'restart');

  // A page that answers with nothing is not healthy either.
  check('a page reporting nothing is not healthy', createHeartbeat().observe(null).verdict === 'wait');
  eq('a page reporting nothing counts as a miss', createHeartbeat().observe(undefined).misses, 1);

  // Reconnecting clears the run, so the next blip starts from scratch.
  const q = createHeartbeat({ beatMs: 30000, missesBeforeRestart: 2 });
  q.observe('OPENING');
  q.reset();
  eq('reset clears the run', q.misses(), 0);
  eq('a blip after reset only waits once', q.observe('OPENING').verdict, 'wait');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CONTROLLER TESTS PASSED');
process.exit(failures ? 1 : 0);