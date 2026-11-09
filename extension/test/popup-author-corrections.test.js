// Tests for Author Name Correction Manager UI in popup - zero dependencies.
//
//   node extension/test/popup-author-corrections.test.js
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
    value: '',
    className: '',
    disabled: false,
    dataset: {},
    dir: 'ltr',
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
    appendChild(child) {
      if (!el.children) el.children = [];
      el.children.push(child);
      return child;
    },
    click() { if (el._on_click) return el._on_click({ target: el, preventDefault() {} }); },
    focus() {},
    select() {},
  };
  let _textContent = undefined;
  Object.defineProperty(el, 'textContent', {
    get: () => {
      if (_textContent !== undefined) return _textContent;
      if (el.children && el.children.length > 0) {
        return el.children.map((c) => c.textContent).join(' ');
      }
      return '';
    },
    set: (v) => { _textContent = v; },
  });
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => _html,
    set: (v) => { _html = v; if (v === '') el.children = []; },
  });
  return el;
}

function buildDom() {
  const tagRegex = /<([a-z0-9]+)\b([^>]*)>/gi;
  const els = {};
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    const attrs = m[2];
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    if (idMatch) {
      const id = idMatch[1];
      const el = makeEl(id);
      const classMatch = attrs.match(/\bclass="([^"]+)"/);
      if (classMatch) {
        classMatch[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      }
      els[id] = el;
    }
  }
  return { els };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function runPopupHarness(initialStorage = {}, initialCorrections = []) {
  const { els } = buildDom();
  const storeData = Object.assign({}, initialStorage);
  const calls = [];
  const corrections = [...initialCorrections];

  const fetchStub = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });

    if (u.endsWith('/status')) {
      return jsonResponse(200, { state: 'ready', me: { _serialized: '923000000000@c.us' } });
    }
    if (u.endsWith('/version')) {
      return jsonResponse(200, { ok: true, branch: 'main', sha: '1234567', dirty: false });
    }
    if (u.endsWith('/groq/config')) {
      return jsonResponse(200, { configured: true, model: 'openai/gpt-oss-120b' });
    }
    if (u.endsWith('/channels')) {
      return jsonResponse(200, { channels: [{ id: 'ch1', name: 'Channel 1', role: 'owner' }] });
    }
    if (u.endsWith('/author-corrections')) {
      if (method === 'GET') {
        return jsonResponse(200, { ok: true, corrections });
      }
      if (method === 'POST') {
        const existingIdx = corrections.findIndex((c) => c.handle === body.handle);
        const entry = {
          handle: body.handle,
          urduName: body.urduName,
          originalName: body.originalName || '',
          updatedAt: Date.now(),
        };
        if (existingIdx >= 0) corrections[existingIdx] = entry;
        else corrections.push(entry);
        return jsonResponse(200, { ok: true, count: corrections.length, correction: entry });
      }
      if (method === 'DELETE') {
        const idx = corrections.findIndex((c) => c.handle === body.handle);
        if (idx >= 0) corrections.splice(idx, 1);
        return jsonResponse(200, { ok: true, deleted: idx >= 0, count: corrections.length });
      }
    }
    return jsonResponse(404, { error: 'not-found' });
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
    setTimeout: (fn, ms) => { if (ms && ms > 500) return 0; return fn(); },
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
  return { els, store: storeData, calls, corrections };
}

