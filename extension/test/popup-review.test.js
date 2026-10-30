'use strict';

// Popup transliteration review UI interaction tests
//
// Tests the popup DOM behavior for:
// - displaying latestReviewItem
// - approving via 'Correct' button
// - editing spelling via inline editor
// - dismissing review
// - removing an override

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_DIR = path.join(__dirname, '..', 'popup');
const html = fs.readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(POPUP_DIR, 'popup.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

function makeEl(id) {
  const el = {
    id,
    textContent: '',
    innerText: '',
    src: '',
    className: '',
    disabled: false,
    value: '',
    selectedIndex: 0,
    options: [],
    style: {},
    _classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); el.className = [...el._classes].join(' '); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); el.className = [...el._classes].join(' '); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) { if (on === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); } else if (on) el._classes.add(c); else el._classes.delete(c); el.className = [...el._classes].join(' '); },
    },
    addEventListener(ev, fn) { el['_on_' + ev] = fn; },
    appendChild(child) { el.options.push(child); el._lastChild = child; return child; },
    focus() {},
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
  for (const id of ids) els[id] = makeEl(id);
  return { ids, els };
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

async function runPopupWithStorage({ storage, controllerOverrides }) {
  const { ids, els } = buildDom();
  const storeData = Object.assign({}, storage);
  const overrides = Object.assign({}, controllerOverrides || {});
  const fetchCalls = [];

  const fetchStub = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    fetchCalls.push({ url: u, method, body: opts && opts.body });

    if (u.endsWith('/status')) {
      return jsonResponse(200, { state: 'ready', me: { user: 'test' } });
    }
    if (u.endsWith('/channels')) {
      return jsonResponse(200, { channels: [{ id: '123@newsletter', name: 'Channel' }] });
    }
    if (u.endsWith('/version')) {
      return jsonResponse(200, { ok: true, sha: '1234567', branch: 'main' });
    }
    if (u.endsWith('/overrides') && method === 'GET') {
      return jsonResponse(200, { ok: true, version: 1, overrides });
    }
    if ((u.endsWith('/overrides') || u.endsWith('/transliterate/override')) && method === 'POST') {
      const body = JSON.parse(opts.body);
      overrides[body.original.toLowerCase()] = {
        original: body.original,
        transliteration: body.transliteration,
        handle: body.handle,
      };
      return jsonResponse(200, { ok: true, entry: overrides[body.original.toLowerCase()] });
    }
    if ((u.endsWith('/overrides') || u.endsWith('/transliterate/override')) && method === 'DELETE') {
      const body = JSON.parse(opts.body);
      delete overrides[body.original.toLowerCase()];
      return jsonResponse(200, { ok: true, removed: true });
    }
    return jsonResponse(404, {});
  };

  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl('<' + tag + '>'),
    addEventListener: (ev, fn) => { doc['_on_' + ev] = fn; },
  };

  const sandbox = {
    document: doc,
    window: { addEventListener() {} },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    fetch: fetchStub,
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => cb(Object.fromEntries((keys || []).map((k) => [k, storeData[k]]))),
          set: (obj, cb) => { Object.assign(storeData, obj); cb && cb(); },
          remove: (keys, cb) => { (keys || []).forEach((k) => delete storeData[k]); cb && cb(); },
        },
      },
    },
    Buffer,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(popupJs, sandbox);
  await doc._on_DOMContentLoaded();

  return { els, storeData, overrides, fetchCalls };
}

