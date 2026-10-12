// Turning one video source into the MP4 WhatsApp will accept.
//
// Measured before any of this was changed: for a 5-minute X video ffmpeg
// spent ~1s of CPU and ~40-70s of wall clock. The bottleneck was never the
// encoding, it was fetching HLS segments one at a time, so the work here is
// about fetching and about not re-encoding what does not need it.
//
// The order is always:
//
//   1. stream-copy remux   - no re-encode, seconds not minutes
//   2. validate the result
//   3. re-encode          - only if the copy was unusable, with a fast preset
//   4. validate again
//
// Falling back is for output ffmpeg could not produce. It is not for an
// ambiguous source, an unreachable playlist or an expired signature, because
// re-encoding cannot fix any of those and trying would just take twice as
// long to report the same failure.

const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
const FFPROBE_TIMEOUT_MS = 30 * 1000;

// Stream-copy can produce a file that ffmpeg is happy to exit 0 on and
// WhatsApp is not, so the output is inspected rather than trusted.
function probe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height:format=duration,size,bit_rate',
      '-of', 'json', file], { timeout: FFPROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const streams = j.streams || [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        resolve({
          video: Boolean(video),
          audio: Boolean(audio),
          videoCodec: video && video.codec_name,
          audioCodec: audio && audio.codec_name,
          width: video && video.width,
          height: video && video.height,
          duration: Number((j.format && j.format.duration) || 0),
          size: Number((j.format && j.format.size) || 0),
        });
      } catch { resolve(null); }
    });
  });
}

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    // stderr is captured (and bounded) because ffmpeg's exit code alone
    // does not say what went wrong: a missing init section and an unreadable
    // segment both surface as an opaque non-zero code.
    let err = '';
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', (c) => { if (err.length < 4000) err += c.toString(); });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => { p.kill('SIGKILL'); finish({ ok: false, error: 'ffmpeg-timeout' }); }, timeoutMs);
    if (t.unref) t.unref();
    p.on('close', (code) => {
      clearTimeout(t);
      // The last meaningful line, which is where ffmpeg states the problem.
      const line = err.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      finish({ ok: code === 0, code, stderr: line.slice(0, 200) });
    });
    p.on('error', (e) => { clearTimeout(t); finish({ ok: false, error: String(e.message) }); });
  });
}

// A usable MP4 has a video track, some real duration, and - when the source
// had audio - an audio track too. A copy that came out silent is a failure,
// not a success: publishing it would drop the sound without saying so.
async function validate(file, opts) {
  const info = await probe(file);
  if (!info) return { ok: false, reason: 'probe-failed' };
  if (!info.video) return { ok: false, reason: 'no-video-track', info };
  if (!(info.duration > 0.5)) return { ok: false, reason: 'empty-output', info };
  if (opts && opts.expectsAudio && !info.audio) return { ok: false, reason: 'audio-track-lost', info };
  return { ok: true, info };
}

// No re-encode: the video is repackaged as-is. -movflags +faststart moves the
// index to the front so playback can begin before the whole file arrives.
function copyArgs(inputs, out) {
  const args = ['-y'];
  for (const i of inputs) args.push('-i', i);
  if (inputs.length > 1) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy');
  }
  args.push('-movflags', '+faststart', out);
  return args;
}

// The compatible path. veryfast rather than the default medium preset,
// because this only runs when stream-copy could not be used at all.
// Accepts one input or several; with several, audio is taken from the second
// (the separate audio playlist) so the re-encode keeps the sound.
function encodeArgs(input, out, opts = {}) {
  const list = Array.isArray(input) ? input : [input];
  const args = ['-y'];
  for (const i of list) args.push('-i', i);
  if (list.length > 1) args.push('-map', '0:v:0', '-map', '1:a:0');
  else args.push('-map', '0:v:0', '-map', '0:a:0?');
  args.push(
    '-c:v', 'libx264', '-preset', opts.preset || 'veryfast',
    '-crf', String(opts.crf || 23),
    '-pix_fmt', 'yuv420p',
    // even dimensions keep players happy; odd sizes otherwise fail outright
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', out);
  return args;
}

// Copies first, re-encodes only if the copy is unusable. Never both at once.
async function buildVideo(inputs, out, opts = {}) {
  const attempts = [];
  const isLocal = inputs.length > 1 || !/^https?:/i.test(inputs[0]);

  if (opts.skipCopy) {
    const reason = opts.skipCopy;
    attempts.push({ path: 're-encode', skipped: reason });
  } else {
    const copyOut = out.replace(/\.mp4$/, '') + '.copy.mp4';
    const args = copyArgs(inputs, copyOut);
    const t0 = Date.now();
    const r = await run(args, opts.timeoutMs || FFMPEG_TIMEOUT_MS);
    const copyMs = Date.now() - t0;

    if (!r.ok) {
      attempts.push({ path: 'stream-copy', ok: false, ms: copyMs, error: r.error || `exit-${r.code}`, stderr: r.stderr });
      // Leave no half-written file behind for the fallback to trip over.
      try { fs.rmSync(copyOut, { force: true }); } catch {}
    } else {
      const v = await validate(copyOut, opts);
      attempts.push({ path: 'stream-copy', ok: v.ok, ms: copyMs, reason: v.reason, info: v.info });
      if (v.ok) {
        if (copyOut !== out) fs.renameSync(copyOut, out);
        return { ok: true, path: 'stream-copy', file: out, attempts, info: v.info, ms: copyMs };
      }
      try { fs.rmSync(copyOut, { force: true }); } catch {}
    }
  }

  // Fallback: encode whatever the copy could not.
  if (!isLocal && !opts.localInput) {
    attempts.push({ path: 're-encode', skipped: 'source-not-local' });
    return { ok: false, path: 'none', attempts, error: 'ffmpeg-failed' };
  }
  const t0 = Date.now();
  // Both inputs, not just the first: when audio arrived as its own playlist
  // (X always does this for its videos), encoding the video alone would
  // produce a silent file. Validation would catch it, but re-encoding with
  // the audio mapped in is the point of having a fallback at all.
  const r = await run(encodeArgs(inputs, out, opts), opts.timeoutMs || FFMPEG_TIMEOUT_MS);
  const encMs = Date.now() - t0;
  if (!r.ok) {
    attempts.push({ path: 're-encode', ok: false, ms: encMs, error: r.error || `exit-${r.code}`, stderr: r.stderr });
    return { ok: false, path: 'none', attempts, error: 'ffmpeg-failed' };
  }
  const v = await validate(out, opts);
  attempts.push({ path: 're-encode', ok: v.ok, ms: encMs, reason: v.reason, info: v.info });
  if (!v.ok) return { ok: false, path: 're-encode', attempts, error: v.reason || 'invalid-output' };
  return { ok: true, path: 're-encode', file: out, attempts, info: v.info, ms: encMs };
}

module.exports = { buildVideo, validate, probe, copyArgs, encodeArgs, run, FFMPEG_TIMEOUT_MS };