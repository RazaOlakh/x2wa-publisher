// Applies the approved PR #201824 compatibility patch to the pinned whatsapp-web.js.
// Deterministic: verifies the expected unpatched line and replaces it exactly.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const from = 'mediaMetadata: msg.avParams(),';
const to = "mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),";

if (!fs.existsSync(file)) {
  console.error('[patch] whatsapp-web.js not installed at', file);
  process.exit(1);
}

const src = fs.readFileSync(file, 'utf8');
if (src.includes(to)) {
  console.log('[patch] PR #201824 already applied');
  process.exit(0);
}
if (!src.includes(from)) {
  console.error('[patch] expected source line not found; upstream changed unexpectedly');
  process.exit(1);
}
fs.writeFileSync(file, src.replace(from, to));
console.log('[patch] applied PR #201824 media metadata fix');
