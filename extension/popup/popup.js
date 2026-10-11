// Popup state machine.
//
// The popup never infers "Connected" from an HTTP 200: the controller
// reports the real WhatsApp state and that alone drives the UI.
const CONTROLLER = 'http://127.0.0.1:47825';

const el = (id) => document.getElementById(id);
const ui = {
  dot: el('waDot'), title: el('waTitle'), detail: el('waDetail'),
  actions: el('waActions'), connect: el('connectBtn'), check: el('checkBtn'),
  qrCard: el('qrCard'), qrImg: el('qrImg'), qrNote: el('qrNote'),
  select: el('channelSelect'), channelNote: el('channelNote'),
  refresh: el('refreshBtn'), disconnect: el('disconnectBtn'),
  foot: el('footState'),
};

const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  remove: (keys) => new Promise((r) => chrome.storage.local.remove(keys, r)),
};

// ---------------------------------------------------------------- helpers
async function req(path, opts) {
  const res = await fetch(`${CONTROLLER}${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, body };
}

// Thrown when the controller itself is not reachable - the one failure the
// extension cannot fix by itself.
class Unreachable extends Error {}

async function status() {
  try {
    const r = await req('/status');
    if (!r.ok || !r.body) return { state: 'unavailable' };
    return r.body;
  } catch {
    return { state: 'unavailable' };
  }
}

function setNote(node, text, kind) {
  node.textContent = text || '';
  node.className = `note ${kind || 'idle'}`;
}

function setStatus(dotClass, title, detail) {
  ui.dot.className = `dot ${dotClass}`;
  ui.title.textContent = title;
  ui.detail.textContent = detail || '';
  ui.detail.classList.toggle('hidden', !detail);
}

// ------------------------------------------------------------ QR handling
// The controller renders the pairing QR as an image and hands over a
// data URL, so the scannable payload itself never reaches the extension,
// a log file, or any general-purpose endpoint.
async function showQr() {
  try {
    const res = await fetch(`${CONTROLLER}/auth/qr`);
    if (!res.ok) {
      ui.qrCard.classList.add('hidden');
      return false;
    }
    const { image } = await res.json();
    if (!image) { ui.qrCard.classList.add('hidden'); return false; }
    ui.qrImg.src = image;
    ui.qrCard.classList.remove('hidden');
    setNote(ui.qrNote, 'Waiting for the scan to complete…', 'idle');
    return true;
  } catch {
    ui.qrCard.classList.add('hidden');
    return false;
  }
}

function hideQr() { ui.qrCard.classList.add('hidden'); }

// -------------------------------------------------------------- channels
function renderChannels(channels, selectedId) {
  ui.select.innerHTML = '';
  ui.select.disabled = channels.length === 0;

  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = channels.length ? 'Choose a channel…' : 'No eligible channels';
  ui.select.appendChild(ph);

  let kept = false;
  for (const ch of channels) {
    const o = document.createElement('option');
    o.value = ch.id;
    o.textContent = ch.name || ch.id;
    if (ch.id === selectedId) { o.selected = true; kept = true; }
    ui.select.appendChild(o);
  }
  return kept;
}

ui.select.addEventListener('change', async () => {
  const id = ui.select.value;
  if (!id) {
    await store.remove(['selectedChannelId', 'selectedChannelName']);
    setNote(ui.channelNote, 'Choose the channel that posts should go to.', 'idle');
    return;
  }
  const name = ui.select.options[ui.select.selectedIndex].textContent;
  await store.set({ selectedChannelId: id, selectedChannelName: name });
  setNote(ui.channelNote, `Posts will go to “${name}”.`, 'ok');
});

// Disconnect asks for confirmation because it invalidates the saved
// session and forces a fresh QR scan next time.
let confirmArmed = false;
ui.disconnect.addEventListener('click', async () => {
  if (!confirmArmed) {
    confirmArmed = true;
    ui.disconnect.textContent = 'Confirm disconnect';
    ui.disconnect.classList.add('confirm');
    setNote(ui.channelNote, 'This signs out WhatsApp on this computer. The next start needs a new QR scan.', 'warn');
    setTimeout(() => {
      confirmArmed = false;
      ui.disconnect.textContent = 'Disconnect';
      ui.disconnect.classList.remove('confirm');
    }, 6000);
    return;
  }
  confirmArmed = false;
  ui.disconnect.textContent = 'Disconnect';
  ui.disconnect.classList.remove('confirm');
  ui.disconnect.disabled = true;
  setNote(ui.channelNote, 'Disconnecting…', 'idle');
  try {
    await req('/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    setNote(ui.channelNote, 'Disconnected. Authenticate again when you are ready.', 'warn');
    hideQr();
    await refresh();
  } catch {
    setNote(ui.channelNote, 'Could not reach the controller to disconnect.', 'error');
  }
});

ui.refresh.addEventListener('click', () => refresh());
ui.check.addEventListener('click', () => refresh());
ui.connect.addEventListener('click', async () => {
  ui.connect.disabled = true;
  setStatus('busy', 'Waiting for authentication…', '');
  // Starts (or reuses) the client and asks for a fresh QR.
  try { await req('/auth/start', { method: 'POST' }); } catch { /* may already be running */ }
  await showQr();
  // The controller reuses the saved session when it is still valid, so
  // poll briefly: a valid session goes straight to connected.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await refresh();
    if (document.getElementById('waDot').classList.contains('on')) break;
  }
});

// --------------------------------------------------------------- refresh
async function refresh() {
  const s = await status();

  if (s.state === 'unavailable') {
    hideQr();
    setStatus('err', 'Controller not running',
      'The local controller is not reachable on 127.0.0.1:47825. It normally starts with your user session — if it does not, start it and press Refresh.');
    ui.connect.classList.add('hidden');
    ui.check.textContent = 'Retry';
    ui.select.disabled = true;
    ui.refresh.disabled = true;
    ui.disconnect.disabled = true;
    setNote(ui.channelNote, 'Channels are unavailable until the controller runs.', 'idle');
    ui.foot.textContent = 'Controller: offline';
    return;
  }

  ui.check.textContent = 'Refresh status';
  ui.foot.textContent = `Controller: ${s.state}${s.me ? ' · ' + (s.me.user || s.me._serialized || '') : ''}`;

  switch (s.state) {
    case 'starting':
    case 'authenticated':
      hideQr();
      setStatus('busy', 'Connecting to WhatsApp…', 'Restoring your saved session.');
      ui.connect.classList.add('hidden');
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = true;
      setNote(ui.channelNote, 'Channels load once the connection is ready.', 'idle');
      return;

    case 'reconnecting':
      // Usually just after the machine woke from sleep: the WhatsApp page
      // was suspended and the controller is rebuilding it from the saved
      // session. No user action needed - it retries on its own.
      hideQr();
      setStatus('busy', 'Reconnecting to WhatsApp…', 'This can happen after sleep or a dropped connection. Retrying automatically.');
      ui.connect.classList.add('hidden');
      ui.select.disabled = true; ui.refresh.disabled = false; ui.disconnect.disabled = false;
      setNote(ui.channelNote, 'Retrying automatically — channels reappear as soon as the connection is back.', 'idle');
      return;

    case 'auth_required':
      // Signed out (or never paired): offer to start pairing again rather
      // than leaving the user on a dead end.
      setStatus('wait', 'Not linked to WhatsApp', 'This computer was signed out. Authenticate again to link the dedicated account.');
      ui.connect.classList.remove('hidden');
      ui.connect.textContent = 'Authenticate WhatsApp';
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = false;
      setNote(ui.channelNote, 'Scanning a new code is required before posting can resume.', 'idle');
      await showQr();
      return;

    case 'qr':
      setStatus('wait', 'Authentication required', 'This computer is not linked to the dedicated WhatsApp account yet.');
      ui.connect.classList.add('hidden');
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = true;
      setNote(ui.channelNote, 'Scan the code to finish linking.', 'idle');
      await showQr();
      return;

    case 'auth_failure':
      hideQr();
      setStatus('err', 'Authentication failed', 'The saved session was rejected. Scan a new code to link again.');
      ui.connect.classList.remove('hidden');
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = false;
      setNote(ui.channelNote, '', 'idle');
      return;

    case 'disconnected':
    case 'stopped':
      hideQr();
      setStatus('err', 'WhatsApp disconnected', 'Reconnect with the dedicated account to continue.');
      ui.connect.classList.remove('hidden');
      ui.connect.textContent = 'Reconnect WhatsApp';
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = false;
      setNote(ui.channelNote, '', 'idle');
      return;

    case 'error':
      hideQr();
      setStatus('err', 'Controller error', 'Something went wrong while connecting. Check the controller log, then retry.');
      ui.connect.classList.remove('hidden');
      ui.select.disabled = true; ui.refresh.disabled = true; ui.disconnect.disabled = false;
      setNote(ui.channelNote, '', 'idle');
      return;

    case 'ready': {
      hideQr();
      ui.connect.classList.add('hidden');
      ui.connect.textContent = 'Authenticate WhatsApp';
      setStatus('on', 'Connected', 'Signed in as ' + ((s.me && (s.me.user || s.me._serialized)) || 'dedicated account'));
      ui.select.disabled = false;
      ui.refresh.disabled = false;
      ui.disconnect.disabled = false;
      setNote(ui.channelNote, 'Loading channels…', 'idle');

      let channels = [];
      let warning = null;
      try {
        const r = await req('/channels');
        if (!r.ok) {
          // The endpoint answers with the real reason; show that rather
          // than a generic "try again" that blames the wrong thing.
          const why = (r.body && r.body.error) || 'unknown';
          setNote(ui.channelNote, r.status === 409
            ? 'The WhatsApp connection is not ready yet — retrying automatically.'
            : 'Channels could not be read from WhatsApp right now — retrying automatically.', 'warn');
          void why;
          return;
        }
        channels = r.body.channels || [];
        warning = r.body.warning || null;
      } catch {
        setNote(ui.channelNote, 'Lost contact with the controller — retrying automatically.', 'warn');
        return;
      }

      const { selectedChannelId } = await store.get(['selectedChannelId']);
      const kept = renderChannels(channels, selectedChannelId);

      if (channels.length === 0) {
        if (selectedChannelId) {
          // Both facts matter: nothing is postable *and* the old pick is gone.
          await store.remove(['selectedChannelId', 'selectedChannelName']);
          setNote(ui.channelNote,
            'No channels found that this account can post to, so the channel saved earlier was cleared. Create a channel in WhatsApp or make this account an admin, then reload.',
            'warn');
        } else {
          setNote(ui.channelNote,
            'No channels found that this account can post to. Create one in WhatsApp → Channels, or make this account an admin, then reload.',
            'warn');
        }
      } else if (!kept && selectedChannelId) {
        await store.remove(['selectedChannelId', 'selectedChannelName']);
        setNote(ui.channelNote,
          'The channel saved earlier is no longer one this account can post to, so it was cleared. Choose another one.',
          'warn');
      } else if (warning) {
        setNote(ui.channelNote, warning, 'warn');
      } else if (selectedChannelId) {
        setNote(ui.channelNote, 'Using your saved channel. Posts will go there automatically.', 'ok');
      } else {
        setNote(ui.channelNote, 'Choose the channel that posts should go to.', 'idle');
      }
      return;
    }

    default:
      setStatus('wait', 'Checking…', '');
      return;
  }
}

document.addEventListener('DOMContentLoaded', refresh);
// Re-check while the popup is open so "Connecting…" resolves on its own.
let timer = setInterval(refresh, 2000);
window.addEventListener('unload', () => clearInterval(timer));