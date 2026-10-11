// Popup state-machine tests - zero dependencies.
//
// Loads the real popup.html + popup.js in a minimal DOM harness with a
// stubbed controller, and asserts what the user is shown for every
// connection/authentication state.
//
//   node extension/test/popup-states.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const POPUP_DIR = path.join(__dirname, '..', 'popup');
const html = fs.readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(POPUP_DIR, 'popup.js'), 'utf8');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failures++; console.log(`  FAIL ${name}${extra ? ' -> ' + JSON.stringify(extra) : ''}`); }
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
    selectedIndex: 0,
    options: [],
    naturalWidth: 0,
    naturalHeight: 0,
    _classes: new Set(),
    classList: {
      add(...c) { c.forEach((x) => el._classes.add(x)); el.className = [...el._classes].join(' '); },
      remove(...c) { c.forEach((x) => el._classes.delete(x)); el.className = [...el._classes].join(' '); },
      contains(c) { return el._classes.has(c); },
      toggle(c, on) { if (on === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); } else if (on) el._classes.add(c); else el._classes.delete(c); el.className = [...el._classes].join(' '); },
    },
    addEventListener(ev, fn) { el['_on_' + ev] = fn; },
    appendChild(child) { el.options.push(child); el._lastChild = child; return child; },
    insertBefore(child, ref) {
      const i = el.options.indexOf(ref);
      el.options.splice(i < 0 ? el.options.length : i, 0, child);
      return child;
    },
  };
  // <select> is repopulated via innerHTML='' + appendChild.
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

function runPopup({ status, channels, qr, storage }) {
  const { ids, els } = buildDom();
  const storeData = Object.assign({}, storage);

  const fetchStub = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/status')) {
      if (status === 'UNREACHABLE') throw new Error('connect ECONNREFUSED');
      return jsonResponse(200, typeof status === 'function' ? status() : status);
    }
    if (u.endsWith('/channels')) {
      if (channels === 'ERROR') return jsonResponse(500, { error: 'channel-list-failed' });
      if (channels === 'UNREACHABLE') throw new Error('connect ECONNREFUSED');
      return jsonResponse(200, typeof channels === 'function' ? channels() : channels);
    }
    if (u.endsWith('/auth/qr')) {
      if (!qr) return jsonResponse(404, { error: 'no-qr-available' });
      return jsonResponse(200, qr);
    }
    if (u.endsWith('/auth/logout')) return jsonResponse(200, { ok: true });
    throw new Error('unexpected fetch ' + u);
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
  // The popup refreshes on DOMContentLoaded; that refresh is async, so the
  // caller awaits it before asserting what the user would see.
  const ready = Promise.resolve(doc._on_DOMContentLoaded());
  return { els, store: storeData, ready, fire: (id, ev) => els[id][`_on_${ev}`]({ target: els[id], preventDefault() {} }) };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const txt = (els, id) => els[id].textContent.trim();
const shown = (els, id) => !els[id].classList.contains('hidden');
const wait = () => new Promise((r) => setTimeout(r, 30));

