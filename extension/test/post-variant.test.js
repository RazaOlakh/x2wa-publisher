// Post-variant tests - zero dependencies.
//
// The toolbar has one send button per variant: the post as written, the post
// with the author's name above it, and the post translated to Urdu. These
// assert the difference each variant carries - what it is called, which idle
// glyph it wears, whether it asks for the author's name, and whether it asks
// the controller to translate - so a button's meaning lives in one table and
// cannot drift between the table and the buttons that render it.
//
//   node extension/test/post-variant.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const variantSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'post-variant.js'), 'utf8');
const buttonSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'button.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// post-variant.js is a content script: load it the way the page does, and read
// the top-level const out of the context's lexical environment.
const sandbox = { module: undefined, window: {} };
vm.createContext(sandbox);
vm.runInContext(variantSrc, sandbox);
const postVariant = sandbox.postVariant;
const POST_VARIANTS = vm.runInContext('POST_VARIANTS', sandbox);

console.log('there is one variant per way of sending');
{
  eq('the three variants, in the order the buttons are added',
    Object.keys(POST_VARIANTS).filter((k) => !k.startsWith('__')),
    ['plain', 'named', 'urdu']);
}

console.log('the plain variant sends the post as written');
{
  const v = postVariant('plain');
  eq('its name', v.action, 'Post to WhatsApp');
  eq('the WhatsApp glyph', v.icon, 'whatsapp');
  eq('it does not add the author', v.nameTheAuthor, false);
  eq('and does not translate', v.translateTo, null);
}

console.log('the named variant adds the author\'s name');
{
  const v = postVariant('named');
  eq('its name', v.action, 'Post with author name');
  eq('the "@" glyph', v.icon, 'at');
  eq('it asks for the author\'s name', v.nameTheAuthor, true);
  eq('and does not translate', v.translateTo, null);
}

console.log('the Urdu variant translates the text');
{
  const v = postVariant('urdu');
  eq('its name', v.action, 'Post in Urdu');
  eq('the globe glyph', v.icon, 'globe');
  eq('it asks for Urdu', v.translateTo, 'ur');
  eq('and does not add the author', v.nameTheAuthor, false);
}

console.log('an unknown variant is the plain one');
{
  eq('a name that is not in the table', postVariant('klingon'), POST_VARIANTS.plain);
  eq('a missing name', postVariant(undefined), POST_VARIANTS.plain);
  eq('an empty name', postVariant(''), POST_VARIANTS.plain);
}

console.log('every variant is fully wired');
{
  // button.js must have an idle glyph for every icon a variant names, or that
  // button would fall back to the WhatsApp bubble and read as the wrong action.
  const m = /const IDLE_ICONS\s*=\s*\{([\s\S]*?)\};/.exec(buttonSrc);
  check('button.js declares IDLE_ICONS', !!m);
  const wired = m ? m[1] : '';
  for (const [name, v] of Object.entries(POST_VARIANTS)) {
    check(`"${v.icon}" has a glyph wired for ${name}`, new RegExp('\\b' + v.icon + '\\s*:').test(wired), wired.trim());
    // The controller accepts a target language of at most 8 characters.
    check(`${name}'s target language is short enough`,
      v.translateTo === null || (typeof v.translateTo === 'string' && v.translateTo.length > 0 && v.translateTo.length <= 8),
      v.translateTo);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POST-VARIANT TESTS PASSED');
process.exit(failures ? 1 : 0);
