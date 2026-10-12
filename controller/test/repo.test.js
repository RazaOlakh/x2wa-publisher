// Version / update tests: the git layer, against throwaway repositories.
// No network and no touching of the real checkout.
//
//   node controller/test/repo.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// The module finds its repository from the working directory and remembers
// it, so each scenario runs in its own process with its own temporary repo.
function inRepo(dir, script) {
  const out = execFileSync(process.execPath, ['-e', `
    const repo = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'repo.js'))});
    (async () => { console.log(JSON.stringify(await (async () => (${script})(repo))())); })()
      .catch((e) => { console.log(JSON.stringify({ threw: String(e && e.message) })); });
  `], { cwd: dir, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

// An origin holding the same first commit, wired up as dir's upstream.
function makeUpstream(dir) {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-origin-'));
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 'test@example.invalid']);
  git(origin, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(origin, 'README.md'), 'hello\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'first']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['branch', '--set-upstream-to=origin/main', 'main']);
  return origin;
}

// ------------------------------------------------------------- local facts
console.log('reads the checkout it is running in');
{
  const dir = makeRepo();
  const r = inRepo(dir, '(repo) => repo.local()');
  check('finds the repository', r.ok === true, r);
  eq('reports the branch', r.branch, 'main');
  check('reports a short commit', typeof r.sha === 'string' && r.sha.length === 7, r.sha);
  check('a clean tree is not dirty', r.dirty === false);
  eq('a branch with no upstream says so', r.upstream, null);

  const s = inRepo(dir, '(repo) => repo.status()');
  check('status is ok', s.ok === true);
  eq('nothing has been fetched, so no counts yet', s.behind, null);
  eq('and nothing claims to have been checked', s.checkedAt, null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ dirty tree
console.log('refuses to update a checkout with uncommitted changes');
{
  const dir = makeRepo();
  const before = git(dir, ['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(dir, 'README.md'), 'edited by hand\n');

  const l = inRepo(dir, '(repo) => repo.local()');
  check('an edited file makes it dirty', l.dirty === true);

  const u = inRepo(dir, '(repo) => repo.update()');
  check('the update is refused', u.ok === false, u);
  eq('and says why', u.error, 'local-changes');

  const after = git(dir, ['rev-parse', 'HEAD']).trim();
  eq('HEAD did not move', after, before);
  eq('the edit is still there', fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'edited by hand\n');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- untracked files ignored
console.log('an untracked file does not hold up an update');
{
  const dir = makeRepo();
  const origin = makeUpstream(dir);
  // A commit lands on the remote, so there is something to pull.
  fs.writeFileSync(path.join(origin, 'new.txt'), 'added\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'second']);
  git(dir, ['fetch', '-q', 'origin']);

  // A file that was never added: a fast-forward does not clobber it.
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked\n');

  const l = inRepo(dir, '(repo) => repo.local()');
  check('an untracked file is not treated as dirty', l.dirty === false, l);

  const u = inRepo(dir, '(repo) => repo.update()');
  check('so the update is offered and applies', u.ok === true && u.updated === true, u);
  check('the new commit is here', git(dir, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).trim() === '0\t0');
  eq('and the untracked file is left alone', fs.readFileSync(path.join(dir, 'scratch.txt'), 'utf8'), 'untracked\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
}

console.log('an untracked file an update would overwrite is protected, not clobbered');
{
  const dir = makeRepo();
  const origin = makeUpstream(dir);
  // The remote adds a file at a path this checkout already has untracked.
  fs.writeFileSync(path.join(origin, 'collide.txt'), 'from the remote\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'remote collides']);
  git(dir, ['fetch', '-q', 'origin']);
  fs.writeFileSync(path.join(dir, 'collide.txt'), 'mine\n');

  const u = inRepo(dir, '(repo) => repo.update()');
  check('the pull is refused rather than overwriting it', u.ok === false, u);
  eq('and says the pull failed', u.error, 'pull-failed');
  eq('the untracked file survives untouched', fs.readFileSync(path.join(dir, 'collide.txt'), 'utf8'), 'mine\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
}

// ----------------------------------------------------------- no upstream
console.log('a branch with no upstream cannot be updated');
{
  const dir = makeRepo();
  const u = inRepo(dir, '(repo) => repo.update()');
  check('the update is refused', u.ok === false, u);
  eq('and says why', u.error, 'no-upstream');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- behind an upstream
console.log('counts what is waiting upstream, without going to the network');
{
  const dir = makeRepo();
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-origin-'));
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 'test@example.invalid']);
  git(origin, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(origin, 'README.md'), 'hello\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'first']);

  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['branch', '--set-upstream-to=origin/main', 'main']);

  // One commit lands on the remote only: this checkout is now one behind.
  fs.writeFileSync(path.join(origin, 'new.txt'), 'added\n');
  git(origin, ['add', '.']);
  git(origin, ['commit', '-q', '-m', 'second']);
  git(dir, ['fetch', '-q', 'origin']);

  // The cache lives in the process, so this has to stay in one: the point
  // is that a second read does not go back to the remote.
  const r = inRepo(dir, `(async (repo) => {
    const l = await repo.local();
    const c = await repo.check();
    const cached = await repo.status();
    return { upstream: l.upstream, behind: c.behind, ahead: c.ahead, checkedAt: c.checkedAt, cached: cached.behind };
  })`);

  eq('the upstream is found', r.upstream, 'origin/main');
  check('the check succeeds', typeof r.checkedAt === 'number', r);
  eq('one commit is waiting', r.behind, 1);
  eq('and nothing local is ahead', r.ahead, 0);
  eq('the answer is cached, not refetched', r.cached, 1);

  // Now actually update, and check it fast-forwards to the new commit.
  const head = git(dir, ['rev-parse', '--short', 'HEAD']).trim();
  const u = inRepo(dir, '(repo) => repo.update()');
  check('the update applies', u.ok === true, u);
  check('it moved', u.updated === true, u);
  eq('it reports where it came from', u.from, head);
  eq('the new commit is the one it waited for', u.to, git(origin, ['rev-parse', '--short', 'HEAD']).trim());
  eq('nothing needs a reload for a markdown file', u.reloadExtension, false);
  eq('nor a controller restart', u.restartController, false);
  check('the remote really is reached now', git(dir, ['rev-list', '--left-right', '--count', 'origin/main...HEAD']).trim() === '0\t0');

  // A second update has nothing left to do.
  const again = inRepo(dir, '(repo) => repo.update()');
  check('a second update is a no-op', again.ok === true && again.updated === false, again);

  // And the status is not left claiming ignorance straight after an update.
  const afterUpdate = inRepo(dir, '(async (repo) => { await repo.update(); return repo.status(); })');
  eq('after updating, it knows where it stands', afterUpdate.behind, 0);
  eq('and that nothing is waiting', afterUpdate.ahead, 0);

  // An update with nothing waiting must not claim to be level with the
  // remote when it is in fact ahead of it.
  fs.writeFileSync(path.join(dir, 'local.txt'), 'only here\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'local only']);
  const aheadAfter = inRepo(dir, '(async (repo) => { await repo.update(); return repo.status(); })');
  eq('a local commit is still reported as ahead', aheadAfter.ahead, 1);
  eq('and nothing is waiting', aheadAfter.behind, 0);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(origin, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL REPO TESTS PASSED');
process.exit(failures ? 1 : 0);