(async () => {
  // 1. Controller unavailable
  console.log('state: controller unavailable');
  {
    const { els, ready } = runPopup({ status: 'UNREACHABLE', channels: 'UNREACHABLE' });
    await ready;
    check('title says controller not running', /Controller not running/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check('dot is error', els.waDot.className.includes('err'));
    check('offers retry', /Retry/i.test(txt(els, 'checkBtn')), txt(els, 'checkBtn'));
    check('authenticate hidden', !shown(els, 'connectBtn'));
    check('channels disabled', els.channelSelect.disabled === true);
    check('footer shows offline', /offline/i.test(txt(els, 'footState')), txt(els, 'footState'));
    check('no QR shown', !shown(els, 'qrCard'));
  }

  // 2. Controller starting / WhatsApp connecting
  for (const st of ['starting', 'authenticated']) {
    console.log(`state: ${st} (connecting)`);
    const { els, ready } = runPopup({ status: { state: st }, channels: 'UNREACHABLE' });
    await ready;
    check(`[${st}] connecting title`, /Connecting to WhatsApp/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check(`[${st}] busy dot`, els.waDot.className.includes('busy'));
    check(`[${st}] not shown as connected`, !/Connected/.test(txt(els, 'waTitle')));
    check(`[${st}] channels disabled`, els.channelSelect.disabled === true);
  }

  // 3. Authentication required + QR ready
  console.log('state: qr (authentication required, QR ready)');
  {
    const { els, ready } = runPopup({
      status: { state: 'qr', sessionDir: '/tmp/s' },
      channels: 'UNREACHABLE',
      qr: { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    });
    await ready;
    check('auth required title', /Authentication required/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check('QR card visible', shown(els, 'qrCard'));
    check('QR image set from controller', els.qrImg.src.startsWith('data:image/svg+xml'), els.qrImg.src.slice(0, 24));
    check('scan instructions present', /Linked Devices/i.test(html));
    check('channels disabled', els.channelSelect.disabled === true);
  }

  // 4. Connected with eligible channels + saved selection kept
  console.log('state: connected (saved channel still eligible)');
  {
    const { els, store, ready } = runPopup({
      status: { state: 'ready', me: { _serialized: '923124706501@c.us' } },
      channels: { channels: [{ id: 'A@newsletter', name: 'Test', role: 'owner' }], checked: 1, ineligible: [] },
      storage: { selectedChannelId: 'A@newsletter', selectedChannelName: 'Test' },
    });
    await ready;
    check('connected title', txt(els, 'waTitle') === 'Connected', txt(els, 'waTitle'));
    check('green dot', els.waDot.className.includes('on'));
    check('account shown', /923124706501/.test(txt(els, 'waDetail')), txt(els, 'waDetail'));
    check('channel selector enabled', els.channelSelect.disabled === false);
    check('saved channel kept', store.selectedChannelId === 'A@newsletter', store);
    check('confirms saved channel', /saved channel/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('disconnect available', els.disconnectBtn.disabled === false);
  }

  // 5. Connected but saved channel no longer eligible -> cleared + explained
  console.log('state: connected (saved channel no longer eligible)');
  {
    const { els, store, ready } = runPopup({
      status: { state: 'ready', me: { _serialized: '923124706501@c.us' } },
      channels: { channels: [{ id: 'B@newsletter', name: 'Other', role: 'admin' }], checked: 2, ineligible: [{ id: 'A@newsletter', name: 'Test', role: 'subscriber' }] },
      storage: { selectedChannelId: 'A@newsletter', selectedChannelName: 'Test' },
    });
    await ready;
    check('stale selection cleared', store.selectedChannelId === undefined, store);
    check('explains why', /no longer one this account can post to/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('still offers the eligible channel', els.channelSelect.options.some((o) => o.value === 'B@newsletter'));
  }

  // 6. Connected, no eligible channels at all
  console.log('state: connected (no eligible channels)');
  {
    const { els, store, ready } = runPopup({
      status: { state: 'ready', me: { _serialized: '923124706501@c.us' } },
      channels: { channels: [], checked: 2, ineligible: [{ id: 'A@newsletter', role: 'subscriber' }] },
      storage: { selectedChannelId: 'A@newsletter' },
    });
    await ready;
    check('says no eligible channels', /No channels found/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('also reports the cleared selection', /saved earlier was cleared/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('selector disabled', els.channelSelect.disabled === true);
    check('stale selection cleared', store.selectedChannelId === undefined, store);
  }

  // 7. Connected, channels endpoint fails -> recoverable error
  console.log('state: connected (channel load failed)');
  {
    const { els, ready } = runPopup({
      status: { state: 'ready', me: { _serialized: '923124706501@c.us' } },
      channels: 'ERROR',
    });
    await ready;
    check('recoverable error message', /could not be read from WhatsApp/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('reload offered', els.refreshBtn.disabled === false);
  }

  // 7b. Signed out (auth_required): must offer re-pairing, not a dead end
  console.log('state: auth_required (signed out)');
  {
    const { els, ready } = runPopup({
      status: { state: 'auth_required', authRequired: true },
      channels: 'UNREACHABLE',
      qr: { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    });
    await ready;
    check('explains it was signed out', /signed out/i.test(txt(els, 'waDetail')), txt(els, 'waDetail'));
    check('offers authenticate again', shown(els, 'connectBtn') && /Authenticate/i.test(txt(els, 'connectBtn')), txt(els, 'connectBtn'));
    check('QR shown for re-pairing', shown(els, 'qrCard'));
    check('channels disabled until paired', els.channelSelect.disabled === true);
    check('not stuck on "Checking…"', txt(els, 'waTitle') !== 'Checking…', txt(els, 'waTitle'));
  }

  // 7c. Reconnecting (typical right after waking from sleep): must NOT tell the
// user to press a button, since recovery is automatic.
  console.log('state: reconnecting (after sleep)');
  {
    const { els, ready } = runPopup({ status: { state: 'reconnecting' }, channels: 'UNREACHABLE' });
    await ready;
    check('says reconnecting', /Reconnecting to WhatsApp/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check('mentions sleep/dropped connection', /sleep|dropped/i.test(txt(els, 'waDetail')), txt(els, 'waDetail'));
    check('busy indicator', els.waDot.className.includes('busy'));
    check('does not demand "Press Reload channels"', !/Press .Reload channels/i.test(txt(els, 'waTitle') + txt(els, 'waDetail') + txt(els, 'channelNote')));
    check('channel note says it retries itself', /automatic/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('channels disabled while reconnecting', els.channelSelect.disabled === true);
  }

  // 7d. Connected but the channel listing fails: message must not blame the
  // user for something the controller recovers from on its own.
  console.log('state: ready but channel listing fails');
  {
    const { els, ready } = runPopup({
      status: { state: 'ready', me: { _serialized: '1@c.us' } },
      channels: 'ERROR',
    });
    await ready;
    check('no "Press Reload channels" prompt', !/Press .Reload channels/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
    check('says it retries automatically', /retrying automatically/i.test(txt(els, 'channelNote')), txt(els, 'channelNote'));
  }

  // 8. Auth failure
  console.log('state: authentication failed');
  {
    const { els, ready } = runPopup({ status: { state: 'auth_failure' }, channels: 'UNREACHABLE' });
    await ready;
    check('auth failure title', /Authentication failed/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check('offers re-authenticate', shown(els, 'connectBtn'));
    check('recovery text', /new code/i.test(txt(els, 'waDetail')), txt(els, 'waDetail'));
  }

  // 9. Disconnected / stopped
  for (const st of ['disconnected', 'stopped']) {
    console.log(`state: ${st}`);
    const { els, ready } = runPopup({ status: { state: st }, channels: 'UNREACHABLE' });
    await ready;
    check(`[${st}] disconnected title`, /disconnected/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check(`[${st}] reconnect offered`, shown(els, 'connectBtn') && /Reconnect/i.test(txt(els, 'connectBtn')), txt(els, 'connectBtn'));
  }

  // 10. Controller error
  console.log('state: controller error');
  {
    const { els, ready } = runPopup({ status: { state: 'error' }, channels: 'UNREACHABLE' });
    await ready;
    check('error title', /Controller error/i.test(txt(els, 'waTitle')), txt(els, 'waTitle'));
    check('recovery hint', /controller log/i.test(txt(els, 'waDetail')), txt(els, 'waDetail'));
  }

  // 11. Never shows Connected when the controller merely answers
  console.log('guard: connected must reflect real WhatsApp state');
  {
    const { els, ready } = runPopup({ status: { state: 'starting' }, channels: { channels: [{ id: 'A@newsletter', name: 'Test' }] } });
    await ready;
    check('not "Connected" while starting', txt(els, 'waTitle') !== 'Connected', txt(els, 'waTitle'));
  }

  // 12. Disconnect requires a confirmation step
  console.log('disconnect: confirmation required');
  {
    const ctx = runPopup({
      status: { state: 'ready', me: { _serialized: '1@c.us' } },
      channels: { channels: [{ id: 'A@newsletter', name: 'Test' }] },
    });
    await ctx.ready;
    ctx.fire('disconnectBtn', 'click');
    check('first click asks to confirm', /Confirm/i.test(txt(ctx.els, 'disconnectBtn')), txt(ctx.els, 'disconnectBtn'));
    check('warns about new QR', /new QR scan/i.test(txt(ctx.els, 'channelNote')), txt(ctx.els, 'channelNote'));
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL POPUP STATE TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();