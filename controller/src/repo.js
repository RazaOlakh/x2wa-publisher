// Reading and updating the local checkout.
//
// Everything here runs git with an argument array and never through a shell,
// the remote and the branch are never taken from the caller, and every
// command has a timeout. GIT_TERMINAL_PROMPT is switched off so a fetch that
// needs credentials fails straight away instead of sitting there waiting for
// input it will never get.
const { execFile } = require('child_process');
const path = require('path');

const TIMEOUT = { quick: 10000, normal: 20000, fetch: 45000, pull: 90000, push: 90000 };
const REMOTE = 'origin';
// Only ever used with values git itself produced, but checked anyway so a
// surprising ref name cannot turn into an argument we did not expect.
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

let repoRoot = null;
let lastCheck = null;

function git(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }),
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        out: String(stdout || '').trim(),
        err: String(stderr || '').trim(),
      });
    });
  });
}

// Where the checkout is. Found once and remembered; the running directory
// is normally inside it, with the source tree as a fallback.
async function root() {
  if (repoRoot) return repoRoot;
  const guesses = [process.cwd(), path.resolve(__dirname, '..', '..')];
  for (const dir of guesses) {
    const r = await git(['rev-parse', '--show-toplevel'], dir, TIMEOUT.quick);
    if (r.ok && r.out) { repoRoot = r.out; return repoRoot; }
  }
  return null;
}

async function counts(dir, upstream) {
  if (!SAFE_REF.test(upstream)) return null;
  const r = await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], dir, TIMEOUT.normal);
  if (!r.ok) return null;
  const parts = r.out.split(/\s+/);
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { behind, ahead };
}

// Local facts only: cheap, never touches the network.
async function local() {
  const dir = await root();
  if (!dir) return { ok: false, error: 'not-a-repo' };

  const [branch, sha, dirty, upstream] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, TIMEOUT.quick),
    git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick),
    // Untracked files are left out on purpose. A fast-forward cannot lose
    // them - if an incoming file would overwrite one, git refuses the pull by
    // itself - so they must never be the thing standing between the checkout
    // and an update. Only edits to tracked files, which a pull would clobber,
    // are work that blocks it.
    git(['status', '--porcelain', '--untracked-files=no'], dir, TIMEOUT.normal),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir, TIMEOUT.quick),
  ]);
  if (!branch.ok || !sha.ok) return { ok: false, error: 'not-a-repo' };

  return {
    ok: true,
    branch: branch.out,
    sha: sha.out.slice(0, 7),
    full: sha.out,
    dirty: dirty.out.length > 0,
    upstream: upstream.ok && SAFE_REF.test(upstream.out) ? upstream.out : null,
  };
}

// What we know without going online, plus whatever the last fetch found.
async function status() {
  const l = await local();
  if (!l.ok) return l;
  const behind = lastCheck && lastCheck.upstream === l.upstream ? lastCheck.behind : null;
  return {
    ok: true,
    branch: l.branch,
    sha: l.sha,
    dirty: l.dirty,
    upstream: l.upstream,
    behind,
    ahead: lastCheck && lastCheck.upstream === l.upstream ? lastCheck.ahead : null,
    checkedAt: lastCheck ? lastCheck.at : null,
  };
}

// Ask the remote what it has. This is the only thing that needs the network.
async function check() {
  const l = await local();
  if (!l.ok) return l;
  const dir = await root();

  if (!l.upstream) {
    return Object.assign({}, l, { ok: true, error: 'no-upstream', behind: null, checkedAt: Date.now() });
  }
  const fetched = await git(['fetch', '--quiet', REMOTE], dir, TIMEOUT.fetch);
  if (!fetched.ok) {
    // Offline is normal and is not an error worth shouting about: the last
    // known answer stays on screen with the reason attached.
    return Object.assign({}, await status(), { ok: true, checkFailed: 'unreachable', detail: fetched.err });
  }

  const c = await counts(dir, l.upstream);
  lastCheck = { at: Date.now(), upstream: l.upstream, behind: c ? c.behind : null, ahead: c ? c.ahead : null };
  return Object.assign({}, await status(), { ok: true });
}

