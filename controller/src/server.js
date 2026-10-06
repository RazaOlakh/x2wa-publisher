// X → WhatsApp Channel Poster — production local controller
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.CONTROLLER_PORT || '47825', 10);
const SESSION_DIR = process.env.SESSION_DIR || path.join(os.homedir(), '.local', 'share', 'x-whatsapp-poster', 'whatsapp-session');
const TMP_ROOT = path.join(os.homedir(), '.local', 'share', 'x-whatsapp-poster', 'tmp');
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(TMP_ROOT, { recursive: true });

let state = 'starting';
let lastQr = null;
let waInfo = null;
const jobs = new Map();
const duplicateLog = new Map();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: { headless: true, executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

client.on('qr', (qr) => { state = 'qr'; lastQr = qr; console.log('\nScan QR now with dedicated number:'); qrcode.generate(qr, { small: true }); });
client.on('authenticated', () => { state = 'authenticated'; console.log('authenticated'); });
client.on('auth_failure', (m) => { state = 'auth_failure'; console.log('AUTH FAILURE', m); });
client.on('ready', () => { state = 'ready'; waInfo = client.info; console.log('READY', waInfo && waInfo.wid); });
client.on('disconnected', (r) => { state = 'disconnected'; console.log('disconnected:', r); });
client.initialize().catch((e) => { console.error('init error', e); process.exit(1); });

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 1)); }
function newJob() { return crypto.randomBytes(8).toString('hex'); }

function validMedia(m) {
  return m && ['image', 'video'].includes(m.type) && typeof m.source === 'string' && m.source.length > 0 && m.source.length < 4096;
}

async function download(source, dest, timeoutMs) {
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
        r.on('data', (c) => { total += c.length; if (total > MAX_MEDIA_BYTES) { req.destroy(); file.close(); fs.rmSync(dest, { force: true }); reject(new Error('media-too-large')); } });
        r.pipe(file);
        file.on('finish', () => { if (fs.statSync(dest).size > MAX_MEDIA_BYTES) { fs.rmSync(dest, { force: true }); reject(new Error('media-too-large')); } resolve(); });
      });
      req.on('error', (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
      req.setTimeout(timeoutMs, () => { req.destroy(); file.close(); fs.rmSync(dest, { force: true }); reject(new Error('download-timeout')); });
    } catch (e) { reject(e); }
  });
}

function ffprobeOk(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(false);
      try {
        const j = JSON.parse(stdout);
        const hasVideo = j.streams && j.streams.some((s) => s.codec_type === 'video');
        resolve(Boolean(hasVideo));
      } catch { resolve(false); }
    });
  });
}

function ffmpegMux(input, output) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', output];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg-timeout')); }, FFMPEG_TIMEOUT_MS);
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error('ffmpeg-failed'));
    });
    p.on('error', reject);
  });
}

async function processMedia(item, jobDir) {
  if (item.type === 'video') {
    const out = path.join(jobDir, 'out.mp4');
    if (/^https?:\/\//i.test(item.source)) {
      // For HLS-style sources we feed the URL directly to ffmpeg rather than trying to
      // download it as a static object.
      if (/\.m3u8(\?|$)/i.test(item.source)) {
        await ffmpegMux(item.source, out);
      } else {
        const file = path.join(jobDir, 'input.bin');
        await download(item.source, file, DOWNLOAD_TIMEOUT_MS);
        const stat = fs.statSync(file);
        if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
        await ffmpegMux(file, out);
      }
    } else if (fs.existsSync(item.source)) {
      const stat = fs.statSync(item.source);
      if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
      await ffmpegMux(item.source, out);
    } else {
      throw new Error('media-source-invalid');
    }
    if (!(await ffprobeOk(out))) throw new Error('ffprobe-validation-failed');
    return out;
  }

  const file = path.join(jobDir, crypto.randomBytes(6).toString('hex') + '.bin');
  if (/^https?:\/\//i.test(item.source)) {
    await download(item.source, file, DOWNLOAD_TIMEOUT_MS);
  } else if (fs.existsSync(item.source)) {
    fs.copyFileSync(item.source, file);
  } else {
    throw new Error('media-source-invalid');
  }
  const stat = fs.statSync(file);
  if (stat.size > MAX_MEDIA_BYTES) throw new Error('media-too-large');
  return file;
}

