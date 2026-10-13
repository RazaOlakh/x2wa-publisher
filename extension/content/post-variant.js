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
// `icon` names the idle glyph in button.js, `action` is what assistive tech and
// hover read, `nameTheAuthor` asks the content script to put the author's name
// on top, and `translateTo` asks the controller to translate the text first.
//
// Pure, so the differences can be tested without a browser.
const POST_VARIANTS = {
  plain: { action: 'Post to WhatsApp',      icon: 'whatsapp', nameTheAuthor: false, translateTo: null },
  named: { action: 'Post with author name', icon: 'at',       nameTheAuthor: true,  translateTo: null },
  urdu:  { action: 'Post in Urdu',          icon: 'globe',    nameTheAuthor: false, translateTo: 'ur' },
};

// Look a variant up, falling back to the plain one so a name that is ever
// missing can never silently change what a button does.
function postVariant(name) {
  return POST_VARIANTS[name] || POST_VARIANTS.plain;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { POST_VARIANTS, postVariant };
}