// Bring the checkout up to its upstream. Fast-forward only: never a merge
// commit, never a stash of someone's work, and never over uncommitted edits to
// tracked files. Untracked files do not block it - see local() for why.
async function update() {
  const l = await local();
  if (!l.ok) return l;
  if (l.dirty) {
    return { ok: false, error: 'local-changes', branch: l.branch, sha: l.sha };
  }
  if (!l.upstream) {
    return { ok: false, error: 'no-upstream', branch: l.branch, sha: l.sha };
  }
  const dir = await root();

  const before = await git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick);
  if (!before.ok) return { ok: false, error: 'not-a-repo' };

  const pulled = await git(['pull', '--ff-only', '--quiet'], dir, TIMEOUT.pull);
  if (!pulled.ok) {
    return Object.assign({}, await status(), {
      ok: false,
      error: 'pull-failed',
      detail: pulled.err.split('\n').slice(0, 4).join(' '),
    });
  }

  const after = await git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick);
  const changed = await git(['diff', '--name-only', `${before.out}..${after.out}`], dir, TIMEOUT.normal);
  const files = changed.ok ? changed.out.split('\n').filter(Boolean) : [];

  // Recount rather than assuming: a pull that had nothing to do leaves the
  // checkout ahead of its upstream, not level with it. Clearing the cache
  // outright would have shown "unknown" immediately after a clean update.
  const now = await counts(dir, l.upstream);
  lastCheck = { at: Date.now(), upstream: l.upstream, behind: now ? now.behind : null, ahead: now ? now.ahead : null };

  return {
    ok: true,
    updated: after.out !== before.out,
    from: before.out.slice(0, 7),
    to: after.out.slice(0, 7),
    files: files.length,
    // Only ask for a reload when the thing that changed actually needs it.
    reloadExtension: files.some((f) => f.startsWith('extension/')),
    restartController: files.some((f) => f.startsWith('controller/')),
  };
}

// Push local commits to the remote upstream.
// Only pushes if on a git repo and safe branch.
async function push() {
  const l = await local();
  if (!l.ok) return l;
  const dir = await root();

  const before = await git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick);
  if (!before.ok) return { ok: false, error: 'not-a-repo' };

  let pushArgs = ['push', '--quiet'];
  if (!l.upstream) {
    if (!SAFE_REF.test(l.branch)) {
      return { ok: false, error: 'invalid-branch', branch: l.branch };
    }
    pushArgs = ['push', '-u', '--quiet', REMOTE, l.branch];
  }

  const pushed = await git(pushArgs, dir, TIMEOUT.push);
  if (!pushed.ok) {
    const isBehind = /fetch first|non-fast-forward|\[rejected\]/i.test(pushed.err);
    return Object.assign({}, await status(), {
      ok: false,
      error: isBehind ? 'push-rejected-behind' : 'push-failed',
      detail: pushed.err.split('\n').slice(0, 4).join(' '),
    });
  }

  const upstream = l.upstream || `${REMOTE}/${l.branch}`;
  const now = await counts(dir, upstream);
  lastCheck = {
    at: Date.now(),
    upstream,
    behind: now ? now.behind : 0,
    ahead: now ? now.ahead : 0,
  };

  return {
    ok: true,
    pushed: true,
    branch: l.branch,
    sha: before.out.slice(0, 7),
    ahead: now ? now.ahead : 0,
    behind: now ? now.behind : 0,
  };
}

