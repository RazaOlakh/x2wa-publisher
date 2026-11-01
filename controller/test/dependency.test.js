// Verifies the whatsapp-web.js install is the intended, patched build.
//
// Guards the two ways this can silently break: a dependency that resolves
// to something other than the vendored artifact, and the Channel media
// patch (or the WhatsApp Web ID compatibility fixes) not being applied.
//
//   node controller/test/dependency.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + String(extra).slice(0, 160) : ''}`); }
}

const CTRL = path.join(__dirname, '..');
const LIB = path.join(CTRL, 'node_modules', 'whatsapp-web.js');

console.log('declared dependency is the tracked vendor artifact');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(CTRL, 'package.json'), 'utf8'));
  const dep = pkg.dependencies['whatsapp-web.js'];
  check('package.json points into vendor/', String(dep).startsWith('file:vendor/'), dep);
  check('postinstall runs the patch script', /apply-patches\.js/.test((pkg.scripts && pkg.scripts.postinstall) || ''), pkg.scripts);
  const artifact = path.join(CTRL, String(dep).replace(/^file:/, ''));
  check('vendored artifact exists', fs.existsSync(artifact), artifact);
  // The artifact must be committed, not a path into a gitignored spike dir.
  check('artifact is inside the repo (not ../spike*)', !String(dep).includes('..'), dep);
}

console.log('installed package is 1.34.7');
{
  check('whatsapp-web.js is installed', fs.existsSync(path.join(LIB, 'package.json')));
  if (fs.existsSync(path.join(LIB, 'package.json'))) {
    const v = JSON.parse(fs.readFileSync(path.join(LIB, 'package.json'), 'utf8')).version;
    check('version is 1.34.7', v === '1.34.7', v);
  }
}

console.log('WhatsApp Channel media patch (PR #201824) is applied');
{
  const f = path.join(LIB, 'src', 'util', 'Injected', 'Utils.js');
  check('Utils.js present', fs.existsSync(f));
  if (fs.existsSync(f)) {
    const src = fs.readFileSync(f, 'utf8');
    check("mediaMetadata uses WAWebMediaMetadata", src.includes("mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),"));
    check('old mediaMetadata call removed', !src.includes('mediaMetadata: msg.avParams(),'));
  }
}

console.log('Link preview chat-context patch is applied');
{
    const f = path.join(LIB, 'src', 'util', 'Injected', 'Utils.js');
    if (fs.existsSync(f)) {
        const src = fs.readFileSync(f, 'utf8');
        check('send passes chat id to getLinkPreview', src.includes('.getLinkPreview(link, { id: chat.id._serialized })'));
        check('edit passes chat id to getLinkPreview', src.includes('.getLinkPreview(link, { id: msg.id.remote })'));
        check('bare one-arg getLinkPreview calls removed', !/\.getLinkPreview\(link\);/.test(src));
    }
}

console.log('WhatsApp Web message-ID compatibility fixes are present');
{
  const f = path.join(LIB, 'src', 'util', 'Injected', 'Utils.js');
  if (fs.existsSync(f)) {
    const src = fs.readFileSync(f, 'utf8');
    check('falls back to $1 on message ids', src.includes('msg.id._serialized || msg.id.$1'));
    check('falls back to $1 on Msg lookups', /Msg\.get\([^)]*\|\|[^)]*\$1/.test(src));
    check('strips colliding __x_id', src.includes('delete message.__x_id'));
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nDEPENDENCY VERIFIED');
process.exit(failures ? 1 : 0);