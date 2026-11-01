// Per-user data locations, the browser to run, and single-instance protection.
//
// The WhatsApp session must live in one stable, per-user directory: it is
// what lets the controller reconnect after a restart or reboot without a
// new QR scan. SESSION_DIR overrides it (the systemd unit sets it
// explicitly); otherwise each platform gets its conventional location.
const path = require('path');
const os = require('os');
const fs = require('fs');

// Per-user application data:
//   Linux   $XDG_DATA_HOME or ~/.local/share
//   macOS   ~/Library/Application Support
//   Windows %LOCALAPPDATA%
function userDataRoot() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'x-whatsapp-poster');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'x-whatsapp-poster');
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share', 'x-whatsapp-poster');
}

function sessionDir() {
  return process.env.SESSION_DIR || path.join(userDataRoot(), 'whatsapp-session');
}

function tmpRoot() {
  return process.env.TMP_ROOT || path.join(userDataRoot(), 'tmp');
}

// The browser WhatsApp Web runs in.
//
// CHROME_PATH wins when it is set: the service and the Windows launcher always
// set it, pinned to an absolute path resolved at install time. Otherwise the
// platform's conventional location is used, and if none is found the choice is
// left to puppeteer rather than handed a path that cannot exist.
//
// Falling back to a hard-coded Linux path is what broke Windows: on a machine
// where Chrome was installed elsewhere (or not at all), the controller spent
// forever trying to launch a file that was never there, so it never connected.
// The decision is a pure function of platform, environment and "does it
// exist", so it can be tested without the browser.
function defaultExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function chromePath(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const exists = opts.exists || defaultExists;
  if (env.CHROME_PATH) return env.CHROME_PATH;
  const candidates = [];
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    candidates.push('/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  for (const c of candidates) if (c && exists(c)) return c;
  return undefined;
}

// WhatsApp Web launches a browser against the session directory, so two
// controllers sharing one directory corrupt it (the symptom is
// "Attempted to use detached Frame" or a permanently stuck login). A lock
// file with the owning pid keeps the second instance out.
function acquireSessionLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'controller.lock');
  if (fs.existsSync(lock)) {
    let pid = null;
    try { pid = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10); } catch {}
    if (pid && pid !== process.pid && isAlive(pid)) {
      const err = new Error(`another controller (pid ${pid}) is already using ${dir}`);
      err.code = 'ESESSIONLOCKED';
      err.pid = pid;
      throw err;
    }
  }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { fs.rmSync(lock, { force: true }); } catch {} };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
  return lock;
}

function isAlive(pid) {
  if (!pid || typeof pid !== 'number' || isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (process.platform !== 'win32' && e.code === 'EPERM') return true;
    return false;
  }
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return out.toLowerCase().includes('node.exe');
    }
    if (process.platform === 'linux') {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      return comm.startsWith('node');
    }
  } catch {
    return true;
  }
  return true;
}

module.exports = { userDataRoot, sessionDir, tmpRoot, acquireSessionLock, isAlive, chromePath };

