// X → WhatsApp Channel Poster — production local controller
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode-generator');
const { sessionDir, tmpRoot, acquireSessionLock, findChromeExecutable } = require('./platform');
const { listPostableChannels, canPostToChannel } = require('./channels');
const { createHeartbeat } = require('./heartbeat');
const repo = require('./repo');
const { decodeInlineImage, isInlineImage, MAX_INLINE_BYTES } = require('./inline-media');
const videoPipeline = require('./video-pipeline');
const hlsPrefetch = require('./hls-prefetch');
const duplicate = require('./duplicate-guard');
const { translateText } = require('./translate');

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
let lastQr = null;
let qrIssuedAt = 0;
let waInfo = null;
let lastError = null;
let lastChannelError = null;
let channelCache = null;
const CHANNEL_CACHE_MS = 30000;
const jobs = new Map();
let currentJob = null;
// True while a send is in progress, so the watchdog leaves it alone.
let jobRunning = false;
const duplicateLog = new Map();

function log(level,event,data){ const rec={ts:new Date().toISOString(),level,component:'controller',event,...(data||{})}; try{ console.log(JSON.stringify(rec)); }catch{ console.log(`${level} ${event}`); } }

// The dedicated WhatsApp account. LocalAuth keeps the session in
// SESSION_DIR so the next start reconnects without another QR scan.
function makeClient() {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: { headless: true, executablePath: findChromeExecutable(), args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });
}

let client = null;

