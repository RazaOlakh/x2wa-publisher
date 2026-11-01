'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const POPUP_DIR = path.join(__dirname, '..', 'popup');
const html = fs.readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(POPUP_DIR, 'popup.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

function ok(msg, cond) {
  assert(cond, msg);
  console.log('  ok   ' + msg);
}

function eq(msg, actual, expected) {
  assert.strictEqual(actual, expected, `${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  console.log('  ok   ' + msg);
}

// ---------------------------------------------------------------- DOM stub
function makeEl(id) {
  const el = {
    id,
    textContent: '',
    innerText: '',
    src: '',
    className: '',
    disabled: false,
    value: '',
    placeholder: '',
    selectedIndex: 0,
    options: [],
    style: {},
    _classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); el.className = [...el._classes].join(' '); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); el.className = [...el._classes].join(' '); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) {
        if (on === undefined) {
          el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c);
        } else if (on) el._classes.add(c); else el._classes.delete(c);
        el.className = [...el._classes].join(' ');
      },
    },
    appendChild(child) { el.options.push(child); el._lastChild = child; return child; },
    insertBefore(child, ref) {
      const i = el.options.indexOf(ref);
      el.options.splice(i < 0 ? el.options.length : i, 0, child);
      return child;
    },
    addEventListener(ev, fn) { el['_on_' + ev] = fn; },
    focus() { el._focused = true; },
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => _html,
    set: (v) => { _html = v; if (v === '') el.options = []; },
  });
  return el;
}

function buildDom() {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const els = {};
  for (const id of ids) {
    const el = makeEl(id);
    const m = new RegExp(`id="${id}"[^>]*class="([^"]+)"`).exec(html) ||
              new RegExp(`class="([^"]+)"[^>]*id="${id}"`).exec(html);
    if (m && m[1]) {
      m[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    }
    els[id] = el;
  }
  return { ids, els };
}

async function runTestHarness({ groqConfig = { configured: false, model: 'qwen/qwen3.8-27b' } } = {}) {
  const { ids, els } = buildDom();
  const fetchCalls = [];
  let currentGroqConfig = Object.assign({}, groqConfig);
  let savedOverrides = [];
  let sidebarOpened = false;

  const mockFetch = async (url, opts = {}) => {
    fetchCalls.push({ url, opts });
    const u = new URL(url);

    if (u.pathname === '/status') {
      return { ok: true, status: 200, json: async () => ({ state: 'ready', me: { user: '123' } }) };
    }
    if (u.pathname === '/channels') {
      return { ok: true, status: 200, json: async () => ({ channels: [] }) };
    }
    if (u.pathname === '/version') {
      return { ok: true, status: 200, json: async () => ({ status: 'up-to-date', localHash: '123' }) };
    }
    if (u.pathname === '/groq/config') {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        if (body.apiKey !== undefined) {
          if (body.apiKey) {
            currentGroqConfig.configured = true;
            currentGroqConfig.maskedKey = body.apiKey.slice(0, 4) + '...' + body.apiKey.slice(-4);
          } else {
            currentGroqConfig.configured = false;
            currentGroqConfig.maskedKey = '';
          }
        }
        if (body.model) {
          currentGroqConfig.model = body.model;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            configured: currentGroqConfig.configured,
            model: currentGroqConfig.model,
          }),
        };
      }
      return { ok: true, status: 200, json: async () => currentGroqConfig };
    }
    if (u.pathname === '/transliterate/override') {
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        savedOverrides.push(body);
        return { ok: true, status: 200, json: async () => ({ ok: true, entry: body }) };
      }
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const mockChrome = {
    storage: {
      local: {
        get: (keys, cb) => cb({}),
        set: (data, cb) => cb && cb(),
        remove: (keys, cb) => cb && cb(),
      },
    },
    windows: {
      getCurrent: async () => ({ id: 42 }),
    },
    sidePanel: {
      open: async ({ windowId }) => {
        eq('Sidebar opened with current window ID', windowId, 42);
        sidebarOpened = true;
      },
    },
  };

  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl(tag),
      addEventListener: (ev, fn) => {
        if (ev === 'DOMContentLoaded') setTimeout(fn, 0);
      },
    },
    window: {
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: mockFetch,
    chrome: mockChrome,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
  };

  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(popupJs, sandbox);

  // Allow initial refresh to run
  await new Promise((r) => setTimeout(r, 50));

  return { els, fetchCalls, getGroqConfig: () => currentGroqConfig, savedOverrides, wasSidebarOpened: () => sidebarOpened };
}