async function sendJob(body) {
  const { tweetId, tweetUrl, text, media, channelId } = body;
  const key = `${tweetId}|${channelId}`;
  const now = Date.now();
  const prev = duplicateLog.get(key);
  if (prev && now - prev.ts < 120000 && prev.status !== 'failed') {
    return { ok: false, error: 'duplicate-send', prior: prev };
  }
  const jobId = newJob();
  duplicateLog.set(key, { ts: now, status: 'pending', jobId });
  const jobDir = path.join(TMP_ROOT, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  jobs.set(jobId, { status: 'started' });

  try {
    if (state !== 'ready') { jobs.set(jobId, { status: 'failed', error: 'whatsapp-not-ready' }); cleanup(jobDir); return { ok: false, error: 'whatsapp-not-ready', jobId }; }
    const mediaFiles = [];
    if (Array.isArray(media) && media.length > 0) {
      for (const m of media) {
        if (!validMedia(m)) { jobs.set(jobId, { status: 'failed', error: 'bad-media' }); cleanup(jobDir); return { ok: false, error: 'bad-media', jobId }; }
        try { const f = await processMedia(m, jobDir); mediaFiles.push({ type: m.type, file: f }); }
        catch (e) { jobs.set(jobId, { status: 'failed', error: e.message }); cleanup(jobDir); return { ok: false, error: e.message, jobId }; }
      }
    }

    const sent = [];
    if (mediaFiles.length === 0) {
      const m = await client.sendMessage(channelId, text);
      sent.push({ type: 'text', id: m && m.id });
    } else {
      const first = mediaFiles[0];
      const msg = first.type === 'image'
        ? MessageMedia.fromFilePath(first.file)
        : MessageMedia.fromFilePath(first.file);
      const m = await client.sendMessage(channelId, msg, { caption: text || undefined });
      sent.push({ type: first.type, id: m && m.id });
      for (let i = 1; i < mediaFiles.length; i++) {
        const mm = MessageMedia.fromFilePath(mediaFiles[i].file);
        const r = await client.sendMessage(channelId, mm);
        sent.push({ type: mediaFiles[i].type, id: r && r.id });
      }
    }
    duplicateLog.set(key, { ts: now, status: 'completed', jobId });
    jobs.set(jobId, { status: 'completed', sent });
    cleanup(jobDir);
    return { ok: true, jobId, sent };
  } catch (e) {
    try{ console.log('sendJob error:', e && e.message, e && e.stack); }catch{}
    duplicateLog.set(key, { ts: now, status: 'failed', jobId });
    jobs.set(jobId, { status: 'failed', error: e.message || String(e) });
    cleanup(jobDir);
    return { ok: false, error: e.message, jobId };
  }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, state });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { state, me: waInfo ? waInfo.wid : null, jobs: Array.from(jobs.entries()).slice(-20) });
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      if (state !== 'ready') return json(res, 409, { error: 'whatsapp-not-ready', state });
      const body = JSON.parse(await readBody(req));
      if (!body || typeof body !== 'object' || !body.tweetId || !body.tweetUrl || !body.channelId || typeof body.text !== 'string' || !Array.isArray(body.media)) {
        return json(res, 400, { error: 'bad-request' });
      }
      return json(res, 200, await sendJob(body));
    }
    json(res, 404, { error: 'unknown' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); }); }

server.listen(PORT, HOST, () => console.log(`controller on http://${HOST}:${PORT}`));
