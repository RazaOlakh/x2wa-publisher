// HLS parsing and video-pipeline tests - no network, no WhatsApp.
//
//   node controller/test/hls-prefetch.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hp = require('../src/hls-prefetch');
const vp = require('../src/video-pipeline');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-hls-')); }

// The real shape of an X master: audio lives in its own rendition group.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="x.srt",URI="/pl/s0/x.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-128000",NAME="Audio",AUTOSELECT=YES,URI="/pl/mp4a/128000/a.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-64000",NAME="Audio",AUTOSELECT=YES,URI="/pl/mp4a/64000/b.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=856055,RESOLUTION=1280x720,CODECS="mp4a.40.2,avc1.64001F",SUBTITLES="subs",AUDIO="audio-128000"',
  '/pl/avc1/1280x720/hd.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=293515,RESOLUTION=640x360,AUDIO="audio-64000"',
  '/pl/avc1/640x360/sd.m3u8',
].join('\n');

console.log('reads an X master playlist');
{
  const m = hp.parseMaster(MASTER, 'https://video.twimg.com/amplify_video/1/pl/master.m3u8');
  eq('both video variants are found', m.variants.length, 2);
  eq('both audio groups are found', Object.keys(m.audio).sort(), ['audio-128000', 'audio-64000']);
  check('audio URI is absolute', m.audio['audio-64000'].startsWith('https://video.twimg.com/'), m.audio['audio-64000']);
  eq('subtitles are seen but not treated as audio', Object.keys(m.audio).includes('subs'), false);
}
{
  // ffmpeg takes the highest bandwidth by default, so the prefetch must
  // choose the same one or it would deliver a different video.
  const m = hp.parseMaster(MASTER, 'https://video.twimg.com/amplify_video/1/pl/master.m3u8');
  const v = hp.chooseVariant(m);
  check('the highest-bandwidth variant is chosen', v.resolution === '1280x720', v.resolution);
  eq('and its audio group is carried with it', v.audioGroup, 'audio-128000');
}
{
  // X emits both attribute orders. Assuming one silently drops the audio
  // track and yields a video with no sound.
  const reordered = [
    '#EXTM3U',
    '#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="g",AUTOSELECT=YES,URI="/pl/a.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="g"',
    '/pl/v.m3u8',
  ].join('\n');
  const m = hp.parseMaster(reordered, 'https://v/x/master.m3u8');
  eq('audio is found whatever the attribute order', Object.keys(m.audio), ['g']);
}

console.log('reads a media playlist, including the init section');
{
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MAP:URI="/vid/init.mp4"',
    '#EXTINF:3.000,',
    '/vid/0.m4s',
    '#EXTINF:3.000,',
    '/vid/1.m4s',
  ].join('\n');
  const p = hp.parseMedia(media, 'https://video.twimg.com/pl/v.m3u8');
  eq('the init section is found', p.init, 'https://video.twimg.com/vid/init.mp4');
  eq('segments keep playlist order', p.segments, [
    'https://video.twimg.com/vid/0.m4s',
    'https://video.twimg.com/vid/1.m4s',
  ]);
}
{
  const p = hp.parseMedia('#EXTM3U\n#EXTINF:3,\ns.ts\n#EXTINF:3,\ns.ts', 'https://v/p.m3u8');
  eq('a playlist with no init section is fine', p.init, null);
  eq('and still lists its segments', p.segments.length, 2);
}

console.log('only transient network failures are retried');
{
  check('a timeout is transient', hp.isTransient(new Error('timeout')));
  check('a reset connection is transient', hp.isTransient(new Error('ECONNRESET')));
  check('a 5xx is transient', hp.isTransient(new Error('http-503')));
  check('a 404 is not retried', !hp.isTransient(new Error('http-404')));
  check('a 403 (expired signature) is not retried', !hp.isTransient(new Error('http-403')));
}

