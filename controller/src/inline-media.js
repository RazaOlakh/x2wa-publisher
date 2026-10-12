// An image handed over inline as a data: URL rather than fetched.
//
// The only thing that produces one is a screenshot taken in the browser:
// there is no URL to download it from, so it has to travel inside the send
// request. Nothing else may use this path - a post's real images always
// arrive as http(s) URLs and are downloaded normally.
//
// Decoding is strict on purpose. Buffer.from(x, 'base64') silently ignores
// anything that is not valid base64, so an unchecked payload would be
// quietly truncated rather than rejected. The prefix, the media type, the
// alphabet and the decoded length are all checked here instead.
const MAX_INLINE_BYTES = 24 * 1024 * 1024;

// Anchored, so a trailing comma or a second segment cannot slip past.
const DATA_URL = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

function isInlineImage(source) {
  return typeof source === 'string' && DATA_URL.test(source);
}

// base64 carries 3 bytes per 4 characters, so this bounds the decoded size
// without decoding anything.
function inlineLength(source) {
  const m = DATA_URL.exec(source);
  if (!m) return 0;
  const unpadded = m[2].replace(/=+$/, '');
  return Math.floor((unpadded.length * 3) / 4);
}

function decodeInlineImage(source) {
  if (typeof source !== 'string' || !source) return { error: 'media-source-invalid' };
  const m = DATA_URL.exec(source);
  if (!m) return { error: 'media-source-invalid' };

  const type = m[1].toLowerCase();
  if (!ALLOWED.has(type)) return { error: 'media-type-unsupported' };

  const size = inlineLength(source);
  if (size === 0) return { error: 'media-source-invalid' };
  if (size > MAX_INLINE_BYTES) return { error: 'media-too-large' };

  const buffer = Buffer.from(m[2], 'base64');
  // If the string was not really base64 the decoder quietly drops the
  // invalid parts, so compare against what it should have produced.
  if (buffer.length !== size) return { error: 'media-source-invalid' };

  return { buffer, type };
}

module.exports = { decodeInlineImage, isInlineImage, inlineLength, MAX_INLINE_BYTES, ALLOWED };