// Bidirectional synchronization: pull incoming changes and push outgoing commits.
// If the checkout is behind, fast-forwards or rebases cleanly. If a rebase conflict
// occurs, the rebase is aborted immediately so work is never clobbered or left
// in a half-rebasing state.
async function sync() {
  const l = await local();
  if (!l.ok) return l;
  if (l.dirty) {
    return { ok: false, error: 'local-changes', branch: l.branch, sha: l.sha };
  }
  const dir = await root();

  // If no upstream is set yet and branch is valid, use origin/<branch>
  const upstream = l.upstream || (SAFE_REF.test(l.branch) ? `${REMOTE}/${l.branch}` : null);
  if (!upstream) {
    return { ok: false, error: 'no-upstream', branch: l.branch, sha: l.sha };
  }

  // Fetch remote state first
  const fetched = await git(['fetch', '--quiet', REMOTE], dir, TIMEOUT.fetch);
  if (!fetched.ok && l.upstream) {
    return Object.assign({}, await status(), {
      ok: false,
      error: 'unreachable',
      detail: fetched.err.split('\n').slice(0, 4).join(' '),
    });
  }

  const before = await git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick);
  if (!before.ok) return { ok: false, error: 'not-a-repo' };

  const c = await counts(dir, upstream);
  const behind = c ? c.behind : 0;
  const ahead = c ? c.ahead : 0;

  let pulled = false;
  let rebased = false;

  if (behind > 0) {
    if (ahead === 0) {
      // Pure fast-forward pull
      const rPull = await git(['pull', '--ff-only', '--quiet'], dir, TIMEOUT.pull);
      if (!rPull.ok) {
        return Object.assign({}, await status(), {
          ok: false,
          error: 'pull-failed',
          detail: rPull.err.split('\n').slice(0, 4).join(' '),
        });
      }
      pulled = true;
    } else {
      // Both ahead and behind: rebase pull to incorporate remote changes cleanly
      const rRebase = await git(['pull', '--rebase', '--quiet'], dir, TIMEOUT.pull);
      if (!rRebase.ok) {
        // Abort immediately so checkout is left clean
        await git(['rebase', '--abort'], dir, TIMEOUT.quick);
        return Object.assign({}, await status(), {
          ok: false,
          error: 'sync-conflict',
          detail: 'Remote changes conflict with local commits. Rebase was aborted to protect your checkout.',
        });
      }
      pulled = true;
      rebased = true;
    }
  }

  // Check remaining commits to push
  const postPullCounts = await counts(dir, upstream);
  const remainingAhead = postPullCounts ? postPullCounts.ahead : ahead;
  let pushed = false;

  if (remainingAhead > 0 || !l.upstream) {
    let pushArgs = ['push', '--quiet'];
    if (!l.upstream) {
      pushArgs = ['push', '-u', '--quiet', REMOTE, l.branch];
    }
    const rPush = await git(pushArgs, dir, TIMEOUT.push);
    if (!rPush.ok) {
      return Object.assign({}, await status(), {
        ok: false,
        error: 'push-failed',
        detail: rPush.err.split('\n').slice(0, 4).join(' '),
      });
    }
    pushed = true;
  }

  const after = await git(['rev-parse', 'HEAD'], dir, TIMEOUT.quick);
  const changed = await git(['diff', '--name-only', `${before.out}..${after.out}`], dir, TIMEOUT.normal);
  const files = changed.ok ? changed.out.split('\n').filter(Boolean) : [];

  const now = await counts(dir, upstream);
  lastCheck = {
    at: Date.now(),
    upstream,
    behind: now ? now.behind : 0,
    ahead: now ? now.ahead : 0,
  };

  return {
    ok: true,
    synced: true,
    pulled,
    pushed,
    rebased,
    updated: after.out !== before.out,
    from: before.out.slice(0, 7),
    to: after.out.slice(0, 7),
    files: files.length,
    ahead: now ? now.ahead : 0,
    behind: now ? now.behind : 0,
    reloadExtension: files.some((f) => f.startsWith('extension/')),
    restartController: files.some((f) => f.startsWith('controller/')),
  };
}

module.exports = { status, check, update, pull: update, push, sync, local, root };