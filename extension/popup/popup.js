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
  verCard: el('versionCard'), verDot: el('verDot'), verTitle: el('verTitle'),
  verDetail: el('verDetail'), verNote: el('verNote'),
  checkUpd: el('checkUpdBtn'), update: el('updateBtn'),
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
  // Local and cheap: safe to ask on every tick, unlike a network fetch.
  renderVersion(await versionStatus());

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

// ---------------------------------------------------------------- version
// Whether this checkout still matches the remote, and a way to bring it
// forward. Reading the status is local and cheap, so it can ride along with
// every refresh; only "Check for updates" goes to the network.
let updateArmed = false;

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function setVer(dotClass, title, detail) {
  ui.verDot.className = `dot ${dotClass}`;
  ui.verTitle.textContent = title;
  ui.verDetail.textContent = detail || '';
  ui.verDetail.classList.toggle('hidden', !detail);
}

function renderVersion(v) {
  if (!v) {
    setVer('', 'Version unknown', '');
    ui.checkUpd.disabled = true;
    ui.update.classList.add('hidden');
    return;
  }
  if (v.ok === false && v.error === 'not-a-repo') {
    setVer('err', 'Not a git checkout', 'The controller could not find the project files.');
    ui.checkUpd.disabled = true;
    ui.update.classList.add('hidden');
    return;
  }

  const where = `${v.branch || '?'} · ${(v.sha || '?').slice(0, 7)}`;
  const checked = v.checkedAt ? ` · checked ${ago(v.checkedAt)}` : '';

  ui.update.classList.toggle('hidden', !(Number(v.behind) > 0));
  ui.update.disabled = false;
  ui.checkUpd.disabled = false;

  if (v.dirty) {
    // Uncommitted work: say so plainly, and do not offer an update that
    // would be refused anyway.
    setVer('wait', 'Local changes', `${where} · not committed`);
    setNote(ui.verNote,
      'You have uncommitted changes, so updating is not offered — the update would be refused rather than touching your work.',
      'warn');
    return;
  }
  if (v.behind === null || v.behind === undefined) {
    setVer('', 'Update status unknown', where + checked);
    if (v.checkFailed === 'unreachable') {
      setNote(ui.verNote, 'The remote could not be reached; showing the last known result.', 'warn');
    } else if (!v.upstream) {
      setNote(ui.verNote, 'This checkout has no upstream branch to compare with.', 'warn');
    } else {
      setNote(ui.verNote, 'Press Check for updates to ask the remote.', 'idle');
    }
    return;
  }
  if (Number(v.behind) > 0) {
    setVer('wait', `${v.behind} update${v.behind === 1 ? '' : 's'} available`, where + checked);
    setNote(ui.verNote, 'Updates fast-forward this checkout to the latest commit on the remote.', 'idle');
    return;
  }
  if (Number(v.ahead) > 0) {
    setVer('', `${v.ahead} local commit${Number(v.ahead) === 1 ? '' : 's'} ahead`, where + checked);
    setNote(ui.verNote, 'Your checkout has commits the remote has not seen.', 'idle');
    return;
  }
  setVer('on', 'Up to date', where + checked);
  setNote(ui.verNote, '', 'idle');
}

async function versionStatus() {
  try {
    const r = await req('/version');
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

function disarmUpdate() {
  updateArmed = false;
  ui.update.textContent = 'Update now';
  ui.update.classList.remove('confirm');
}

ui.checkUpd.addEventListener('click', async () => {
  ui.checkUpd.disabled = true;
  setVer('busy', 'Checking…', '');
  setNote(ui.verNote, 'Asking the remote what it has.', 'idle');
  try {
    const r = await req('/version/check', { method: 'POST' });
    renderVersion(r.ok ? r.body : null);
  } catch {
    renderVersion(null);
    setNote(ui.verNote, 'Lost contact with the controller.', 'error');
  }
  ui.checkUpd.disabled = false;
});

ui.update.addEventListener('click', async () => {
  if (!updateArmed) {
    updateArmed = true;
    ui.update.textContent = 'Confirm update';
    ui.update.classList.add('confirm');
    setNote(ui.verNote,
      'This fast-forwards your checkout to the latest commit on the remote. Uncommitted changes are never touched.',
      'warn');
    setTimeout(disarmUpdate, 6000);
    return;
  }
  disarmUpdate();
  ui.update.disabled = true;
  ui.checkUpd.disabled = true;
  setVer('busy', 'Updating…', '');
  setNote(ui.verNote, 'Fast-forwarding to the latest commit.', 'idle');

  let r;
  try { r = await req('/update', { method: 'POST' }); }
  catch {
    ui.update.disabled = false; ui.checkUpd.disabled = false;
    setVer('err', 'Update failed', '');
    setNote(ui.verNote, 'Lost contact with the controller.', 'error');
    return;
  }

  const body = r.body || {};
  if (!r.ok) {
    ui.update.disabled = false; ui.checkUpd.disabled = false;
    if (body.error === 'local-changes') {
      setVer('err', 'Update refused', 'You have uncommitted changes.');
      setNote(ui.verNote, 'Commit or stash your work first — the update will not touch it.', 'warn');
    } else {
      setVer('err', 'Update failed', '');
      setNote(ui.verNote, body.detail || body.error || 'The update could not be applied.', 'error');
    }
    return;
  }

  if (!body.updated) {
    ui.update.disabled = false; ui.checkUpd.disabled = false;
    setVer('on', 'Up to date', '');
    setNote(ui.verNote, 'Already on the latest commit.', 'ok');
    return;
  }

  // Reloading closes the popup, so leave the result where it can be read
  // next time it opens.
  const message = `Updated ${body.from} → ${body.to}${body.restartController ? '. The controller is restarting.' : ''}`;
  await store.set({ updateNotice: { text: message, at: Date.now(), reloadExtension: Boolean(body.reloadExtension) } });
  setVer('on', 'Updated', `${body.to.slice(0, 7)}`);
  setNote(ui.verNote, message, 'ok');

  if (body.reloadExtension) {
    // The extension on disk changed, but the running copy is the old one
    // until it is reloaded.
    setTimeout(() => chrome.runtime.reload(), 900);
  }
});

// Shown once, on the next open, so a reload cannot swallow the result.
(async () => {
  const { updateNotice } = await store.get(['updateNotice']);
  if (!updateNotice) return;
  await store.remove(['updateNotice']);
  setNote(ui.verNote, updateNotice.text + (updateNotice.reloadExtension ? ' The extension was reloaded.' : ''), 'ok');
})();

document.addEventListener('DOMContentLoaded', refresh);
// Re-check while the popup is open so "Connecting…" resolves on its own.
let timer = setInterval(refresh, 2000);
window.addEventListener('unload', () => clearInterval(timer));