async function runAll() {
  console.log('--- 1. Manifest V3 Side Panel Configuration ---');
  ok('permissions includes sidePanel', manifest.permissions.includes('sidePanel'));
  ok('side_panel is defined', Boolean(manifest.side_panel));
  eq('side_panel default_path points to popup/popup.html', manifest.side_panel.default_path, 'popup/popup.html');
  ok('action.default_popup is omitted for side panel action click', manifest.action.default_popup === undefined);
  ok('action.default_icon is defined', Boolean(manifest.action.default_icon));

  console.log('\n--- 2. Sidebar Trigger from Popup ---');
  {
    const { els, wasSidebarOpened } = await runTestHarness();
    ok('Sidebar button exists in popup', Boolean(els.openSidebarBtn));
    await els.openSidebarBtn._on_click();
    ok('Clicking sidebar button triggers chrome.sidePanel.open', wasSidebarOpened());
  }

  console.log('\n--- 3. Groq API Key and Model Configuration in Popup ---');
  {
    const { els, fetchCalls } = await runTestHarness({
      groqConfig: { configured: false, model: 'openai/gpt-oss-120b' },
    });

    ok('Initial badge indicates fallback', els.groqBadge.textContent.includes('Google Fallback'));
    ok('Remove key button is hidden initially', els.groqClearBtn.classList.contains('hidden'));
    ok('Model selector exists', Boolean(els.groqModelSelect));
    eq('Model selector defaults to openai/gpt-oss-120b', els.groqModelSelect.value, 'openai/gpt-oss-120b');

    // Enter a Groq API key
    els.groqKeyInput.value = 'gsk_test_api_key_12345';
    await els.groqSaveBtn._on_click();

    // Verify POST /groq/config was called with key and model
    const postCall = fetchCalls.find((c) => c.url.includes('/groq/config') && c.opts.method === 'POST');
    ok('POST /groq/config called', Boolean(postCall));
    const sentBody = JSON.parse(postCall.opts.body);
    eq('API key sent to controller', sentBody.apiKey, 'gsk_test_api_key_12345');
    eq('Model sent to controller', sentBody.model, 'openai/gpt-oss-120b');

    // Badge updates to GPT-OSS 120B Active
    ok('Badge reflects active GPT-OSS 120B model', els.groqBadge.textContent.includes('GPT-OSS 120B Active'));
    ok('Remove button becomes visible', !els.groqClearBtn.classList.contains('hidden'));

    // Switch model to Qwen via select dropdown
    els.groqModelSelect.value = 'qwen/qwen3.8-27b';
    await els.groqModelSelect._on_change();
    ok('Badge updates to Qwen 3.8 27B Active', els.groqBadge.textContent.includes('Qwen 3.8 27B Active'));

    // Click remove key
    await els.groqClearBtn._on_click();
    ok('Badge reverts to fallback when key cleared', els.groqBadge.textContent.includes('Google Fallback'));
    ok('Remove button hidden again', els.groqClearBtn.classList.contains('hidden'));
  }

  console.log('\n--- 4. Manual Name Transliteration Override in Popup ---');
  {
    const { els, savedOverrides } = await runTestHarness();

    ok('+ Add override button exists', Boolean(els.revAddBtn));
    ok('Add override form is initially hidden', els.revAddForm.classList.contains('hidden'));

    // Toggle open form
    els.revAddBtn._on_click();
    ok('Form is visible after clicking + Add override', !els.revAddForm.classList.contains('hidden'));
    ok('Button text changed to cancel', els.revAddBtn.textContent.includes('Cancel'));

    // Fill form
    els.revAddOriginal.value = 'OpenAI';
    els.revAddUrdu.value = 'اوپن اے آئی';
    await els.revAddSaveBtn._on_click();

    // Verify override was posted to controller
    eq('1 override saved', savedOverrides.length, 1);
    eq('Original name matches', savedOverrides[0].original, 'OpenAI');
    eq('Urdu transliteration matches', savedOverrides[0].transliteration, 'اوپن اے آئی');
    ok('Success note displayed', els.revAddNote.textContent.includes('Saved override: OpenAI → اوپن اے آئی'));
  }

  console.log('\n--- 5. Bottom Center Translation Engine Indicator ---');
  {
    // A. Fallback state
    const { els } = await runTestHarness({ groqConfig: { configured: false, model: 'qwen/qwen3.8-27b' } });
    ok('Bottom center indicator exists', Boolean(els.transEngineText));
    ok('Shows Google fallback when no key', els.transEngineText.textContent.includes('Google Translate (Fallback)'));
    eq('Dot color is amber for fallback', els.transEngineDot.style.background, '#e3a008');

    // B. Groq active state (GPT-OSS 120B)
    const { els: elsGroq } = await runTestHarness({
      groqConfig: {
        configured: true,
        model: 'openai/gpt-oss-120b',
        lastTranslation: { provider: 'groq', model: 'openai/gpt-oss-120b', ts: Date.now() - 60000 },
      },
    });
    ok('Shows GPT-OSS 120B when Groq active', elsGroq.transEngineText.textContent.includes('GPT-OSS 120B (Groq)'));
    eq('Dot color is vibrant green for Groq', elsGroq.transEngineDot.style.background, '#10a37f');
    ok('Last translation event visible', !elsGroq.transLastEvent.classList.contains('hidden'));
    ok('Last event details mention GPT-OSS 120B', elsGroq.transLastEvent.textContent.includes('GPT-OSS 120B'));
  }

  console.log('\nALL POPUP SIDEBAR AND CONFIGURATION TESTS PASSED');
}

runAll().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
