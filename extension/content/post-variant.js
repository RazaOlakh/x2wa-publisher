// The send variants.
//
// Every send button posts the same tweet to the same Channel and shares the
// same states, the same tick and the same duplicate guard. They differ only in
// how the post is presented on the way out, and that difference lives here:
// a new way of sending is a new row in this table, not another branch inside
// the button's rendering and its click handling.
//
//   plain  the post as written
//   named  the same post with the author's name above it
//   urdu   the same post with its text translated to Urdu
//
// `icon` names the idle glyph in button.js, `color` is its idle colour,
// `action` is what assistive tech and hover read, `nameTheAuthor` asks the
// content script to put the author's name on top, and `translateTo` asks the
// controller to translate the text first. The colour is only the idle state:
// once a post is being sent the shared state colours (below) take over.
//
// Pure, so the differences can be tested without a browser.
const POST_VARIANTS = {
  plain: { action: 'Post to WhatsApp',      icon: 'whatsapp', color: '#536471', nameTheAuthor: false, translateTo: null },
  named: { action: 'Post with author name', icon: 'at',       color: '#536471', nameTheAuthor: true,  translateTo: null },
  urdu:  { action: 'Post in Urdu',          icon: 'globe',    color: '#536471', nameTheAuthor: false, translateTo: 'ur' },
};

// Look a variant up, falling back to the plain one so a name that is ever
// missing can never silently change what a button does.
function postVariant(name) {
  return POST_VARIANTS[name] || POST_VARIANTS.plain;
}

// The caption that travels with a quote-tweet's picture. The words are always
// the outer post's own (the picture is the post it quotes), presented the way
// the pressed button presents a post: the plain button keeps them as written,
// the author-name button puts the name above them, and the Urdu button leaves
// them for the controller to translate - the `translateTo` it already carries.
// With no name to head it (or an empty post) the words go through as they are.
function quoteCaption(text, variant, name) {
  const v = postVariant(variant);
  if (v.nameTheAuthor) return withAuthorHeader(text, name);
  return text == null ? '' : String(text);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { POST_VARIANTS, postVariant, quoteCaption };
}