(async () => {
  console.log('\n--- Popup review UI tests ---');

  // 1. Popup opened with no review item in storage
  {
    const { els } = await runPopupWithStorage({ storage: {} });
    check('empty state shown when no review item', els.revEmpty.classList.contains('hidden') === false);
    check('content hidden when no review item', els.revContent.classList.contains('hidden') === true);
    eq('badge shows None', els.revBadge.textContent, 'None');
  }

  // 2. Popup opened with pending generated item
  {
    const initialItem = {
      id: 'rev-1',
      original: 'Reborn',
      handle: '@reborn_x',
      transliteration: 'ری بورن',
      source: 'inputtools',
      timestamp: Date.now(),
      status: 'pending',
    };
    const { els, storeData, overrides } = await runPopupWithStorage({
      storage: { latestReviewItem: initialItem },
      controllerOverrides: {},
    });

    check('content visible', els.revContent.classList.contains('hidden') === false);
    eq('original author displayed', els.revOriginal.textContent, 'Reborn');
    eq('handle displayed', els.revHandle.textContent, '@reborn_x');
    eq('urdu transliteration displayed', els.revUrdu.textContent, 'ری بورن');
    eq('badge shows Google Input Tools', els.revBadge.textContent, 'Google Input Tools');
    check('approve button visible', els.revApproveBtn.classList.contains('hidden') === false);
    check('remove button hidden', els.revRemoveBtn.classList.contains('hidden') === true);

    // Click 'Correct' to approve
    await els.revApproveBtn._on_click();
    check('override was saved to controller', Boolean(overrides['reborn']));
    eq('saved override has correct transliteration', overrides['reborn'].transliteration, 'ری بورن');
    eq('badge flipped to Saved override', els.revBadge.textContent, 'Saved override');
    check('approve button hidden after approval', els.revApproveBtn.classList.contains('hidden') === true);
    check('remove button visible after approval', els.revRemoveBtn.classList.contains('hidden') === false);
  }

  // 3. Popup opened with item, user edits spelling
  {
    const initialItem = {
      id: 'rev-2',
      original: 'Ali',
      handle: null,
      transliteration: 'علی',
      source: 'inputtools',
      timestamp: Date.now(),
      status: 'pending',
    };
    const { els, storeData, overrides } = await runPopupWithStorage({
      storage: { latestReviewItem: initialItem },
      controllerOverrides: {},
    });

    // Click 'Edit spelling'
    els.revEditBtn._on_click();
    check('editor is opened', els.revEditor.classList.contains('hidden') === false);
    eq('editor input prepopulated with current value', els.revInput.value, 'علی');

    // Type a corrected spelling and save
    els.revInput.value = 'علی رضا';
    await els.revSaveBtn._on_click();

    check('editor is closed after save', els.revEditor.classList.contains('hidden') === true);
    eq('displayed text updated', els.revUrdu.textContent, 'علی رضا');
    eq('override updated in controller', overrides['ali'].transliteration, 'علی رضا');
    eq('badge shows Saved override', els.revBadge.textContent, 'Saved override');
  }

  // 4. Popup dismiss action
  {
    const item = {
      id: 'rev-3',
      original: 'Temporary',
      transliteration: 'عارضی',
      source: 'inputtools',
      timestamp: Date.now(),
    };
    const { els, storeData, overrides } = await runPopupWithStorage({
      storage: { latestReviewItem: item },
      controllerOverrides: {},
    });

    await els.revDismissBtn._on_click();
    check('review item removed from storage', storeData.latestReviewItem === undefined);
    check('content hidden after dismiss', els.revContent.classList.contains('hidden') === true);
    check('empty state shown after dismiss', els.revEmpty.classList.contains('hidden') === false);
    check('no override was added to controller dictionary', overrides['temporary'] === undefined);
  }

  // 5. Popup remove override action
  {
    const item = {
      id: 'rev-4',
      original: 'TargetName',
      transliteration: 'ٹارگٹ',
      source: 'override',
      timestamp: Date.now(),
    };
    const { els, overrides } = await runPopupWithStorage({
      storage: { latestReviewItem: item },
      controllerOverrides: { targetname: { original: 'TargetName', transliteration: 'ٹارگٹ' } },
    });

    eq('initially badge is Saved override', els.revBadge.textContent, 'Saved override');
    check('remove button is visible', els.revRemoveBtn.classList.contains('hidden') === false);

    // Click remove
    await els.revRemoveBtn._on_click();
    check('override deleted from controller', overrides['targetname'] === undefined);
    eq('badge reverted to Google Input Tools', els.revBadge.textContent, 'Google Input Tools');
    check('approve button visible again', els.revApproveBtn.classList.contains('hidden') === false);
    check('remove button hidden again', els.revRemoveBtn.classList.contains('hidden') === true);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POPUP REVIEW TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
