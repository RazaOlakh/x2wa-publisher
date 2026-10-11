// Reading and updating the local checkout.
//
// Everything here runs git with an argument array and never through a shell,
// the remote and the branch are never taken from the caller, and every
// command has a timeout. GIT_TERMINAL_PROMPT is switched off so a fetch that
// needs credentials fails straight away instead of sitting there waiting for
// input it will never get.
const { execFile } = require('child_process');
const path = require('path');

const TIMEOUT = { quick: 10000, normal: 20000, fetch: 45000, pull: 90000 };
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
    git(['status', '--porcelain'], dir, TIMEOUT.normal),
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
// commit, never a stash of someone's work, and never over a dirty tree.
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

  lastCheck = null; // the comparison is against the old commit now
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

module.exports = { status, check, update, local, root };