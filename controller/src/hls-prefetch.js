// Fetching an X HLS video's segments in parallel, then handing ffmpeg local
// files to remux.
//
// Measured on this project's own sources: ffmpeg spends ~1s of CPU and ~40-70s
// of wall clock on a 5-minute video, because its HLS demuxer pulls segments
// one at a time and each one waits a round trip. The bottleneck was the
// network, not the encoding - so encoding was never the thing to optimise.
//
// Fetching the same segments with 8 workers instead of 1 measured 4.3x faster
// on identical sources, with playlist order, audio/video sync and both
// tracks preserved. ffmpeg still does the remux; it is only given local
// files instead of a URL.
//
// This deliberately does not replace the extension's manifest detection: the
// master playlist is still chosen there, where the post-to-video mapping is
// known. This module only fetches what it is handed.

const https = require('https');
const path = require('path');
const fs = require('fs');

// Bounded so a large video cannot fan out into hundreds of sockets, and
// measured as a good trade: 4 workers gave 0.80 MB/s, 8 gave 2.24 MB/s.
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30000;
// A whole playlist is small; anything larger is not something we understand.
const MAX_PLAYLIST_BYTES = 1024 * 1024;
// One media segment. 16MB covers any single HLS segment X serves, while still
// refusing something that is not a segment at all.
const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

// Attributes are matched by name, never by position: X emits both
// "TYPE=AUDIO,GROUP-ID=..,URI=.." and "NAME=..,TYPE=AUDIO,GROUP-ID=..,URI=..",
// and assuming an order silently drops the audio track.
function attributes(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function resolve(base, ref) {
  try { return new URL(ref, base).href; } catch { return null; }
}

// Splits a master playlist into its video variants and audio renditions.
function parseMaster(text, base) {
  const variants = [];
  const audio = {};
  const subtitles = {};
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line);
    const uri = a.URI ? resolve(base, a.URI) : null;
    if (!uri || !a['GROUP-ID']) continue;
    if (a.TYPE === 'AUDIO') audio[a['GROUP-ID']] = uri;
    else if (a.TYPE === 'SUBTITLES') subtitles[a['GROUP-ID']] = uri;
  }

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const a = attributes(lines[i]);
    const next = (lines[i + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    const url = resolve(base, next);
    if (!url) continue;
    variants.push({
      url,
      bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
      audioGroup: a.AUDIO || null,
      resolution: a.RESOLUTION || null,
    });
  }
  return { variants, audio, subtitles };
}

// A media playlist: the fMP4 init section (EXT-X-MAP) plus ordered segments.
// Order is taken from the playlist and never rearranged.
function parseMedia(text, base) {
  let init = null;
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const u = attributes(line).URI;
      if (u) init = resolve(base, u);
      continue;
    }
    if (line.startsWith('#')) continue;
    const url = resolve(base, line);
    if (url) segments.push(url);
  }
  return { init, segments };
}

// ffmpeg picks the highest-bandwidth variant by default; matching that here
// keeps the prefetched output the same video it would have produced itself.
function chooseVariant(master) {
  if (!master.variants.length) return null;
  return master.variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
}

// Every URL this fetch will make, so the caller can log the count and bound
// the total size before committing to the work.
function plannedUrls(masterText, masterUrl) {
  const master = parseMaster(masterText, masterUrl);
  const variant = chooseVariant(master);
  if (!variant) return null;
  const audioUrl = variant.audioGroup ? master.audio[variant.audioGroup] : null;
  return { master, variant, audioUrl };
}