console.log('order is preserved however the fetches interleave');
{
  const dir = tmpdir();
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:3'];
  for (let i = 0; i < 6; i++) { lines.push('#EXTINF:3.000,'); lines.push(`s${i}.ts`); }
  const names = ['s0.ts', 's1.ts', 's2.ts', 's3.ts', 's4.ts', 's5.ts'];
  const out = hp.writeLocalPlaylist(dir, 'v', lines.join('\n'), null, names);
  const written = fs.readFileSync(out, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  eq('the rewritten playlist keeps segment order', written, names);
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  const dir = tmpdir();
  const lines = ['#EXTM3U', '#EXT-X-MAP:URI="/vid/remote-init.mp4"', '#EXTINF:3,', 'a.ts'];
  const out = hp.writeLocalPlaylist(dir, 'v', lines.join('\n'), 'init.mp4', ['a.ts']);
  const text = fs.readFileSync(out, 'utf8');
  check('the init section is repointed at the local copy', /EXT-X-MAP:URI="init\.mp4"/.test(text), text);
  check('and the remote reference is gone', !/remote-init/.test(text), text);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('an unusable copy is rejected rather than published');
(async () => {
  check('a file with no video track is rejected', !(await vp.validate('/etc/hostname', {})).ok);
  const missing = await vp.validate('/tmp/definitely-not-here.mp4', {});
  check('a missing file is rejected', !missing.ok);
  eq('and says why', missing.reason, 'probe-failed');

  // When the source had audio, a copy that lost it must not be sent: that is
  // a silent video, exactly the degradation to avoid.
  const dir = tmpdir();
  const silent = path.join(dir, 'silent.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent], { stdio: 'ignore' });
  const info = await vp.probe(silent);
  check('the generated file really has no audio', Boolean(info && info.video && !info.audio), info);
  const v = await vp.validate(silent, { expectsAudio: true });
  check('so it is rejected when audio was expected', !v.ok, v);
  eq('with a reason that names the loss', v.reason, 'audio-track-lost');
  check('but accepted when none was expected', (await vp.validate(silent, { expectsAudio: false })).ok);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('a broken source fails without leaving anything behind');
  const out = path.join(tmpdir(), 'never-written.mp4');
  const r = await vp.buildVideo(['/tmp/no-such-input.mp4'], out, { timeoutMs: 5000 });
  check('the build fails', !r.ok, r);
  check('the copy is tried first, then the encode', r.attempts[0].path === 'stream-copy' && r.attempts[1].path === 're-encode', r.attempts);
  check('and no output file is left behind', !fs.existsSync(out));
  fs.rmSync(path.dirname(out), { recursive: true, force: true });

  console.log('a usable copy is validated and returned');
  const dir2 = tmpdir();
  const withAudio = path.join(dir2, 'av.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio], { stdio: 'ignore' });
  const good = await vp.buildVideo([withAudio], path.join(dir2, 'out.mp4'), { expectsAudio: true });
  check('a valid input is copied rather than re-encoded', good.ok && good.path === 'stream-copy', { ok: good.ok, path: good.path });
  check('and the copy keeps both tracks', good.info && good.info.video && good.info.audio, good.info);
  fs.rmSync(dir2, { recursive: true, force: true });

  console.log('the re-encode fallback keeps audio that arrived separately');
  {
    // X delivers video and audio as two playlists, so the fallback is given
    // two inputs. Encoding only the first would silently drop the sound.
    const dir = tmpdir();
    const v = path.join(dir, 'v.mp4');
    const a = path.join(dir, 'a.m4a');
    const o = path.join(dir, 'o.mp4');
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', '1', '-c:a', 'aac', a], { stdio: 'ignore' });
    const r = await vp.run(vp.encodeArgs([v, a], o, {}), 60000);
    check('the two-input re-encode succeeds', r.ok, r);
    const info = await vp.probe(o);
    check('and the result carries both tracks', Boolean(info && info.video && info.audio), info);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const args = vp.encodeArgs(['v.m3u8', 'a.m3u8'], 'o.mp4', {});
    check('both inputs are passed to ffmpeg', args.filter((x) => x === '-i').length === 2, args);
    check('and audio is mapped from the second input', args.includes('-map') && args.includes('1:a:0'), args);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL HLS/PIPELINE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();