function startClient(reason) {
  if (client) return;
  state = state === 'ready' ? state : 'starting';
  log('info','client-start',{ reason, sessionDir: SESSION_DIR });
  client = makeClient();
  client.on('qr', (qr) => {
    state = 'qr'; lastQr = qr; qrIssuedAt = Date.now();
    log('info','qr-state',{status:'waiting-for-user'});
    // Printed for a user working in a terminal; never written to a log file.
    try { qrcode.generate(qr, { small: true }); } catch {}
  });
  client.on('authenticated', () => { state = 'authenticated'; log('info','authenticated'); });
  client.on('auth_failure', (m) => { state = 'auth_failure'; log('error','auth-failure',{error:String(m)}); });
  // A clean disconnect also rebuilds the client from the saved session.
  client.on('ready', () => {
    state = 'ready'; waInfo = client.info; lastQr = null; channelCache = null;
    restartAttempts = 0; restartPending = false; beat.reset();
    log('info','ready',{me: waInfo && waInfo.wid && waInfo.wid._serialized});
  });
  client.on('disconnected', (r) => {
    log('warn','disconnected',{reason:String(r)});
    markConnectionStale('disconnected');
  });
  client.initialize().catch((e) => {
    log('error','init-error',{error:e && e.message});
    if (e && e.message && e.message.includes('already running')) {
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
    state = 'auth_required';
    log('info','logout-noop',{reason});
    startClient('after-logout');
    return { ok: true, alreadyStopped: true };
  }
  const c = client;
  client = null; lastQr = null; waInfo = null; channelCache = null; state = 'stopped';
  try { await c.logout(); } catch (e) { log('warn','logout-error',{error:String((e && e.message) || e)}); }
  try { await c.destroy(); } catch (e) { log('warn','destroy-error',{error:String((e && e.message) || e)}); }
  log('info','logged-out',{reason});
  state = 'auth_required';
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
  if (!c) return;
  let proc = null;
  try {
    const b = c.pupBrowser;
    proc = b && typeof b.process === 'function' ? b.process() : null;
  } catch { /* nothing to wait on */ }
  // Arm the waiter first: destroy() may be what makes the process exit.
  let exited = null;
  if (proc && proc.exitCode === null && !proc.killed) {
    exited = new Promise((resolve) => {
      const timer = setTimeout(resolve, BROWSER_EXIT_WAIT_MS);
      if (timer.unref) timer.unref();
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  try { await c.destroy(); }
  catch (e) { log('warn', 'destroy-error', { error: String((e && e.message) || e) }); }
  if (exited) {
    await exited;
    log('info', 'browser-stopped', { waited: true, exitCode: proc.exitCode });
  }
  if (proc && proc.exitCode === null && !proc.killed) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${proc.pid} /t /f`, { stdio: 'ignore' });
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
}

function killOrphanedSessionBrowsers() {
  if (process.platform === 'win32') {
    try {
      const escaped = SESSION_DIR.replace(/'/g, "''");
      execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" -ErrorAction SilentlyContinue | Where-Object { \\$_.CommandLine -and \\$_.CommandLine -like '*${escaped}*' } | ForEach-Object { Stop-Process -Id \\$_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { stdio: 'ignore', timeout: 5000 });
    } catch {}
  }
}

function markConnectionStale(reason) {
  if (restartPending) return;
  restartPending = true;
  restartAttempts += 1;
  const delay = restartBackoffMs(restartAttempts);
  // Report the truth while we rebuild, instead of claiming "ready".
  state = 'reconnecting';
  log('warn', 'connection-stale', { reason, attempt: restartAttempts, retryInMs: delay });
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    const stale = client;
    client = null;
    lastQr = null; waInfo = null; channelCache = null;
    await stopClient(stale);
    restartPending = false;
    startClient('recover:' + reason);
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
    state = 'stopped';
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

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); }

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
    if (body.translateTo) {
      const target = String(body.translateTo);
      const t0 = Date.now();
      log('info','translate-start',{requestId,jobId,channelId,target,chars:text.length});
      try {
        outText = await translateText(text, target);
        log('info','translate-done',{requestId,jobId,target,charsIn:text.length,charsOut:outText.length,ms:Date.now()-t0});
      } catch (e) {
        duplicateLog.set(key, { ts: now, status: 'failed', jobId });
        jobs.set(jobId, { status: 'failed', error: 'translate-failed' });
        cleanup(jobDir);
        log('warn','translate-failed',{requestId,jobId,target,error:errMsg(e)});
        return { ok: false, error: 'translate-failed', jobId, retryable: true };
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
    if (ok) return { ok: true, jobId, sent };
    if (partial) return { ok: false, jobId, sent, partial: true, failures, error: 'partial-send' };
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
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, state });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      // state reflects the real WhatsApp connection, not just that this
      // HTTP server is answering.
      return json(res, 200, {
        state,
        me: waInfo ? waInfo.wid : null,
        sessionDir: SESSION_DIR,
        authRequired: state === 'auth_required' || state === 'qr',
        reconnecting: state === 'reconnecting',
        jobs: Array.from(jobs.entries()).slice(-20),
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
    if (req.method === 'POST' && url.pathname === '/update') {
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
    if (req.method === 'GET' && url.pathname === '/auth/qr') {
      // The QR payload is deliberately short-lived and only ever served to
      // a local requester; it is never logged or persisted.
      if (state !== 'qr' || !lastQr) { return json(res, 404, { error: 'no-qr-available', state }); }
      // `image` is a self-contained data URL: a self-contained URL keeps the
      // QR payload off the network and out of any log.
      return json(res, 200, { image: qrImageSvg(lastQr), issuedAt: qrIssuedAt });
    }
    if (req.method === 'POST' && url.pathname === '/auth/start') {
      // Idempotent: reconnect, or start pairing if there is nothing to
      // reconnect to. Lets the popup recover without a service restart.
      if (state === 'ready') return json(res, 200, { ok: true, state, alreadyRunning: true });
      if (!client) startClient('popup-request');
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
      log('info','send-request-validated',{requestId:body.requestId,tweetId:body.tweetId,mediaTypes:body.media.map(m=>m.type)});
      const result = await sendJob(body); log('info','send-response',{requestId:body.requestId,jobId:result.jobId,ok:result.ok,status:result.error||'ok'}); return json(res, 200, result);
    }
    json(res, 404, { error: 'unknown' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); }); }

log('info','controller-start',{host:HOST,port:PORT,sessionDir:SESSION_DIR,node:process.version});
server.listen(PORT, HOST, () => log('info','listening',{host:HOST,port:PORT}));