(async () => {
  console.log('1. Author Name Correction UI elements initialization');
  {
    const { els } = await runPopupHarness();
    check('correctAuthorBtn exists', Boolean(els.correctAuthorBtn));
    check('authorCorrectionForm exists and is hidden initially', els.authorCorrectionForm && els.authorCorrectionForm.classList.contains('hidden'));
    check('corrUrduInput exists', Boolean(els.corrUrduInput));
    check('corrSaveBtn exists', Boolean(els.corrSaveBtn));
    check('corrCancelBtn exists', Boolean(els.corrCancelBtn));
    check('correctionsCard exists', Boolean(els.correctionsCard));
    check('corrCountBadge shows 0 saved initially', els.corrCountBadge.textContent.includes('0 saved'));
  }

  console.log('\n2. Quick Correction Form Prefilling from latestTranslation');
  {
    const latestTranslation = {
      author: 'Alex Ferguson',
      handle: '@alex_ferguson',
      translatedAuthor: 'ایلکس فرگوسن غلط',
      timestamp: Date.now(),
    };
    const { els } = await runPopupHarness({ latestTranslation });

    // Click "Correct Author Name" button
    await els.correctAuthorBtn.click();

    check('authorCorrectionForm is now unhidden', !els.authorCorrectionForm.classList.contains('hidden'));
    eq('corrAuthorDisplay has author name', els.corrAuthorDisplay.textContent, 'Alex Ferguson');
    eq('corrAuthorHandle has handle', els.corrAuthorHandle.textContent, '@alex_ferguson');
    eq('corrLatestTranslated has translated name', els.corrLatestTranslated.textContent, 'ایلکس فرگوسن غلط');
    eq('corrUrduInput is prefilled with translated name', els.corrUrduInput.value, 'ایلکس فرگوسن غلط');
    eq('dataset.handle is set', els.authorCorrectionForm.dataset.handle, '@alex_ferguson');

    // Click Cancel hides form
    await els.corrCancelBtn.click();
    check('form is hidden after cancel', els.authorCorrectionForm.classList.contains('hidden'));
  }

  console.log('\n3. Saving Correction updates controller and storage');
  {
    const latestTranslation = {
      author: 'Alex Ferguson',
      handle: '@alex_ferguson',
      translatedAuthor: 'ایلکس فرگوسن غلط',
      timestamp: Date.now(),
    };
    const { els, store, calls, corrections } = await runPopupHarness({ latestTranslation });

    // Open form
    await els.correctAuthorBtn.click();

    // Type preferred Urdu spelling
    els.corrUrduInput.value = 'ایلکس فرگوسن درست';

    // Click Save
    await els.corrSaveBtn.click();

    // Verify POST was made
    const postCall = calls.find((c) => c.url.endsWith('/author-corrections') && c.method === 'POST');
    check('POST /author-corrections called', Boolean(postCall));
    eq('POST handle is @alex_ferguson', postCall.body.handle, '@alex_ferguson');
    eq('POST urduName is preferred spelling', postCall.body.urduName, 'ایلکس فرگوسن درست');
    eq('POST originalName is Alex Ferguson', postCall.body.originalName, 'Alex Ferguson');

    // Success note displayed
    check('Success note displayed', els.corrNote.textContent.includes('Saved! Future tweets from @alex_ferguson will use'));

    // Cached latestTranslation updated in storage
    eq('storage latestTranslation updated', store.latestTranslation && store.latestTranslation.translatedAuthor, 'ایلکس فرگوسن درست');

    // Badge updated
    check('Count badge updated to 1 saved', els.corrCountBadge.textContent.includes('1 saved'));
    eq('corrections array has 1 item', corrections.length, 1);
  }

  console.log('\n4. Corrections List Management (render, edit, delete)');
  {
    const existingCorrections = [
      {
        handle: '@imran_khan',
        urduName: 'عمران خان',
        originalName: 'Imran Khan',
        updatedAt: Date.now(),
      },
    ];

    const { els, calls, corrections } = await runPopupHarness({}, existingCorrections);

    check('Count badge shows 1 saved', els.corrCountBadge.textContent.includes('1 saved'));
    check('Empty state hidden', els.correctionsEmpty.classList.contains('hidden'));
    check('correctionsList has children rendered', els.correctionsList.children && els.correctionsList.children.length === 1);

    const row = els.correctionsList.children[0];
    const textContent = row.children.map((c) => c.textContent || '').join(' ');
    check('Row displays handle @imran_khan', textContent.includes('@imran_khan'));
    check('Row displays Urdu spelling عمران خان', textContent.includes('عمران خان'));
    check('Row displays original name Imran Khan', textContent.includes('Imran Khan'));

    // Find Delete button in row actions
    const actionsDiv = row.children[1];
    const delBtn = actionsDiv && actionsDiv.children && actionsDiv.children.find((b) => b.textContent === 'Delete');
    check('Delete button exists in row', Boolean(delBtn));

    // Click Delete
    await delBtn.click();

    const deleteCall = calls.find((c) => c.url.endsWith('/author-corrections') && c.method === 'DELETE');
    check('DELETE /author-corrections called', Boolean(deleteCall));
    eq('DELETE handle is @imran_khan', deleteCall.body.handle, '@imran_khan');
    eq('Corrections list now empty', corrections.length, 0);
    check('Count badge shows 0 saved after delete', els.corrCountBadge.textContent.includes('0 saved'));
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  } else {
    console.log('\nALL POPUP AUTHOR CORRECTIONS TESTS PASSED');
  }
})();
