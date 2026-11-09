// X → WhatsApp Channel Poster — production local controller
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Load environment variables from .env files if present (zero-dependency)
function loadEnv() {
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '..', '..', '.env'),
    path.join(os.homedir(), '.config', 'x-whatsapp-poster', 'env'),
    path.join(os.homedir(), '.config', 'x2wa', 'env'),
  ];
  for (const envPath of envCandidates) {
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (key && process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      }
    } catch {}
  }
}
loadEnv();

function persistEnvKey(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  let lines = [];
  if (fs.existsSync(envPath)) {
    try {
      lines = fs.readFileSync(envPath, 'utf8').split('\n');
    } catch {}
  }
  let found = false;
  const prefix = `${key}=`;
  const newLines = [];
  for (const line of lines) {
    if (line.trim().startsWith(prefix)) {
      found = true;
      if (value !== undefined && value !== null && value !== '') {
        newLines.push(`${key}="${value}"`);
      }
    } else {
      newLines.push(line);
    }
  }
  if (!found && value !== undefined && value !== null && value !== '') {
    newLines.push(`${key}="${value}"`);
  }
  try {
    fs.writeFileSync(envPath, newLines.filter(Boolean).join('\n') + '\n', 'utf8');
  } catch {}
}

const { execSync } = require('child_process');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-generator');
const { sessionDir, tmpRoot, acquireSessionLock, chromePath } = require('./platform');
const { listPostableChannels, canPostToChannel } = require('./channels');
const { createHeartbeat, isStartupStuck } = require('./heartbeat');
const repo = require('./repo');
const { decodeInlineImage, isInlineImage, MAX_INLINE_BYTES } = require('./inline-media');
const videoPipeline = require('./video-pipeline');
const hlsPrefetch = require('./hls-prefetch');
const duplicate = require('./duplicate-guard');
const {
  translateText,
  translateTextWithMeta,
  readTranslateRequest,
  transliterateText,
  translatePostText,
  translatePostTextWithMeta,
  compareTranslations,
} = require('./translate');
const {
  resolveTransliteration,
  defaultStore: overridesStore,
  MAX_NAME_CHARS,
  isUrduText,
} = require('./transliterate');
const {
  DEFAULT_MODEL: GROQ_DEFAULT_MODEL,
  SUPPORTED_MODELS: GROQ_SUPPORTED_MODELS,
  formatModelDisplayName: formatGroqModelDisplayName,
  isGroqConfigured,
  formatDualAuthorForUrdu,
  formatAuthorNameDual,
} = require('./groq');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.CONTROLLER_PORT || '47825', 10);
const SESSION_DIR = sessionDir();
const TMP_ROOT = tmpRoot();
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
// HLS segment fetching. 8 workers measured 2.24 MB/s against 0.29 MB/s
// serially on this project's own sources; the cap keeps a large video from
// opening an unbounded number of sockets.
const HLS_CONCURRENCY = 8;
const HLS_RETRIES = 3;

fs.mkdirSync(TMP_ROOT, { recursive: true });
// Refuse to start a second client against the same session directory.
try {
  acquireSessionLock(SESSION_DIR);
} catch (e) {
  console.error(`[controller] ${e.message}`);
  process.exit(3);
}

let state = 'starting';
let stateEnteredAt = Date.now();
function setState(s) {
  if (state !== s) {
    state = s;
    stateEnteredAt = Date.now();
  }
}
let lastQr = null;
let qrIssuedAt = 0;
let waInfo = null;
let lastError = null;
let lastChannelError = null;
let channelCache = null;
const CHANNEL_CACHE_MS = 30000;
const jobs = new Map();
let currentJob = null;
let lastTranslationInfo = null;
// True while a send is in progress, so the watchdog leaves it alone.
let jobRunning = false;
const duplicateLog = new Map();

function log(level,event,data){ const rec={ts:new Date().toISOString(),level,component:'controller',event,...(data||{})}; try{ console.log(JSON.stringify(rec)); }catch{ console.log(`${level} ${event}`); } }

function cleanStaleSingletonLocks() {
  const dirs = [
    SESSION_DIR,
    path.join(SESSION_DIR, 'session'),
    path.join(SESSION_DIR, 'session', 'Default'),
    path.join(SESSION_DIR, 'Default'),
  ];
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const dir of dirs) {
    for (const name of lockNames) {
      try {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
          log('info', 'stale-singleton-removed', { file });
        }
      } catch {}
    }
  }
}

// The dedicated WhatsApp account. LocalAuth keeps the session in
// SESSION_DIR so the next start reconnects without another QR scan.
function makeClient() {
  // The browser is chosen per platform (CHROME_PATH first, then the platform's
  // usual location). If nothing is found the path is left to puppeteer, which
  // reports a missing browser far more clearly than a path that never existed.
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (process.platform === 'win32') {
    args.push(
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check'
    );
  }
  const launch = { headless: true, args };
  const exe = chromePath();
  if (exe) launch.executablePath = exe;
  return new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: launch,
  });
}

let client = null;
const recentMessages = [];

function startClient(reason) {
  if (client) return;
  cleanStaleSingletonLocks();
  setState(state === 'ready' ? state : 'starting');
  log('info','client-start',{ reason, sessionDir: SESSION_DIR });
  client = makeClient();
  client.on('qr', (qr) => {
    setState('qr'); lastQr = qr; qrIssuedAt = Date.now();
    log('info','qr-state',{status:'waiting-for-user'});
    // Printed for a user working in a terminal; never written to a log file.
    try { qrcode.generate(qr, { small: true }); } catch {}
  });
  client.on('authenticated', () => { setState('authenticated'); log('info','authenticated'); });
  client.on('auth_failure', (m) => { setState('auth_failure'); log('error','auth-failure',{error:String(m)}); });
  // A clean disconnect also rebuilds the client from the saved session.
  client.on('ready', () => {
    setState('ready'); waInfo = client.info; lastQr = null; channelCache = null;
    restartAttempts = 0; restartPending = false; beat.reset();
    log('info','ready',{me: waInfo && waInfo.wid && waInfo.wid._serialized});
  });
  client.on('message', (msg) => {
    try {
      recentMessages.push({
        id: msg.id ? msg.id._serialized : null,
        from: msg.from,
        to: msg.to,
        fromMe: Boolean(msg.fromMe),
        body: msg.body,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        type: msg.type
      });
      if (recentMessages.length > 200) recentMessages.shift();
      log('info', 'incoming-message', { from: msg.from, body: msg.body });
    } catch {}
  });
  client.on('disconnected', (r) => {
    log('warn','disconnected',{reason:String(r)});
    markConnectionStale('disconnected');
  });
  client.initialize().catch((e) => {
    log('error','init-error',{error:e && e.message});
    if (process.platform === 'win32' || (e && e.message && e.message.includes('already running'))) {
      killOrphanedSessionBrowsers();
    }
    markConnectionStale('init-error');
  });
}

// Logging out is destructive (the saved session is invalidated), so it is
// explicit and never happens on its own. A fresh client is started
// straight afterwards so the user gets a new QR to pair with, instead of
// being left with a stopped controller and no way forward.
async function logout(reason) {
  if (!client) {
    setState('auth_required');
    log('info','logout-noop',{reason});
    startClient('after-logout');
    return { ok: true, alreadyStopped: true };
  }
  const c = client;
  client = null; lastQr = null; waInfo = null; channelCache = null; setState('stopped');
  try { await c.logout(); } catch (e) { log('warn','logout-error',{error:String((e && e.message) || e)}); }
  try { await c.destroy(); } catch (e) { log('warn','destroy-error',{error:String((e && e.message) || e)}); }
  log('info','logged-out',{reason});
  setState('auth_required');
  startClient('after-logout');
  return { ok: true };
}

