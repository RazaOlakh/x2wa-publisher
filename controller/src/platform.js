// Per-user data locations and single-instance protection.
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
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  return '/usr/bin/google-chrome-stable';
}

module.exports = { userDataRoot, sessionDir, tmpRoot, acquireSessionLock, isAlive, findChromeExecutable };