// Screenshot media pipeline tests - no WhatsApp connection required.
//
// The inline-image path is what lets a screenshot reach the channel: the
// image has no URL, so it travels inside the send request and is written to
// the job's temp file before the existing validation and upload run over it.
//
//   node controller/test/screenshot-pipeline.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decodeInlineImage, isInlineImage } = require('../src/inline-media');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// The same sniffing the controller applies before uploading, so a decoded
// screenshot is proven to be recognised as an image and not as a stray file.
function sniffImageExt(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf.length >= 16 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
  return null;
}

console.log('a captured screenshot becomes a real image file');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x2wa-shot-'));
  // A genuine JPEG: SOI marker, enough bytes for the sniffer to look at.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 0x11)]);
  const source = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

  check('it is recognised as inline', isInlineImage(source));
  const decoded = decodeInlineImage(source);
  check('it decodes without error', !decoded.error, decoded);
  eq('to the right type', decoded.type, 'image/jpeg');

  const file = path.join(dir, 'shot.bin');
  fs.writeFileSync(file, decoded.buffer);
  eq('the bytes land intact', fs.readFileSync(file).equals(jpeg), true);
  eq('and are recognised as a jpeg by magic bytes', sniffImageExt(fs.readFileSync(file)), '.jpg');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('a screenshot cannot impersonate anything else');
{
  // Declaring an image type does not make the bytes an image; the sniffer
  // is what decides, so a mislabelled payload is caught rather than uploaded.
  const notAnImage = Buffer.from('<svg onload=alert(1)></svg>');
  const source = `data:image/png;base64,${notAnImage.toString('base64')}`;
  const decoded = decodeInlineImage(source);
  check('it decodes as declared', decoded.type === 'image/png');
  eq('but the sniffer does not call it an image', sniffImageExt(decoded.buffer), null);
}

console.log('inline images are bounded and nothing else is affected');
{
  // An ordinary post still sends http URLs; the inline path must not have
  // widened what counts as a usable media source.
  check('a url is not inline', isInlineImage('https://video.twimg.com/x.m3u8') === false);
  check('an m3u8 is not inline', isInlineImage('https://video.twimg.com/amplify_video/1/pl/x.m3u8') === false);
  eq('an inline image that is not an image is refused', decodeInlineImage('data:text/html;base64,PGI+').error, 'media-type-unsupported');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SCREENSHOT PIPELINE TESTS PASSED');
process.exit(failures ? 1 : 0);