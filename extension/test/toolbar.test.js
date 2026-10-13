// Toolbar tests - zero dependencies.
//
// The toolbar is our own row of icons, placed beneath X's action bar rather
// than inside it, because an extra flex item in that bar gets squeezed. These
// assert the placement decision without a browser: the row is created once,
// lands directly after the action bar, holds its icons to the right edge, and
// is a plain flex container the buttons are added to.
//
//   node extension/test/toolbar.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const toolbarSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'toolbar.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// A tiny element stand-in: a parent/child tree, an attribute bag, a style bag,
// and only the calls toolbar.js makes. The test asserts the decision, not a
// general DOM.
function fakeEl(tag, attrs) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: Object.assign({}, attrs || {}),
    parent: null,
    children: [],
    style: { props: {}, priorities: {}, setProperty(k, v, p) { el.style.props[k] = v; el.style.priorities[k] = p || ''; } },
    get parentElement() { return el.parent; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    insertAdjacentElement(position, node) {
      // Only 'afterend' is used by the toolbar.
      if (position !== 'afterend' || !el.parent) return null;
      const at = el.parent.children.indexOf(el);
      el.parent.children.splice(at + 1, 0, node);
      node.parent = el.parent;
      return node;
    },
    querySelector(sel) {
      const byAttr = /^\[([\w-]+)\]$/.exec(sel);
      const find = (node) => {
        for (const child of node.children) {
          if (byAttr && Object.prototype.hasOwnProperty.call(child.attrs, byAttr[1])) return child;
          const deeper = find(child);
          if (deeper) return deeper;
        }
        return null;
      };
      return find(el);
    },
  };
  return el;
}

const fakeDocument = { createElement: (tag) => fakeEl(tag, {}) };

// toolbar.js is a content script, so its functions are globals rather than
// exports in the browser; load it the same way the page does.
const sandbox = { module: undefined, window: {}, document: fakeDocument };
vm.createContext(sandbox);
vm.runInContext(toolbarSrc, sandbox);
const toolbarFor = sandbox.toolbarFor;
// Top-level `const` lives in the context's lexical environment, the same place
// button.js reads it from, rather than on the sandbox object.
const TOOLBAR_ATTR = vm.runInContext('TOOLBAR_ATTR', sandbox);

// The shape X renders: the action bar in a column container of its own.
function fakePost() {
  const article = fakeEl('article', { 'data-testid': 'tweet', role: 'article' });
  const column = fakeEl('div', {});
  const bar = fakeEl('div', { role: 'group' });
  column.appendChild(bar);
  article.appendChild(column);
  return { article, column, bar };
}

console.log('our icons get a row of their own beneath X\'s action bar');
{
  const { article, column, bar } = fakePost();
  const toolbar = toolbarFor(bar);
  check('a toolbar is returned', !!toolbar);
  eq('it is tagged for lookup', toolbar.getAttribute(TOOLBAR_ATTR), '');
  eq('it is a toolbar to assistive tech', toolbar.getAttribute('role'), 'toolbar');
  check('it is named', /Post to WhatsApp/.test(toolbar.getAttribute('aria-label') || ''), toolbar.getAttribute('aria-label'));
  check('it lands directly after the action bar', column.children.indexOf(toolbar) === column.children.indexOf(bar) + 1);
  check('and so beneath the icons, not inside the bar', toolbar.parent === column && toolbar.parent !== bar);
  check('the action bar stays empty of our icons', bar.children.length === 0);
  check('it is still inside the post', article.querySelector('[' + TOOLBAR_ATTR + ']') === toolbar);
}
{
  // The row is a flex container the actions are added to.
  const { bar } = fakePost();
  const toolbar = toolbarFor(bar);
  eq('the row is a flex row', toolbar.style.props.display, 'flex');
  eq('laying its icons out in a row', toolbar.style.props['flex-direction'], 'row');
  eq('holding them to the right edge, clear of X\'s own icons',
    toolbar.style.props['justify-content'], 'flex-end');
  eq('spacing them with a gap rather than margins', toolbar.style.props.gap, '8px');
  eq('and sizing itself with the important flag so the page cannot pull it apart',
    toolbar.style.props.width, '100%');
  check('every style uses the important flag',
    Object.keys(toolbar.style.props).length > 0 &&
    Object.values(toolbar.style.priorities).every((p) => p === 'important'));

  const a = fakeEl('button', {}); const b = fakeEl('button', {});
  toolbar.appendChild(a); toolbar.appendChild(b);
  eq('the actions are its children', toolbar.children.length, 2);
  check('and the same buttons', toolbar.children[0] === a && toolbar.children[1] === b);
}
{
  // Scanning a post twice must not add a second row: that would double every
  // button, and X re-renders parts of a post as you scroll.
  const { bar, column } = fakePost();
  const first = toolbarFor(bar);
  const second = toolbarFor(bar);
  check('asking twice returns the same toolbar', first === second);
  eq('and no second row was added', column.children.length, 2);
  check('exactly one toolbar sits after the bar', column.children.filter((c) => c.getAttribute(TOOLBAR_ATTR) === '').length === 1);
}
{
  // Without a container (should not happen on X) it still yields a usable row,
  // just inside the action bar rather than beside it.
  const bar = fakeEl('div', { role: 'group' });
  const toolbar = toolbarFor(bar);
  check('a bar with no parent still gets a toolbar', !!toolbar);
  check('placed inside the bar as a fallback', toolbar.parent === bar && bar.children[0] === toolbar);
}
{
  // Two posts on one page are independent.
  const a = fakePost(); const b = fakePost();
  const ta = toolbarFor(a.bar); const tb = toolbarFor(b.bar);
  check('each post gets its own toolbar', ta !== tb && ta.parent === a.column && tb.parent === b.column);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TOOLBAR TESTS PASSED');
process.exit(failures ? 1 : 0);