function get(url, redirects = 0, maxBytes) {
  return new Promise((resolve2, reject) => {
    if (redirects > 5) return reject(new Error('too-many-redirects'));
    const req = https.get(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(resolve(url, res.headers.location), redirects + 1, maxBytes).then(resolve2, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`http-${res.statusCode}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        // The cap is per caller: a playlist is tiny, a media segment is not.
        // Applying the playlist cap to segments rejected ordinary 1MB+ ones.
        if (total > maxBytes) { req.destroy(); return reject(new Error('too-large')); }
        chunks.push(c);
      });
      // Raw bytes, never text. Playlists are written as UTF-8 when they are
      // parsed, but segments and the fMP4 init section are binary: decoding
      // them as text corrupts them (a 903-byte init section came back as a
      // different 960-byte file, with an unreadable mvhd time scale).
      res.on('end', () => resolve2(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Only for transient failures. A 404 or a 403 will not fix itself, and
// retrying those just delays the real error.
const TRANSIENT = /^(timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up|http-5\d\d)$/;
function isTransient(err) {
  return TRANSIENT.test(String((err && err.message) || err));
}

async function getWithRetry(url, retries, onRetry, maxBytes) {
  let last;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try { return await get(url, 0, maxBytes || MAX_PLAYLIST_BYTES); }
    catch (e) {
      last = e;
      if (!isTransient(e) || attempt === retries) throw e;
      if (onRetry) onRetry(url, attempt, e);
    }
  }
  throw last;
}

// Playlists are text; everything else must stay bytes.
const getText = async (url, retries) => (await getWithRetry(url, retries, null, MAX_PLAYLIST_BYTES)).toString('utf8');

// Downloads `urls` with bounded concurrency. Results keep playlist order:
// the output array is indexed, never appended, so a slow segment cannot
// reorder the timeline.
async function fetchOrdered(urls, dir, prefix, opts) {
  const concurrency = Math.max(1, Math.min(opts.concurrency || DEFAULT_CONCURRENCY, 16));
  const retries = opts.retries || DEFAULT_RETRIES;
  const names = new Array(urls.length);
  let next = 0;
  let bytes = 0;
  let retriesUsed = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i];
      const name = `${prefix}-${String(i).padStart(5, '0')}${path.extname(new URL(url).pathname) || '.ts'}`;
      const dest = path.join(dir, name);
      const data = await getWithRetry(url, retries, (u, attempt, e) => { retriesUsed++; }, opts.maxSegmentBytes || MAX_SEGMENT_BYTES);
      bytes += data.length;
      if (opts.maxBytes && bytes > opts.maxBytes) throw new Error('media-too-large');
      fs.writeFileSync(dest, data);
      names[i] = name;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return { names, bytes, retries: retriesUsed };
}

// Rewrites a media playlist to point at the local copies. Every non-comment
// line is replaced by name in the original position, and the EXT-X-MAP init
// section is repointed, so ffmpeg reads exactly the same timeline.
function writeLocalPlaylist(dir, tag, original, initName, names) {
  const out = [];
  let k = 0;
  for (const raw of original.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      out.push(line.startsWith('#EXT-X-MAP:') && initName
        ? `#EXT-X-MAP:URI="${initName}"` : line);
    } else {
      out.push(names[k++]);
    }
  }
  const p = path.join(dir, `${tag}.m3u8`);
  fs.writeFileSync(p, out.join('\n') + '\n');
  return p;
}

// Fetches everything the chosen variant (and its audio) needs into `dir`,
// and returns the local playlists. Throws on any unrecoverable error.
async function prefetch(masterUrl, dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const masterText = await getText(masterUrl, opts.retries || DEFAULT_RETRIES);
  const plan = plannedUrls(masterText, masterUrl);
  if (!plan) throw new Error('hls-no-variant');

  const variantText = await getText(plan.variant.url, opts.retries || DEFAULT_RETRIES);
  const video = parseMedia(variantText, plan.variant.url);
  if (!video.segments.length) throw new Error('hls-no-segments');

  // An init section is mandatory for fMP4; without it ffmpeg cannot open the
  // first segment at all.
  let initName = null;
  if (video.init) {
    const data = await getWithRetry(video.init, opts.retries || DEFAULT_RETRIES);
    initName = `${'init'}.mp4`;
    fs.writeFileSync(path.join(dir, initName), data);
  }

  const v = await fetchOrdered(video.segments, dir, 'v', opts);
  const videoPlaylist = writeLocalPlaylist(dir, 'v', variantText, initName, v.names);

  let audioPlaylist = null;
  let audioSegments = 0;
  if (plan.audioUrl) {
    const audioText = await getText(plan.audioUrl, opts.retries || DEFAULT_RETRIES);
    const audio = parseMedia(audioText, plan.audioUrl);
    if (audio.segments.length) {
      let aInit = null;
      if (audio.init) {
        const data = await getWithRetry(audio.init, opts.retries || DEFAULT_RETRIES, null, MAX_SEGMENT_BYTES);
        aInit = 'ainit.mp4';
        fs.writeFileSync(path.join(dir, aInit), data);
      }
      const a = await fetchOrdered(audio.segments, dir, 'a', opts);
      audioPlaylist = writeLocalPlaylist(dir, 'a', audioText, aInit, a.names);
      audioSegments = a.names.length;
      v.bytes += a.bytes;
      v.retries += a.retries;
    }
  }

  return {
    dir,
    videoPlaylist,
    audioPlaylist,
    expectsAudio: Boolean(plan.audioUrl),
    videoSegments: v.names.length,
    audioSegments,
    bytes: v.bytes,
    retries: v.retries,
    variant: plan.variant,
  };
}

module.exports = {
  prefetch, parseMaster, parseMedia, chooseVariant, plannedUrls,
  attributes, isTransient, fetchOrdered, writeLocalPlaylist,
  DEFAULT_CONCURRENCY, MAX_PLAYLIST_BYTES,
};