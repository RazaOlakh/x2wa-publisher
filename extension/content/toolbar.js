// The extension's own toolbar.
//
// X's action bar (the reply / repost / like / share row) is sized for exactly
// its own icons, and an extra flex item in it gets squeezed. So the
// extension's actions live in a row of their own, placed directly beneath
// those icons. It is a plain flex row: every current and future action is one
// child, spaced by the toolbar's gap rather than by margins on each button.
// The row is held to the right edge, clear of X's own left-aligned icons.
//
// Split out from button.js so the placement decision can be checked without a
// browser: this file has no DOM work of its own beyond building the row.
const TOOLBAR_ATTR = 'data-xwap-toolbar';

function toolbarFor(bar) {
  // One toolbar per action bar. A post can be re-scanned after X re-renders
  // part of it, and a second toolbar would double every button.
  const existing = bar.parentElement && bar.parentElement.querySelector('[' + TOOLBAR_ATTR + ']');
  if (existing) return existing;

  const toolbar = document.createElement('div');
  toolbar.setAttribute(TOOLBAR_ATTR, '');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Post to WhatsApp actions');

  // The important flag keeps the page's own stylesheet from resizing or
  // collapsing the row, the same way it protects the buttons.
  const fixed = (prop, value) => toolbar.style.setProperty(prop, value, 'important');
  fixed('box-sizing', 'border-box');
  fixed('display', 'flex');
  fixed('flex-direction', 'row');
  fixed('align-items', 'center');
  // Right-aligned: our icons sit at the far edge, opposite X's own icons, so
  // the two sets never crowd each other.
  fixed('justify-content', 'flex-end');
  fixed('gap', '8px');
  fixed('margin-top', '6px');
  fixed('width', '100%');

  // Right after the action bar. That bar's parent is a column, so this lands
  // as a new row underneath the icons rather than a competing flex item in
  // their row. Falls back to the bar itself if the parent is ever missing.
  if (bar.parentElement) bar.insertAdjacentElement('afterend', toolbar);
  else bar.appendChild(toolbar);
  return toolbar;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { toolbarFor, TOOLBAR_ATTR };
}
