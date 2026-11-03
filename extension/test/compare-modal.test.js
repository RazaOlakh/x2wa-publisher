'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function ok(msg, val) {
  assert(val, msg);
  console.log('  ok   ' + msg);
}

function eq(msg, actual, expected) {
  assert.strictEqual(actual, expected, `${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  console.log('  ok   ' + msg);
}

const ROOT = path.join(__dirname, '..', '..');
const buttonSrc = fs.readFileSync(path.join(ROOT, 'extension', 'content', 'button.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.js'), 'utf8');

// Lightweight DOM node simulation for button.js and modal verification
function makeEl(tag) {
  const children = [];
  const attrs = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children,
    attrs,
    style: {
      cssText: '',
      setProperty(k, v) { el.style[k] = v; },
    },
    textContent: '',
    value: '',
    classList: {
      _set: new Set(),
      add(c) { el.classList._set.add(c); },
      remove(c) { el.classList._set.delete(c); },
      contains(c) { return el.classList._set.has(c); },
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    appendChild(c) {
      children.push(c);
      c.parentElement = el;
      return c;
    },
    removeChild(c) {
      const idx = children.indexOf(c);
      if (idx >= 0) children.splice(idx, 1);
      return c;
    },
    remove() {
      if (el.parentElement) el.parentElement.removeChild(el);
    },
    querySelector(sel) {
      for (const child of children) {
        if (sel.startsWith('#') && child.id === sel.slice(1)) return child;
        if (sel.startsWith('.') && child.classList.contains(sel.slice(1))) return child;
        if (child.querySelector) {
          const found = child.querySelector(sel);
          if (found) return found;
        }
      }
      return null;
    },
    firstElementChild: null,
    addEventListener(ev, fn) { el['_on_' + ev] = fn; },
  };

  Object.defineProperty(el, 'firstElementChild', {
    get: () => children[0] || null,
  });

  return el;
}

async function runTests() {
  console.log('--- 1. Compare Button & Modal Injection in Content Script ---');
  ok('button.js defines compareIcon', buttonSrc.includes('function compareIcon()'));
  ok('button.js defines createCompareButton', buttonSrc.includes('function createCompareButton('));
  ok('button.js defines openModelComparisonModal', buttonSrc.includes('function openModelComparisonModal('));
  ok('button.js injects createCompareButton into toolbar', buttonSrc.includes('toolbar.appendChild(createCompareButton(article))'));

  // Test createCompareButton execution
  const bodyEl = makeEl('body');
  const docEl = makeEl('html');
  docEl.appendChild(bodyEl);

  const sentRuntimeMessages = [];
  const sandbox = {
    document: {
      body: bodyEl,
      documentElement: docEl,
      createElement: (t) => makeEl(t),
      createElementNS: (ns, t) => makeEl(t),
      querySelectorAll: () => [],
      getElementById: (id) => {
        const find = (n) => {
          if (n.id === id) return n;
          for (const c of n.children) {
            const f = find(c);
            if (f) return f;
          }
          return null;
        };
        return find(docEl);
      },
    },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      scrollX: 0,
      scrollY: 0,
      location: { href: 'https://x.com/test' },
      __xwapExtractPostAsync: async () => ({ text: 'Breaking news: Space mission launched successfully.' }),
    },
    navigator: {
      clipboard: {
        writeText: async () => {},
      },
    },
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          sentRuntimeMessages.push(msg);
          if (msg.type === 'COMPARE_MODELS') {
            return {
              ok: true,
              original: msg.text,
              pure: true,
              results: [
                {
                  model: 'openai/gpt-oss-120b',
                  modelName: 'GPT-OSS 120B',
                  provider: 'groq',
                  text: 'اہم خبر: خلائی مشن کامیابی کے ساتھ روانہ ہوا۔',
                  durationMs: 450,
                  ok: true,
                },
                {
                  model: 'qwen/qwen3.8-27b',
                  modelName: 'Qwen 3.8 27B',
                  provider: 'groq',
                  text: 'تازہ ترین: خلائی مشن کا کامیاب آغاز۔',
                  durationMs: 310,
                  ok: true,
                },
                {
                  model: 'google',
                  modelName: 'Google Translate',
                  provider: 'google',
                  text: 'بریکنگ نیوز: خلائی مشن کامیابی سے شروع کیا گیا۔',
                  durationMs: 250,
                  ok: true,
                },
              ],
            };
          }
          return { ok: true };
        },
        onMessage: {
          addListener: () => {},
        },
      },
      storage: {
        local: {
          get: (k, cb) => cb({}),
          set: (d, cb) => cb && cb(),
        },
      },
    },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    MutationObserver: class { observe() {} },
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(buttonSrc, sandbox);

  const fakeArticle = makeEl('article');
  const compareBtn = sandbox.createCompareButton(fakeArticle);
  ok('compare button created', Boolean(compareBtn));
  eq('button action attribute is compare-models', compareBtn.getAttribute('data-xwap-action'), 'compare-models');
  ok('button has informative title', compareBtn.title.includes('Test & Compare'));

  // Trigger compare click
  await compareBtn._on_click({ preventDefault: () => {}, stopPropagation: () => {} });

  const modalRoot = bodyEl.querySelector('#__xwap-compare-modal-root');
  ok('centered comparison modal root is mounted in DOM', Boolean(modalRoot));
  ok('modal has fixed positioning in center', modalRoot.style.cssText.includes('position:fixed') && modalRoot.style.cssText.includes('display:flex'));

  // Verify COMPARE_MODELS was dispatched
  const compMsg = sentRuntimeMessages.find((m) => m.type === 'COMPARE_MODELS');
  ok('COMPARE_MODELS message sent to background', Boolean(compMsg));
  eq('pure translation flag is true', compMsg.pure, true);
  eq('original text passed intact with no modifications', compMsg.text, 'Breaking news: Space mission launched successfully.');

  console.log('\n--- 2. Centered Pop-up Modal Verification ---');
  ok('modal root contains children', modalRoot.children.length > 0);

  // Test dismissal
  modalRoot.remove();
  const afterRemove = bodyEl.querySelector('#__xwap-compare-modal-root');
  ok('modal dismissed cleanly', afterRemove === null);

  console.log('\n--- 3. Popup Integration with Test & Analyze Card ---');
  ok('popup.html contains #compareCard', popupHtml.includes('id="compareCard"'));
  ok('popup.html contains #compareInputText', popupHtml.includes('id="compareInputText"'));
  ok('popup.html contains #compareRunBtn', popupHtml.includes('id="compareRunBtn"'));
  ok('popup.html contains #compareResultsWrap', popupHtml.includes('id="compareResultsWrap"'));
  ok('popup.js binds compareRunBtn click listener', popupJs.includes('ui.compareRunBtn.addEventListener(\'click\''));

  console.log('\nALL EXTENSION COMPARE MODAL TESTS PASSED');
}

runTests().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