// Sleep/wake (and any other event that kills the browser without a clean
// disconnect) leaves the client thinking it is ready while the WhatsApp
// page is dead: whatsapp-web.js emits no 'disconnected' in that case, so
// the first sign of trouble is an operation failing. On any such failure the
// client is treated as unusable and rebuilt from the same saved session,
// which reconnects without a new QR scan.
let restartTimer = null;
let restartAttempts = 0;
let restartPending = false;

// Resolves once the client is connected again (or the wait runs out).
function waitForReady(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  return new Promise((resolve) => {
    const tick = () => {
      if (state === 'ready' && client) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

function restartBackoffMs(attempts) {
  return Math.min(2000 * Math.pow(2, Math.max(0, attempts - 1)), 60000);
}

// Closing the browser and starting its replacement are not atomic. destroy()
// only asks Chromium to close; the process can still be shutting down and
// still holding the session profile when the new browser tries to use it.
// Losing that race fails the new launch with "The browser is already
// running...", which then backs off a minute at a time and leaves the
// controller unusable for several minutes. So wait for the old process to
// actually be gone before anything tries to take its place.
const BROWSER_EXIT_WAIT_MS = 10000;

async function stopClient(c) {
  if (!c) {
    if (process.platform === 'win32') killOrphanedSessionBrowsers();
    return;
  }
  let proc = null;
  try {
    const b = c.pupBrowser;
    proc = b && typeof b.process === 'function' ? b.process() : null;
  } catch { /* nothing to wait on */ }

  const destroyPromise = Promise.resolve().then(() => c.destroy());
  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    await Promise.race([destroyPromise, timeoutPromise]);
  } catch (e) {
    log('warn', 'destroy-error', { error: String((e && e.message) || e) });
  }

  if (proc) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${proc.pid} /t /f`, { stdio: 'ignore' });
      } else if (proc.exitCode === null && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {}
  }

  if (process.platform === 'win32') {
    killOrphanedSessionBrowsers();
  }
}

function killOrphanedSessionBrowsers() {
  if (process.platform === 'win32') {
    try {
      const psScript = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*x-whatsapp-poster*' -or $_.CommandLine -like '*whatsapp-session*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }
}

function markConnectionStale(reason) {
  if (restartPending) return;
  restartPending = true;
  const isUserRestart = reason && String(reason).startsWith('user-restart');
  if (isUserRestart) {
    restartAttempts = 0;
  } else {
    restartAttempts += 1;
  }
  const delay = isUserRestart ? 0 : restartBackoffMs(restartAttempts);
  // Report the truth while we rebuild, instead of claiming "ready".
  setState('reconnecting');
  log('warn', 'connection-stale', { reason, attempt: restartAttempts, retryInMs: delay });
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const stale = client;
    client = null;
    lastQr = null; waInfo = null; channelCache = null;
    try {
      await stopClient(stale);
    } catch (e) {
      log('warn', 'stop-client-error', { error: String((e && e.message) || e) });
    } finally {
      restartPending = false;
      startClient('recover:' + reason);
    }
  }, delay);
  if (restartTimer.unref) restartTimer.unref();
}

// --- liveness watchdog ---------------------------------------------------
// A sleep/resume (or a stopped machine) freezes the WhatsApp page without any
// 'disconnected' event, so the client goes on saying "ready" while nothing
// works. The heartbeat asks the page for its own connection state, and notices
// when it arrives far too late to be an ordinary beat. Either signal rebuilds
// the client from the same saved session, which reconnects without a new QR.
const HEARTBEAT_MS = 30000;
const beat = createHeartbeat({ beatMs: HEARTBEAT_MS });
let lastBeatAt = Date.now();
let beatRunning = false;

async function heartbeat() {
  const now = Date.now();
  const gap = now - lastBeatAt;
  lastBeatAt = now;

  if (beat.sleptFor(gap)) {
    log('warn', 'system-resume', { gapMs: Math.round(gap) });
    markConnectionStale('system-resume');
    return;
  }

  // Watchdog for reconnecting state: if stuck reconnecting for over 45s, force recover
  if (state === 'reconnecting' && (now - stateEnteredAt >= 45000)) {
    log('warn', 'reconnect-stuck', { state, elapsedMs: now - stateEnteredAt });
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (process.platform === 'win32') {
      killOrphanedSessionBrowsers();
    }
    const stale = client;
    client = null;
    lastQr = null; waInfo = null; channelCache = null;
    restartPending = false;
    restartAttempts = 0;
    if (stale) {
      stopClient(stale).catch(() => {});
    }
    startClient('watchdog-timeout');
    return;
  }

  // Startup watchdog: if stuck in 'starting' or 'authenticated' for over 60 seconds,
  // recover the connection by restarting the client.
  if (!restartPending && isStartupStuck(state, now - stateEnteredAt)) {
    log('warn', 'startup-stuck', { state, elapsedMs: now - stateEnteredAt });
    markConnectionStale('startup-stuck:' + state);
    return;
  }
  // Never rebuild underneath a post that is still running: the send reports
  // its own failures, and tearing the client down mid-send only adds to them.
  if (state !== 'ready' || !client || beatRunning || jobRunning) return;

  beatRunning = true;
  try {
    const waState = await client.getState();
    const seen = beat.observe(waState);
    if (state !== 'ready') return; // went stale while we were asking
    if (seen.verdict === 'recovered') log('info', 'heartbeat-recovered', { afterMisses: seen.misses });
    else if (seen.verdict === 'restart') markConnectionStale('heartbeat-' + String(waState));
  } catch (e) {
    // The page itself is gone, which is what a sleep/resume looks like.
    log('warn', 'heartbeat-failed', { error: e && e.message });
    markConnectionStale('heartbeat-failed');
  } finally {
    beatRunning = false;
  }
}

setInterval(heartbeat, HEARTBEAT_MS).unref();

// systemd stops the controller with SIGTERM. The WhatsApp browser is a
// separate process that survives its parent: without shutting it down here,
// a restart leaves that browser holding the session profile, and the next
// start cannot launch its own ("The browser is already running...") and
// spends minutes failing before the lock clears. Closing it on the way out
// keeps restarts and sleeps fast.
//
// These are *prepended*, not appended: acquiring the session lock installs
// its own SIGTERM handler that releases the lock and calls process.exit()
// straight away, and a listener registered earlier runs first. Appended,
// this handler would never get to run -- the process would already be gone,
// leaving the browser behind as an orphan.
let shuttingDown = false;

// console.log to a pipe is buffered, and process.exit() below would drop the
// last line of the most interesting log the controller ever writes. Writing
// straight to the descriptor keeps it.
function logSync(level, event, data) {
  const rec = { ts: new Date().toISOString(), level, component: 'controller', event, ...(data || {}) };
  try { fs.writeSync(1, JSON.stringify(rec) + '\n'); } catch { /* stdout closed */ }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.prependListener(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logSync('info', 'shutdown', { signal });
    // Never hang here: being killed by systemd's timeout would orphan the
    // browser again, which is the very thing being avoided.
    const bail = setTimeout(() => process.exit(0), 8000);
    if (bail.unref) bail.unref();
    setState('stopped');
    const c = client;
    client = null;
    // Bounded on purpose: systemd has already signalled the whole process
    // group, so the browser is on its way out, and destroy() can sit there
    // waiting for a browser that will never answer. Waiting forever would
    // just stall the restart.
    if (c) {
      try {
        await Promise.race([stopClient(c), new Promise((r) => setTimeout(r, 3000))]);
        logSync('info', 'shutdown-complete', { signal });
      } catch (e) { logSync('warn', 'destroy-error', { error: String((e && e.message) || e) }); }
    }
    clearTimeout(bail);
    process.exit(0);
  });
}

startClient('startup');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, *',
  'Access-Control-Allow-Private-Network': 'true',
};

function json(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)); res.end(JSON.stringify(obj, null, 1)); }

// Renders the pairing QR as an SVG data URL. The extension displays the
// image, so the scannable payload itself is never sent to the browser
// extension, written to a log, or stored anywhere.
function qrImageSvg(qrText) {
  const qr = QRCode(0, 'M');
  qr.addData(qrText);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const cells = n + quiet * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges"><rect width="${cells}" height="${cells}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
function newJob() { return crypto.randomBytes(8).toString('hex'); }

// WhatsApp Web sometimes throws minified/empty errors; always produce a
// non-empty human-readable message for partial-failure reporting.
function errMsg(e) {
  if (!e) return 'unknown-error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return String(e); } catch { return 'unknown-error'; }
}

// Media the extension could not resolve before sending. Newer builds send
// `mediaFailures` (images and videos); older ones only sent `imageFailures`.
function extractionFailures(body) {
  const from = Array.isArray(body.mediaFailures) ? body.mediaFailures
    : (Array.isArray(body.imageFailures) ? body.imageFailures : []);
  return from.map((f) => ({ index: f && f.index, type: (f && f.type) || 'media', error: (f && f.error) || 'media-not-extracted' }));
}

function validMedia(m) {
  if (!m || !['image', 'video'].includes(m.type)) return false;
  if (typeof m.source !== 'string' || m.source.length === 0) return false;
  // A screenshot is sent inline and is far larger than a URL, so it gets a
  // size bound of its own rather than the URL's character limit.
  if (isInlineImage(m.source)) return m.type === 'image' && m.source.length <= MAX_INLINE_BYTES;
  return m.source.length < 4096;
}

async function download(source, dest, timeoutMs) {
  log('info','media-download-start',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,source});
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(source);
      const lib = url.protocol === 'https:' ? require('https') : require('http');
      const file = fs.createWriteStream(dest);
      const req = lib.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          file.close(); fs.rmSync(dest, { force: true });
          return resolve(download(new URL(r.headers.location, source).toString(), dest, timeoutMs));
        }
        let total = 0;
        r.on('data', (c) => { total += c.length; if (total > MAX_MEDIA_BYTES) { req.destroy(); file.close(); fs.rmSync(dest, { force: true }); log('error','media-too-large',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId}); reject(new Error('media-too-large')); } });
        r.pipe(file);
        file.on('finish', () => { if (fs.statSync(dest).size > MAX_MEDIA_BYTES) { fs.rmSync(dest, { force: true }); log('error','media-too-large',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId}); reject(new Error('media-too-large')); } log('info','media-download-done',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,size:fs.statSync(dest).size}); resolve(); });
      });
      req.on('error', (e) => { try{ log('error','media-download-error',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,error:e&&e.message}); }catch{} file.close(); fs.rmSync(dest, { force: true }); reject(e); });
      req.setTimeout(timeoutMs, () => { try{ log('warn','media-download-timeout',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId}); }catch{} req.destroy(); file.close(); fs.rmSync(dest, { force: true }); reject(new Error('download-timeout')); });
    } catch (e) { reject(e); }
  });
}

// X media URLs are signed with query parameters. Those are needed to fetch
// the media but must not accumulate in logs, so anything logged for a URL is
// reduced to its origin and path.
function redactUrl(u) {
  if (typeof u !== 'string') return u;
  const i = u.indexOf('?');
  return i === -1 ? u : `${u.slice(0, i)}?…`;
}

// X media URLs (e.g. pbs.twimg.com/...?format=webp&name=large)
// carry no file extension, so downloads land as "<hex>.bin" and
// MessageMedia.fromFilePath derives application/octet-stream from
// the extension. WhatsApp Web then uploads the attachment as a
// document, which channel recipients render as "You received a
// channel update but your version of WhatsApp doesn't support it".
// Sniff the real image format from the file's magic bytes and give
// the file the matching extension so it uploads as an image.
function sniffImageExt(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    const b = buf.slice(0, n);
    if (n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
    if (n >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
    if (n >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
    if (n >= 16 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp';
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function processMedia(item, jobDir, index) {
  // Each media item gets its own output paths: a post with several videos
  // must not have every video muxed into (and overwritten at) one file.
  const tag = (Number.isInteger(index) ? index : 0);
  log('info','media-process-start',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,type:item.type,index:tag});
  if (item.type === 'video') {
    const out = path.join(jobDir, `out-${tag}.mp4`);
    const t0 = Date.now();
    let built = null;

    if (/^https?:\/\//i.test(item.source) && /\.m3u8(\?|$)/i.test(item.source)) {
      // HLS. Fetch the segments concurrently, then remux locally.
      //
      // ffmpeg's own HLS demuxer pulls one segment at a time, and each one
      // costs a round trip: measured on a 5-minute X video it used ~1s of
      // CPU and ~40-70s of wall clock, so the wait was the network, not the
      // encoding. Fetching in parallel and handing ffmpeg local files keeps
      // ffmpeg doing the demux while taking that serial wait out.
      const dir = path.join(jobDir, `hls-${tag}`);
      const fp0 = Date.now();
      let plan = null;
      try {
        plan = await hlsPrefetch.prefetch(item.source, dir, {
          concurrency: HLS_CONCURRENCY,
          retries: HLS_RETRIES,
          maxBytes: MAX_MEDIA_BYTES,
        });
      } catch (e) {
        // A prefetch failure is a source failure, not something a re-encode
        // can repair, so it is reported rather than retried more slowly.
        log('warn','media-hls-prefetch-failed',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,index:tag,error:String((e&&e.message)||e)});
        throw new Error('video-prefetch-failed');
      }
      const fetchMs = Date.now() - fp0;
      log('info','media-hls-prefetched',{
        requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,index:tag,
        fetchMs, videoSegments:plan.videoSegments, audioSegments:plan.audioSegments,
        bytes:plan.bytes, retries:plan.retries, resolution:plan.variant&&plan.variant.resolution,
      });
      built = await videoPipeline.buildVideo(
        plan.audioPlaylist ? [plan.videoPlaylist, plan.audioPlaylist] : [plan.videoPlaylist],
        out,
        { expectsAudio: plan.expectsAudio, localInput: true },
      );
    } else if (/^https?:\/\//i.test(item.source)) {
      const file = path.join(jobDir, `input-${tag}.bin`);
      await download(item.source, file, DOWNLOAD_TIMEOUT_MS);
      const stat = fs.statSync(file);
      if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
      built = await videoPipeline.buildVideo([file], out, {});
    } else if (fs.existsSync(item.source)) {
      const stat = fs.statSync(item.source);
      if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
      built = await videoPipeline.buildVideo([item.source], out, {});
    } else {
      throw new Error('media-source-invalid');
    }

    if (!built || !built.ok) {
      log('error','media-video-build-failed',{
        requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,index:tag,
        path:built&&built.path, attempts:built&&built.attempts,
      });
      throw new Error((built && built.error) || 'ffmpeg-validation-failed');
    }
    const stat = fs.statSync(out);
    log('info','media-video-built',{
      requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,index:tag,
      path:built.path, totalMs:Date.now()-t0, size:stat.size,
      videoCodec:built.info&&built.info.videoCodec, audioCodec:built.info&&built.info.audioCodec,
      width:built.info&&built.info.width, height:built.info&&built.info.height,
      duration:built.info&&built.info.duration,
      attempts:built.attempts.map((a) => ({ path: a.path, ok: a.ok, ms: a.ms, reason: a.reason, skipped: a.skipped })),
    });
    return out;
  }

  const file = path.join(jobDir, `${tag}-` + crypto.randomBytes(6).toString('hex') + '.bin');
  if (isInlineImage(item.source)) {
    // A screenshot, captured in the browser and handed over in the request.
    const decoded = decodeInlineImage(item.source);
    if (decoded.error) throw new Error(decoded.error);
    fs.writeFileSync(file, decoded.buffer);
    log('info','media-inline-write',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,index:tag,type:decoded.type,size:decoded.buffer.length});
  } else if (/^https?:\/\//i.test(item.source)) {
    await download(item.source, file, DOWNLOAD_TIMEOUT_MS);
  } else if (fs.existsSync(item.source)) {
    fs.copyFileSync(item.source, file);
  } else {
    throw new Error('media-source-invalid');
  }
  const stat = fs.statSync(file);
  if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
  if (item.type === 'image') {
    const ext = sniffImageExt(file);
    if (ext) {
      const renamed = path.join(jobDir, path.basename(file, '.bin') + ext);
      fs.renameSync(file, renamed);
      log('info','media-image-format-detected',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId,ext});
      return renamed;
    }
    log('warn','media-image-format-unknown',{requestId:currentJob&&currentJob.requestId,jobId:currentJob&&currentJob.jobId});
  }
  return file;
}

async function sendJob(body) {
  jobRunning = true;
  try {
    return await runSend(body);
  } finally {
    jobRunning = false;
  }
}

async function runSend(body) {
  const requestId = body.requestId || newJob();
  const { tweetId, tweetUrl, text, media, channelId } = body;
  const key = `${tweetId}|${channelId}`;
  const now = Date.now();
  currentJob = { requestId, jobId: null, tweetId, channelId };
  log('info','send-request-received',{requestId,tweetId,channelId,mediaTypes:media&&media.map(m=>m.type)});
  const prev = duplicateLog.get(key);
  if (duplicate.isDuplicate(prev, now)) {
    log('warn','duplicate-send',{requestId,tweetId,channelId,prior: prev});
    return { ok: false, error: 'duplicate-send', prior: prev };
  }
  const jobId = newJob();
  duplicateLog.set(key, { ts: now, status: 'pending', jobId });
  currentJob.jobId = jobId;
  log('info','job-created',{requestId,jobId,tweetId,channelId});
  const jobDir = path.join(TMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  jobs.set(jobId, { status: 'started' });

  try {
    if (state !== 'ready' || !client) { jobs.set(jobId, { status: 'failed', error: 'whatsapp-not-ready' }); cleanup(jobDir); log('error','whatsapp-not-ready',{requestId,jobId,tweetId,channelId}); return { ok: false, error: 'whatsapp-not-ready', jobId }; }
    // Re-check posting rights at send time: a channel can lose admin
    // between selection and publish. If it cannot be confirmed, refuse.
    // Distinguish "we checked and you may not post" from "we could not
    // check right now". A transient page fault (a detached frame after the
    // machine sleeps, say) must not fail the post: the connection is
    // rebuilt and the check retried once the client is healthy again.
    let permit = await canPostToChannel(client, channelId);
    if (!permit.ok && permit.error) {
      log('warn','permission-check-retry',{requestId,jobId,channelId,error:permit.error});
      markConnectionStale('permission-probe-failed');
      const healthy = await waitForReady(45000);
      log('info','permission-check-recheck',{requestId,jobId,channelId,healthy});
      if (healthy && client) permit = await canPostToChannel(client, channelId);
    }
    if (!permit.ok) {
      const unverifiable = Boolean(permit.error);
      const code = unverifiable ? 'permission-check-failed' : 'channel-not-permitted';
      jobs.set(jobId, { status: 'failed', error: code }); cleanup(jobDir);
      log('warn', unverifiable ? 'permission-check-failed' : 'channel-not-permitted',
        { requestId, jobId, tweetId, channelId, role: permit.role, state: permit.state, error: permit.error });
      return {
        ok: false, error: code, jobId,
        reason: unverifiable ? 'permission-check-failed'
          : (permit.state === 'terminated' ? 'channel-terminated' : 'insufficient-permission'),
        retryable: unverifiable,
      };
    }
    const mediaFiles = [];
    const sendFailures = [];
    // The "post in Urdu" button asks for the text to be translated before it
    // is sent. Only the text goes to the translator; its link stays in place,
    // so a text-only post's link-first order (and the preview it earns) is
    // preserved. A failure is reported rather than quietly posting the
    // original, which would be the wrong language with nothing to show for it.
    let outText = text;
    let translationMeta = null;
    if (body.translateTo) {
      const target = String(body.translateTo);
      const t0 = Date.now();
      log('info','translate-start',{requestId,jobId,channelId,target,chars:text.length});
      try {
        const translation = await translatePostTextWithMeta(text, target, body.author, {
          log,
          authorHandle: body.authorHandle || body.handle || null,
        });
        outText = translation.text;
        translationMeta = {
          provider: translation.provider,
          model: translation.model,
          target,
          ts: Date.now(),
          author: translation.author || body.author || null,
          authorHandle: translation.authorHandle || body.authorHandle || body.handle || null,
          translatedAuthor: translation.translatedAuthor || '',
          authorCorrectionApplied: Boolean(translation.authorCorrectionApplied),
        };
        lastTranslationInfo = translationMeta;
        log('info','translate-done',{requestId,jobId,target,provider:translation.provider,model:translation.model,charsIn:text.length,charsOut:outText.length,ms:Date.now()-t0,authorCorrectionApplied:translationMeta.authorCorrectionApplied});
      } catch (e) {
        duplicateLog.set(key, { ts: now, status: 'failed', jobId });
        jobs.set(jobId, { status: 'failed', error: 'translate-failed' });
        cleanup(jobDir);
        log('warn','translate-failed',{requestId,jobId,target,error:errMsg(e)});
        return { ok: false, error: 'translate-failed', jobId, retryable: true };
      }
    } else if (body.author && typeof text === 'string') {
      const authorHandle = body.authorHandle || body.handle || null;
      const correction = authorHandle && typeof overridesStore.getCorrection === 'function'
        ? overridesStore.getCorrection(authorHandle)
        : (overridesStore.lookup(body.author, authorHandle));
      const authorTrimmed = body.author.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
      const sep = text.indexOf('\n\n');
      const header = (sep > 0 ? text.slice(0, sep) : text).trim();
      const bodyContent = sep > 0 ? text.slice(sep + 2).trim() : '';

      if (correction && correction.transliteration) {
        const preferredUrdu = correction.transliteration.trim();
        const rightAuthor = formatDualAuthorForUrdu(`${preferredUrdu} | ${authorTrimmed}`);
        outText = bodyContent ? `${rightAuthor}\n\n${bodyContent}` : rightAuthor;
      } else {
      // For author name button (no translateTo):
      // If the post is in Urdu, write author name in both English and Urdu: `English Name   |   Urdu Name` (RIGHT side)
      // If the post is in English, author name remains in English only: `English Name` (LEFT side)
      const sep = text.indexOf('\n\n');
      const header = (sep > 0 ? text.slice(0, sep) : text).trim();
      const bodyContent = sep > 0 ? text.slice(sep + 2).trim() : '';
      const authorTrimmed = body.author.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
      const cleanHeader = header.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
      const isAuthorHeader = cleanHeader.toLowerCase() === authorTrimmed.toLowerCase() || cleanHeader === authorTrimmed;
      if (isAuthorHeader) {
        if (isUrduText(bodyContent || cleanHeader)) {
          try {
            const dualAuthor = await formatAuthorNameDual(authorTrimmed);
            if (dualAuthor) {
              const cleanDual = dualAuthor.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
              const rightAuthor = formatDualAuthorForUrdu(cleanDual);
              outText = bodyContent ? `${rightAuthor}\n\n${bodyContent}` : rightAuthor;
            }
          } catch {}
        } else {
          const leftAuthor = `\u200E\`${cleanHeader}\`\u200E`;
          outText = bodyContent ? `${leftAuthor}\n\n${bodyContent}` : leftAuthor;
        }
      }
    }
  }

    // Ensure author line alignment adheres strictly:
    // - Urdu post: author line on RIGHT side (\u200F)
    // - English post: author line on LEFT side (\u200E)
    if (outText && typeof outText === 'string') {
      const sep = outText.indexOf('\n\n');
      if (sep > 0) {
        const firstLine = outText.slice(0, sep).trim();
        const cleanFirst = firstLine.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
        const bodyContent = outText.slice(sep + 2).trim();
        const rawAuthor = (body.author && typeof body.author === 'string') ? body.author.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim() : '';
        const isAuthorFirstLine = cleanFirst.includes('|') || (rawAuthor && cleanFirst.toLowerCase() === rawAuthor.toLowerCase());
        if (isAuthorFirstLine) {
          const isUrduPost = isUrduText(bodyContent || cleanFirst) || body.translateTo === 'ur';
          if (isUrduPost) {
            outText = `${formatDualAuthorForUrdu(cleanFirst)}\n\n${bodyContent}`;
          } else {
            outText = `\u200E\`${cleanFirst}\`\u200E\n\n${bodyContent}`;
          }
        }
      }
    }
    // Append channel branding signature if provided
    let rawSig = body.signature;
    const postIsUrdu = isUrduText(outText) || body.translateTo === 'ur';
    if (postIsUrdu && body.signatureUrdu && typeof body.signatureUrdu === 'string' && body.signatureUrdu.trim()) {
      rawSig = body.signatureUrdu;
    }

    if (rawSig && typeof rawSig === 'string' && rawSig.trim()) {
      let sig = rawSig.trim();
      if (sig.includes('{channel}') || sig.includes('{channelName}')) {
        let chName = '';
        if (channelCache && channelCache.body && Array.isArray(channelCache.body.channels)) {
          const found = channelCache.body.channels.find(c => c.id === channelId);
          if (found && found.name) chName = found.name;
        }
        if (!chName && client) {
          try {
            const chat = await client.getChatById(channelId);
            if (chat && chat.name) chName = chat.name;
          } catch {}
        }
        sig = sig.replace(/\{channel\}/gi, chName || '').replace(/\{channelName\}/gi, chName || '');
      }

      if (sig.includes('{author}') || sig.includes('{authorName}')) {
        const rawAuthor = (body.author && typeof body.author === 'string') ? body.author : '';
        const cleanAuthor = rawAuthor.replace(/^[\u200E\u200F`]+|[\u200E\u200F`]+$/g, '').trim();
        const formattedAuthor = cleanAuthor ? (postIsUrdu ? formatDualAuthorForUrdu(cleanAuthor) : `\u200E\`${cleanAuthor}\`\u200E`) : '';
        sig = sig.replace(/\{authorName\}/gi, formattedAuthor).replace(/\{author\}/gi, formattedAuthor);
      }

      // Alignment & BiDi directional formatting:
      // Supports 'center' (default), 'left', or 'right' with identical syntax for both English and Urdu.
      const align = (body.signatureAlign || 'center').toLowerCase();
      const customIndent = typeof body.signatureIndent === 'number' && !isNaN(body.signatureIndent)
        ? Math.max(0, Math.min(100, Math.round(body.signatureIndent)))
        : null;

      sig = sig.split('\n').map(line => {
        if (!line.trim()) return line;
        const clean = line.replace(/[\u200E\u200F]/g, '').trim();
        if (align === 'left') {
          return `\u200E${clean}\u200E`;
        } else if (align === 'right') {
          return `\u200F${clean}\u200F`;
        } else {
          // Center: indent with non-breaking spaces and wrap with LRM for consistent centering
          let padCount = 24;
          if (customIndent !== null) {
            padCount = customIndent;
          } else {
            const visLen = clean.replace(/[*_~`]/g, '').length;
            // Target width ~65 characters (doubled/tripled for optical centering on WhatsApp bubbles)
            padCount = Math.max(8, Math.round((65 - visLen) / 2));
          }
          const pad = '\u00A0'.repeat(padCount);
          return `\u200E${pad}${clean}\u200E`;
        }
      }).join('\n');

      const isTop = body.signaturePlacement !== 'bottom';
      if (outText && outText.trim()) {
        outText = isTop ? `${sig}\n\n${outText.trim()}` : `${outText.trim()}\n\n${sig}`;
      } else {
        outText = sig;
      }
    }

    // Append channel invite link if provided and not already in outText
    if (body.channelLink && typeof body.channelLink === 'string' && body.channelLink.trim()) {
      const link = body.channelLink.trim();
      if (!outText.includes(link)) {
        if (body.channelLinkPos === 'top') {
          outText = `${link}\n\n${outText}`;
        } else {
          // Bottom (default): at the very end of the post
          outText = outText && outText.trim() ? `${outText.trim()}\n\n${link}` : link;
        }
      }
    }
    if (Array.isArray(media) && media.length > 0) {
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        if (!validMedia(m)) { sendFailures.push({ index: i, type: m && m.type, error: 'bad-media' }); log('error','bad-media',{requestId,jobId,tweetId,index:i}); continue; }
        try { log('info','media-process-url',{requestId,jobId,type:m.type,index:i,source:redactUrl(m.source)}); const f = await processMedia(m, jobDir, i); mediaFiles.push({ type: m.type, file: f, index: i, size: fs.existsSync(f) ? fs.statSync(f).size : 0 }); }
        catch (e) { try{ console.log('sendJob media error:', e && e.message, e && e.stack); }catch{} sendFailures.push({ index: i, type: m.type, error: errMsg(e) }); log('error','media-process-failed',{requestId,jobId,tweetId,index:i,error:errMsg(e)}); }
      }
    }

    log('info','whatsapp-send-start',{requestId,jobId,channelId,tweetId});
    const sent = [];
    if (mediaFiles.length === 0) {
      if (!outText) {
        // Nothing could be processed: report every intended-but-missing item.
        const none = [].concat(extractionFailures(body), sendFailures);
        jobs.set(jobId, { status: 'failed', error: 'empty-post', failures: none }); cleanup(jobDir); log('error','whatsapp-send-empty',{requestId,jobId,tweetId,failed:none.length}); return { ok: false, error: 'empty-post', jobId, ...(none.length ? { failures: none } : {}) };
      }
      log('info','whatsapp-send-text',{requestId,jobId});
      try {
        const m = await client.sendMessage(channelId, outText);
        sent.push({ type: 'text', id: m && m.id });
      } catch (e) { sendFailures.push({ index: -1, type: 'text', error: errMsg(e) }); log('error','whatsapp-send-text-failed',{requestId,jobId,tweetId,error:errMsg(e)}); }
    } else {
      for (let i = 0; i < mediaFiles.length; i++) {
        const mf = mediaFiles[i];
        // Timed separately from the processing above: for a large video the
        // upload can cost more than everything else combined, and "ffmpeg got
        // faster" is not the same as "the post arrives sooner".
        const up0 = Date.now();
        try {
          const read0 = Date.now();
          const msg = MessageMedia.fromFilePath(mf.file);
          const readMs = Date.now() - read0;
          const m = i === 0
            ? await client.sendMessage(channelId, msg, { caption: outText || undefined })
            : await client.sendMessage(channelId, msg);
          sent.push({ type: mf.type, id: m && m.id });
          log('info','media-upload-timed',{
            requestId,jobId,index:mf.index,type:mf.type,
            bytes:mf.size,readMs,uploadMs:Date.now()-up0,totalMs:Date.now()-up0,
          });
        } catch (e) { sendFailures.push({ index: mf.index, type: mf.type, error: errMsg(e) }); log('error','whatsapp-send-media-failed',{requestId,jobId,tweetId,index:mf.index,error:errMsg(e)}); }
      }
    }
    // Merge extraction failures (from the service worker) with send
    // failures. Never report full success unless every intended
    // message was sent.
    const failures = [].concat(extractionFailures(body), sendFailures);
    const partial = failures.length > 0 && sent.length > 0;
    const ok = failures.length === 0 && sent.length > 0;
    duplicateLog.set(key, { ts: now, status: ok ? 'completed' : (partial ? 'partial' : 'failed'), jobId });
    jobs.set(jobId, { status: ok ? 'completed' : (partial ? 'partial' : 'failed'), sent, failures });
    cleanup(jobDir);
    log('info','send-job-complete',{requestId,jobId,status: ok ? 'completed' : (partial ? 'partial' : 'failed'),sent:sent.length,failed:failures.length});
    if (ok) return { ok: true, jobId, sent, ...(translationMeta ? { translation: translationMeta } : {}) };
    if (partial) return { ok: false, jobId, sent, partial: true, failures, error: 'partial-send', ...(translationMeta ? { translation: translationMeta } : {}) };
    return { ok: false, jobId, error: failures.length ? failures[failures.length - 1].error : 'send-failed', ...(failures.length ? { failures } : {}) };
  } catch (e) {
    try{ log('error','send-job-error',{requestId,jobId,message:e&&e.message,stack:e&&e.stack}); }catch{}
    duplicateLog.set(key, { ts: now, status: 'failed', jobId });
    jobs.set(jobId, { status: 'failed', error: e.message || String(e) });
    cleanup(jobDir);
    return { ok: false, error: e.message, jobId };
  }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); log('info','cleanup',{dir}); } catch(e) { log('warn','cleanup-error',{dir,error:e&&e.message}); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, state });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      // state reflects the real WhatsApp connection, not just that this
      // HTTP server is answering.
      const hasGroq = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
      const curModel = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
      const modelName = formatGroqModelDisplayName(curModel);
      return json(res, 200, {
        state,
        me: waInfo ? waInfo.wid : null,
        sessionDir: SESSION_DIR,
        authRequired: state === 'auth_required' || state === 'qr',
        reconnecting: state === 'reconnecting',
        jobs: Array.from(jobs.entries()).slice(-20),
        activeEngine: hasGroq ? 'groq' : 'google',
        activeEngineLabel: hasGroq ? `${modelName} (Groq)` : 'Google Translate (Fallback)',
        lastTranslation: lastTranslationInfo,
      });
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      // Local facts only, so opening the popup never waits on the network.
      return json(res, 200, await repo.status());
    }
    if (req.method === 'POST' && url.pathname === '/version/check') {
      const r = await repo.check();
      log('info', 'version-check', { ok: r.ok, behind: r.behind, checkFailed: r.checkFailed });
      return json(res, r.ok ? 200 : 500, r);
    }
    if (req.method === 'POST' && (url.pathname === '/update' || url.pathname === '/pull')) {
      const r = await repo.update();
      log(r.ok ? 'info' : 'warn', 'update', {
        ok: r.ok, error: r.error, from: r.from, to: r.to, files: r.files,
      });
      if (r.ok && r.restartController) {
        // Answer first, then restart: the controller restarting is the whole
        // point, so it happens once this response is on its way. Best
        // effort - someone running it by hand has no unit to restart.
        setTimeout(() => {
          try {
            const { spawn } = require('child_process');
            spawn('systemctl', ['--user', 'restart', 'x2wa-controller'], { detached: true, stdio: 'ignore' }).unref();
          } catch (e) { log('warn', 'restart-failed', { error: String((e && e.message) || e) }); }
        }, 1500);
      }
      return json(res, r.ok ? 200 : 409, r);
    }
    if (req.method === 'POST' && url.pathname === '/push') {
      const r = await repo.push();
      log(r.ok ? 'info' : 'warn', 'push', {
        ok: r.ok, error: r.error, branch: r.branch, sha: r.sha,
      });
      return json(res, r.ok ? 200 : 409, r);
    }
    if (req.method === 'POST' && url.pathname === '/sync') {
      const r = await repo.sync();
      log(r.ok ? 'info' : 'warn', 'sync', {
        ok: r.ok, error: r.error, pulled: r.pulled, pushed: r.pushed, from: r.from, to: r.to, files: r.files,
      });
      if (r.ok && r.restartController) {
        setTimeout(() => {
          try {
            const { spawn } = require('child_process');
            spawn('systemctl', ['--user', 'restart', 'x2wa-controller'], { detached: true, stdio: 'ignore' }).unref();
          } catch (e) { log('warn', 'restart-failed', { error: String((e && e.message) || e) }); }
        }, 1500);
      }
      return json(res, r.ok ? 200 : 409, r);
    }
    if (req.method === 'GET' && url.pathname === '/auth/qr') {
      // The QR payload is deliberately short-lived and only ever served to
      // a local requester; it is never logged or persisted.
      if (state !== 'qr' || !lastQr) { return json(res, 404, { error: 'no-qr-available', state }); }
      // `image` is a self-contained data URL: a self-contained URL keeps the
      // QR payload off the network and out of any log.
      return json(res, 200, { image: qrImageSvg(lastQr), issuedAt: qrIssuedAt });
    }
    if (req.method === 'POST' && (url.pathname === '/auth/start' || url.pathname === '/auth/reconnect')) {
      // Idempotent: reconnect, or start pairing if there is nothing to
      // reconnect to. Lets the popup recover without a service restart.
      const body = await readBody(req).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      if (state === 'ready' && !body.force) return json(res, 200, { ok: true, state, alreadyRunning: true });
      if (!client) {
        startClient('popup-request');
      } else if (body.force || state !== 'ready') {
        log('info', 'auth-restart-requested', { state, force: Boolean(body.force), elapsedMs: Date.now() - stateEnteredAt });
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        restartPending = false;
        markConnectionStale('user-restart:' + state);
      }
      return json(res, 200, { ok: true, state });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const body = await readBody(req).then((b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } });
      if (body.confirm !== true) { return json(res, 400, { error: 'confirmation-required' }); }
      try { return json(res, 200, await logout('user-request')); }
      catch (e) { return json(res, 500, { error: 'logout-failed' }); }
    }
    if (req.method === 'GET' && url.pathname === '/channels') {
      if (state !== 'ready' || !client) { return json(res, 409, { error: 'whatsapp-not-ready', state }); }
      // The popup polls while open; re-querying every channel's membership
      // each time would hammer WhatsApp Web for no new information.
      if (channelCache && Date.now() - channelCache.at < CHANNEL_CACHE_MS) {
        return json(res, 200, channelCache.body);
      }
      try {
        // Only channels this account can actually post to.
        const r = await listPostableChannels(client);
        channelCache = {
          at: Date.now(),
          body: {
            channels: r.channels,
            checked: r.checked,
            ineligible: r.ineligible,
            warning: r.degraded ? 'Some channels could not be verified for posting permission and are hidden.' : undefined,
          },
        };
        lastChannelError = r.degraded ? 'permission-check-failed' : null;
        return json(res, 200, {
          channels: r.channels,
          checked: r.checked,
          ineligible: r.ineligible,
          warning: r.degraded ? 'Some channels could not be verified for posting permission and are hidden.' : undefined,
        });
      } catch (e) {
        log('warn','channel-list-failed',{error:String((e && e.message) || e)});
        // The listing talks to the live WhatsApp Web page, so a failure here
        // means that page is unusable (common right after a resume).
        markConnectionStale('channel-list-failed');
        return json(res, 500, { error: 'channel-list-failed' });
      }
    }
    // Compare translations across multiple models (pure translation analysis)
    if (req.method === 'POST' && url.pathname === '/translate/compare') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        log('error', 'translate-compare-bad-json', {});
        return json(res, 400, { ok: false, error: 'bad-json' });
      }
      if (!body || typeof body.text !== 'string' || !body.text.trim()) {
        log('error', 'translate-compare-bad-request', {});
        return json(res, 400, { ok: false, error: 'missing-text' });
      }
      try {
        log('info', 'translate-compare-start', { charsIn: body.text.length, models: body.models || 'default' });
        const comparison = await compareTranslations(body.text, {
          author: body.author,
          models: body.models,
          pure: body.pure !== false,
          temperature: body.temperature,
        }, { log });
        log('info', 'translate-compare-done', {
          charsIn: body.text.length,
          modelCount: comparison.results.length,
          successCount: comparison.results.filter((r) => r.ok).length,
        });
        return json(res, 200, comparison);
      } catch (e) {
        log('warn', 'translate-compare-failed', { error: errMsg(e) });
        return json(res, 502, { ok: false, error: 'translate-compare-failed' });
      }
    }
    // Translate a short standalone string - the author's name that heads an
    // Urdu post. The post itself is translated through /send's translateTo;
    // this is for the small pieces that are translated on their own. It does
    // not touch WhatsApp, so it is available whenever the controller is.
    if (req.method === 'POST' && url.pathname === '/translate') {
      const body = JSON.parse(await readBody(req));
      const request = readTranslateRequest(body);
      if (!request.ok) { log('error','translate-rejected-bad-request',{}); return json(res, 400, { error: request.error }); }
      try {
        let out, provider, model;
        if (request.mode === 'translate' || isGroqConfigured()) {
          const res = await translateTextWithMeta(request.text, request.to, {
            log,
            model: body.model,
            pure: body.pure !== false,
            author: body.author,
          });
          out = res.text;
          provider = res.provider;
          model = res.model;
          lastTranslationInfo = {
            provider,
            model,
            target: request.to,
            ts: Date.now(),
          };
        } else {
          out = await transliterateText(request.text, request.to, { log });
          provider = 'inputtools';
          model = null;
        }
        log('info','translate-http',{to:request.to,charsIn:request.text.length,charsOut:out.length,mode:request.mode||(provider==='groq'?'translate':'transliterate'),provider,model});
        return json(res, 200, { ok: true, text: out, to: request.to, provider, model });
      } catch (e) {
        log('warn','translate-http-failed',{to:request.to,error:errMsg(e)});
        return json(res, 502, { ok: false, error: 'translate-failed' });
      }
    }
    // Read Groq API translation configuration status
    if (req.method === 'GET' && url.pathname === '/groq/config') {
      const apiKey = process.env.GROQ_API_KEY || '';
      const configured = typeof apiKey === 'string' && apiKey.trim().length > 0;
      const model = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
      const modelName = formatGroqModelDisplayName(model);
      const maskedKey = configured
        ? (apiKey.length > 8 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '••••••••')
        : '';
      return json(res, 200, {
        ok: true,
        configured,
        model,
        modelName,
        availableModels: GROQ_SUPPORTED_MODELS,
        activeEngine: configured ? 'groq' : 'google',
        activeEngineLabel: configured ? `${modelName} (Groq)` : 'Google Translate (Fallback)',
        lastTranslation: lastTranslationInfo,
        maskedKey,
        hasKey: configured,
      });
    }
    // Set or clear Groq API translation configuration and persist to .env
    if (req.method === 'POST' && url.pathname === '/groq/config') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, error: 'bad-request' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'bad-request' });
      }
      if (body.apiKey !== undefined) {
        const key = String(body.apiKey).trim();
        if (key.length > 0) {
          process.env.GROQ_API_KEY = key;
          persistEnvKey('GROQ_API_KEY', key);
        } else {
          delete process.env.GROQ_API_KEY;
          persistEnvKey('GROQ_API_KEY', '');
        }
      }
      if (body.model !== undefined) {
        const model = String(body.model).trim();
        if (model.length > 0) {
          process.env.GROQ_MODEL = model;
          persistEnvKey('GROQ_MODEL', model);
        }
      }
      const isConfigured = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
      const curModel = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
      const modelName = formatGroqModelDisplayName(curModel);
      log('info', 'groq-config-updated', { configured: isConfigured, model: curModel });
      return json(res, 200, {
        ok: true,
        configured: isConfigured,
        model: curModel,
        modelName,
        availableModels: GROQ_SUPPORTED_MODELS,
        activeEngine: isConfigured ? 'groq' : 'google',
        activeEngineLabel: isConfigured ? `${modelName} (Groq)` : 'Google Translate (Fallback)',
      });
    }
    // Phonetic transliteration for author names into Urdu script.
    // Consults local JSON overrides first, then Google Input Tools, and safely
    // falls back to the original name if the engine fails. Never semantically translates.
    if (req.method === 'POST' && url.pathname === '/transliterate') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, error: 'bad-request' }); }
      if (!body || typeof body !== 'object' || typeof body.text !== 'string') {
        return json(res, 400, { ok: false, error: 'bad-request' });
      }
      if (body.text.length > MAX_NAME_CHARS) {
        return json(res, 400, { ok: false, error: 'name-too-long' });
      }
      try {
        if (isGroqConfigured()) {
          const dual = await formatAuthorNameDual(body.text);
          if (dual) {
            log('info', 'transliterate-groq-dual', { original: body.text, dual });
            return json(res, 200, {
              ok: true,
              text: dual,
              source: 'groq',
              original: body.text,
              handle: body.handle || null,
            });
          }
        }
        const result = await resolveTransliteration(body.text, body.handle);
        log('info', 'transliterate-http', {
          source: result.source,
          charsIn: body.text.length,
          charsOut: result.text.length,
        });
        if (result && result.text && result.source !== 'empty') {
          const formatted = (result.text && body.text && result.text.toLowerCase() !== body.text.toLowerCase())
            ? formatDualAuthorForUrdu(`${result.text} | ${body.text}`)
            : formatDualAuthorForUrdu(result.text);
          return json(res, 200, { ...result, text: formatted });
        }
        return json(res, 200, result);
      } catch (e) {
        log('warn', 'transliterate-http-failed', { error: errMsg(e) });
        return json(res, 200, {
          ok: true,
          text: body.text,
          source: 'fallback',
          original: body.text,
          error: 'transliterate-failed',
        });
      }
    }
    // Read the persistent JSON overrides dictionary.
    if (req.method === 'GET' && (url.pathname === '/overrides' || url.pathname === '/transliterate/overrides')) {
      const data = overridesStore.getAll();
      return json(res, 200, { ok: true, version: data.version || 1, overrides: data.overrides || {} });
    }
    // Save or update an approved/corrected transliteration in the dictionary.
    if (req.method === 'POST' && (url.pathname === '/overrides' || url.pathname === '/transliterate/override')) {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, error: 'bad-request' }); }
      if (!body || typeof body !== 'object' || typeof body.original !== 'string' || typeof body.transliteration !== 'string') {
        return json(res, 400, { ok: false, error: 'bad-request' });
      }
      if (body.original.length > MAX_NAME_CHARS || body.transliteration.length > MAX_NAME_CHARS) {
        return json(res, 400, { ok: false, error: 'value-too-long' });
      }
      try {
        const entry = await overridesStore.setOverride(body);
        log('info', 'override-saved', { key: entry.key, original: entry.original });
        return json(res, 200, { ok: true, entry });
      } catch (e) {
        log('warn', 'override-save-failed', { error: errMsg(e) });
        return json(res, 500, { ok: false, error: (e && e.message) || 'save-failed' });
      }
    }
    // Delete an override from the dictionary.
    if (req.method === 'DELETE' && (url.pathname === '/overrides' || url.pathname === '/transliterate/override')) {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw && raw.trim()) body = JSON.parse(raw);
      } catch {}
      const key = body.key || url.searchParams.get('key');
      const original = body.original || url.searchParams.get('original');
      const handle = body.handle || url.searchParams.get('handle');
      if (!key && !original && !handle) {
        return json(res, 400, { ok: false, error: 'missing-identifier' });
      }
      try {
        const r = await overridesStore.deleteOverride({ key, original, handle });
        log('info', 'override-deleted', { key, original, handle, removed: r.removed });
        return json(res, 200, { ok: true, removed: r.removed });
      } catch (e) {
        log('warn', 'override-delete-failed', { error: errMsg(e) });
        return json(res, 500, { ok: false, error: 'delete-failed' });
      }
    }
    // --- Author Name Correction Manager Endpoints ---
    if (req.method === 'GET' && (url.pathname === '/author-corrections' || url.pathname === '/transliterate/corrections')) {
      const corrections = typeof overridesStore.listCorrections === 'function' ? overridesStore.listCorrections() : [];
      return json(res, 200, { ok: true, corrections });
    }
    if (req.method === 'POST' && (url.pathname === '/author-corrections' || url.pathname === '/transliterate/corrections')) {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { ok: false, error: 'bad-request' }); }
      if (!body || typeof body !== 'object') {
        return json(res, 400, { ok: false, error: 'bad-request' });
      }
      const handle = body.handle || body.username || body.authorHandle;
      const urduName = body.urduName || body.transliteration || body.urdu;
      const originalName = body.originalName || body.original || body.author || '';
      if (!handle || typeof handle !== 'string' || !handle.trim()) {
        return json(res, 400, { ok: false, error: 'missing-handle' });
      }
      if (!urduName || typeof urduName !== 'string' || !urduName.trim()) {
        return json(res, 400, { ok: false, error: 'missing-urdu-name' });
      }
      if (urduName.length > MAX_NAME_CHARS) {
        return json(res, 400, { ok: false, error: 'value-too-long' });
      }
      try {
        const entry = await overridesStore.setCorrection({ handle, urduName, originalName });
        log('info', 'author-correction-saved', { handle: entry.handle, urduName: entry.transliteration });
        return json(res, 200, { ok: true, entry });
      } catch (e) {
        log('warn', 'author-correction-save-failed', { error: errMsg(e) });
        return json(res, 500, { ok: false, error: (e && e.message) || 'save-failed' });
      }
    }
    if (req.method === 'DELETE' && (url.pathname === '/author-corrections' || url.pathname === '/transliterate/corrections')) {
      let body = {};
      try {
        const raw = await readBody(req);
        if (raw && raw.trim()) body = JSON.parse(raw);
      } catch {}
      const handle = body.handle || body.username || url.searchParams.get('handle') || url.searchParams.get('username');
      if (!handle) {
        return json(res, 400, { ok: false, error: 'missing-handle' });
      }
      try {
        const r = await overridesStore.deleteCorrection(handle);
        log('info', 'author-correction-deleted', { handle, removed: r.removed });
        return json(res, 200, { ok: true, removed: r.removed });
      } catch (e) {
        log('warn', 'author-correction-delete-failed', { error: errMsg(e) });
        return json(res, 500, { ok: false, error: 'delete-failed' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      if (state !== 'ready') { log('error','send-rejected-whatsapp-not-ready',{state}); return json(res, 409, { error: 'whatsapp-not-ready', state }); }
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body !== 'object' || !body.tweetId || !body.tweetUrl || !body.channelId || typeof body.text !== 'string' || !Array.isArray(body.media)) {
        log('error','send-rejected-bad-request',{hasTweetId:!!(body&&body.tweetId)});
        return json(res, 400, { error: 'bad-request' });
      }
      // An optional target language for the text; a short code, nothing else,
      // so a stray value can never reshape the translate request.
      if (body.translateTo != null && (typeof body.translateTo !== 'string' || body.translateTo.length === 0 || body.translateTo.length > 8)) {
        log('error','send-rejected-bad-request',{badField:'translateTo'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.author != null && (typeof body.author !== 'string' || body.author.length > 200)) {
        log('error','send-rejected-bad-request',{badField:'author'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.authorHandle != null && (typeof body.authorHandle !== 'string' || body.authorHandle.length > 100)) {
        log('error','send-rejected-bad-request',{badField:'authorHandle'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.signature != null && (typeof body.signature !== 'string' || body.signature.length > 2000)) {
        log('error','send-rejected-bad-request',{badField:'signature'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.signatureUrdu != null && (typeof body.signatureUrdu !== 'string' || body.signatureUrdu.length > 2000)) {
        log('error','send-rejected-bad-request',{badField:'signatureUrdu'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.signaturePlacement != null && body.signaturePlacement !== 'top' && body.signaturePlacement !== 'bottom') {
        log('error','send-rejected-bad-request',{badField:'signaturePlacement'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.signatureAlign != null && body.signatureAlign !== 'center' && body.signatureAlign !== 'left' && body.signatureAlign !== 'right') {
        log('error','send-rejected-bad-request',{badField:'signatureAlign'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.signatureIndent != null && (typeof body.signatureIndent !== 'number' || isNaN(body.signatureIndent) || body.signatureIndent < 0 || body.signatureIndent > 150)) {
        log('error','send-rejected-bad-request',{badField:'signatureIndent'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.channelLink != null && (typeof body.channelLink !== 'string' || body.channelLink.length > 500)) {
        log('error','send-rejected-bad-request',{badField:'channelLink'});
        return json(res, 400, { error: 'bad-request' });
      }
      if (body.channelLinkPos != null && body.channelLinkPos !== 'top' && body.channelLinkPos !== 'bottom') {
        log('error','send-rejected-bad-request',{badField:'channelLinkPos'});
        return json(res, 400, { error: 'bad-request' });
      }
      log('info','send-request-validated',{requestId:body.requestId,tweetId:body.tweetId,mediaTypes:body.media.map(m=>m.type)});
      const result = await sendJob(body); log('info','send-response',{requestId:body.requestId,jobId:result.jobId,ok:result.ok,status:result.error||'ok'}); return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/direct/send') {
      if (state !== 'ready' || !client) {
        return json(res, 409, { error: 'whatsapp-not-ready', state });
      }
      const body = JSON.parse(await readBody(req));
      let { to, text } = body || {};
      if (!to || !text) return json(res, 400, { error: 'missing-to-or-text' });
      to = String(to).replace(/[^0-9]/g, '');
      if (!to) return json(res, 400, { error: 'invalid-to' });
      const jid = `${to}@c.us`;
      try {
        const m = await client.sendMessage(jid, text);
        return json(res, 200, { ok: true, id: m && m.id });
      } catch (e) {
        log('error', 'direct-send-failed', { to, error: errMsg(e) });
        return json(res, 500, { ok: false, error: errMsg(e) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/direct/messages') {
      if (state !== 'ready' || !client) {
        return json(res, 409, { error: 'whatsapp-not-ready', state });
      }
      let to = url.searchParams.get('to');
      let jid = to ? `${String(to).replace(/[^0-9]/g, '')}@c.us` : null;
      let limit = parseInt(url.searchParams.get('limit') || '15', 10);
      try {
        if (jid && typeof client.getChatById === 'function') {
          const chat = await client.getChatById(jid);
          if (chat && typeof chat.fetchMessages === 'function') {
            const raw = await chat.fetchMessages({ limit });
            const list = raw.map(m => ({
              id: m.id ? m.id._serialized : null,
              from: m.from,
              to: m.to,
              fromMe: Boolean(m.fromMe),
              body: m.body,
              timestamp: m.timestamp,
              type: m.type
            }));
            return json(res, 200, { ok: true, messages: list });
          }
        }
      } catch (e) {
        log('warn', 'fetch-messages-failed', { error: errMsg(e) });
      }
      const filtered = jid ? recentMessages.filter(m => m.from === jid || (m.from && m.from.includes(to))) : recentMessages;
      return json(res, 200, { ok: true, messages: filtered });
    }
    if (req.method === 'GET' && url.pathname === '/direct/download-media') {
      if (state !== 'ready' || !client) {
        return json(res, 409, { error: 'whatsapp-not-ready', state });
      }
      let msgId = url.searchParams.get('msgId');
      let to = url.searchParams.get('to') || '923006900001';
      let jid = `${String(to).replace(/[^0-9]/g, '')}@c.us`;
      try {
        const chat = await client.getChatById(jid);
        const msgs = await chat.fetchMessages({ limit: 15 });
        const target = msgs.find(m => (m.id && m.id._serialized === msgId) || (!msgId && m.hasMedia));
        if (target && target.hasMedia && typeof target.downloadMedia === 'function') {
          const media = await target.downloadMedia();
          return json(res, 200, { ok: true, media });
        }
        return json(res, 404, { error: 'media-not-found' });
      } catch (e) {
        return json(res, 500, { error: errMsg(e) });
      }
    }
    json(res, 404, { error: 'unknown' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); }); }

log('info','controller-start',{host:HOST,port:PORT,sessionDir:SESSION_DIR,node:process.version});
server.listen(PORT, HOST, () => log('info','listening',{host:HOST,port:PORT}));
