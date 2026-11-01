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
  pull: el('updateBtn'), push: el('pushBtn'), sync: el('syncBtn'),
  // Author name transliteration review
  revCard: el('reviewCard'), revBadge: el('revBadge'), revContent: el('revContent'),
  revOriginal: el('revOriginal'), revHandle: el('revHandle'), revUrdu: el('revUrdu'),
  revApprove: el('revApproveBtn'), revEdit: el('revEditBtn'), revRemove: el('revRemoveBtn'),
  revDismiss: el('revDismissBtn'), revEditor: el('revEditor'), revInput: el('revInput'),
  revSave: el('revSaveBtn'), revCancel: el('revCancelBtn'), revNote: el('revNote'),
  revEmpty: el('revEmpty'),
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

ui.refresh.addEventListener('click', async () => {
  ui.refresh.disabled = true;
  const original = ui.refresh.textContent;
  ui.refresh.textContent = 'Reloading…';
  await refresh();
  ui.refresh.disabled = false;
  ui.refresh.textContent = original;
});
ui.check.addEventListener('click', async () => {
  ui.check.disabled = true;
  const isRetry = ui.check.textContent === 'Retry';
  ui.check.textContent = isRetry ? 'Connecting…' : 'Checking…';
  setStatus('busy', isRetry ? 'Connecting to controller…' : 'Checking connection…', 'Attempting to reach local controller on 127.0.0.1:47825…');
  await new Promise((r) => setTimeout(r, 400));
  await refresh();
  ui.check.disabled = false;
});
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

function setBadge(text, kind) {
  if (!ui.revBadge) return;
  ui.revBadge.textContent = text || '';
  ui.revBadge.className = `badge ${kind || 'idle'}`;
  if (ui.revBadge.style) {
    if (kind === 'ok') ui.revBadge.style.color = 'var(--green-dark)';
    else if (kind === 'warn') ui.revBadge.style.color = 'var(--amber)';
    else ui.revBadge.style.color = 'var(--muted)';
  }
}

// ------------------------------------------------ author transliteration
let currentReviewItem = null;

async function refreshReview() {
  if (!ui.revCard) return;
  let item = null;
  try {
    const data = await store.get(['latestReviewItem']);
    item = data && data.latestReviewItem;
  } catch {}

  if (!item || !item.original) {
    currentReviewItem = null;
    ui.revContent.classList.add('hidden');
    ui.revEmpty.classList.remove('hidden');
    setBadge('None', 'idle');
    return;
  }

  currentReviewItem = item;
  ui.revEmpty.classList.add('hidden');
  ui.revContent.classList.remove('hidden');
  ui.revOriginal.textContent = item.original || '—';
  ui.revHandle.textContent = item.handle ? item.handle : '';
  ui.revUrdu.textContent = item.transliteration || '—';

  // Check if this item is currently overridden in the dictionary
  let isOverridden = item.source === 'override';
  try {
    const res = await req('/overrides');
    if (res.ok && res.body && res.body.overrides) {
      const overrides = res.body.overrides;
      const normName = String(item.original).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
      const normHandle = item.handle ? String(item.handle).trim().toLowerCase() : null;

      if (normHandle && (overrides[`handle:${normHandle}`] || overrides[normHandle])) {
        const found = overrides[`handle:${normHandle}`] || overrides[normHandle];
        isOverridden = true;
        ui.revUrdu.textContent = found.transliteration;
      } else if (overrides[`name:${normName}`] || overrides[normName]) {
        const found = overrides[`name:${normName}`] || overrides[normName];
        isOverridden = true;
        ui.revUrdu.textContent = found.transliteration;
      }
    }
  } catch {}

  if (isOverridden) {
    setBadge('Saved override', 'ok');
    ui.revApprove.classList.add('hidden');
    ui.revRemove.classList.remove('hidden');
    ui.revEdit.textContent = 'Edit spelling';
  } else {
    if (item.source === 'inputtools') {
      setBadge('Google Input Tools', 'idle');
    } else if (item.source === 'original') {
      setBadge('Urdu original', 'idle');
    } else {
      setBadge('Unchanged fallback', 'warn');
    }
    ui.revApprove.classList.remove('hidden');
    ui.revRemove.classList.add('hidden');
    ui.revEdit.textContent = 'Edit spelling';
  }
}

if (ui.revApprove) {
  ui.revApprove.addEventListener('click', async () => {
    if (!currentReviewItem) return;
    ui.revApprove.disabled = true;
    setNote(ui.revNote, 'Saving to dictionary…', 'idle');
    try {
      const res = await req('/transliterate/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: currentReviewItem.original,
          transliteration: currentReviewItem.transliteration,
          handle: currentReviewItem.handle,
        }),
      });
      if (!res.ok) throw new Error((res.body && res.body.error) || 'Failed to save');
      setNote(ui.revNote, 'Saved! Future occurrences will use this spelling.', 'ok');
      currentReviewItem.source = 'override';
      currentReviewItem.status = 'saved';
      await store.set({ latestReviewItem: currentReviewItem });
      await refreshReview();
    } catch (e) {
      setNote(ui.revNote, 'Could not save override: ' + (e.message || e), 'error');
    } finally {
      ui.revApprove.disabled = false;
    }
  });

  ui.revEdit.addEventListener('click', () => {
    if (!currentReviewItem) return;
    ui.revEditor.classList.remove('hidden');
    ui.revInput.value = currentReviewItem.transliteration || '';
    ui.revInput.focus();
  });

  ui.revCancel.addEventListener('click', () => {
    ui.revEditor.classList.add('hidden');
    setNote(ui.revNote, '', 'idle');
  });

  ui.revSave.addEventListener('click', async () => {
    if (!currentReviewItem) return;
    const corrected = ui.revInput.value.trim();
    if (!corrected) {
      setNote(ui.revNote, 'Urdu transliteration cannot be empty.', 'warn');
      return;
    }
    ui.revSave.disabled = true;
    setNote(ui.revNote, 'Saving correction…', 'idle');
    try {
      const res = await req('/transliterate/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: currentReviewItem.original,
          transliteration: corrected,
          handle: currentReviewItem.handle,
        }),
      });
      if (!res.ok) throw new Error((res.body && res.body.error) || 'Failed to save');
      ui.revUrdu.textContent = corrected;
      ui.revEditor.classList.add('hidden');
      setNote(ui.revNote, 'Correction saved to dictionary!', 'ok');
      currentReviewItem.transliteration = corrected;
      currentReviewItem.source = 'override';
      currentReviewItem.status = 'saved';
      await store.set({ latestReviewItem: currentReviewItem });
      await refreshReview();
    } catch (e) {
      setNote(ui.revNote, 'Could not save correction: ' + (e.message || e), 'error');
    } finally {
      ui.revSave.disabled = false;
    }
  });

  ui.revDismiss.addEventListener('click', async () => {
    await store.remove(['latestReviewItem']);
    currentReviewItem = null;
    ui.revContent.classList.add('hidden');
    ui.revEmpty.classList.remove('hidden');
    setBadge('None', 'idle');
    setNote(ui.revNote, '', 'idle');
  });

  ui.revRemove.addEventListener('click', async () => {
    if (!currentReviewItem) return;
    ui.revRemove.disabled = true;
    setNote(ui.revNote, 'Removing override…', 'idle');
    try {
      const res = await req('/transliterate/override', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: currentReviewItem.original,
          handle: currentReviewItem.handle,
        }),
      });
      if (!res.ok) throw new Error((res.body && res.body.error) || 'Failed to delete');
      setNote(ui.revNote, 'Override removed. The engine will transliterate fresh next time.', 'ok');
      currentReviewItem.source = 'inputtools';
      currentReviewItem.status = 'pending';
      await store.set({ latestReviewItem: currentReviewItem });
      await refreshReview();
    } catch (e) {
      setNote(ui.revNote, 'Could not remove override: ' + (e.message || e), 'error');
    } finally {
      ui.revRemove.disabled = false;
    }
  });
}

// --------------------------------------------------------------- refresh
let refreshingPromise = null;
function refresh() {
  if (refreshingPromise) return refreshingPromise;
  refreshingPromise = (async () => {
    try {
      await doRefresh();
    } finally {
      refreshingPromise = null;
    }
  })();
  return refreshingPromise;
}

async function doRefresh() {
  const s = await status();
  // Local and cheap: safe to ask on every tick, unlike a network fetch.
  renderVersion(await versionStatus());
  await refreshReview();

  if (s.state === 'unavailable') {
    hideQr();
    setStatus('err', 'Controller not running',
      'The local controller is not reachable on 127.0.0.1:47825. Ensure it is started via the Desktop shortcut “Rerun X2WA Connection” or startup script, then click Retry.');
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
let pushArmed = false;
let syncArmed = false;
let disarmTimer = null;

function disarmAllActions() {
  if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; }
  updateArmed = false;
  pushArmed = false;
  syncArmed = false;
  if (ui.update) {
    ui.update.classList.remove("confirm");
    ui.update.textContent = "Pull";
  }
  if (ui.push) {
    ui.push.classList.remove("confirm");
    ui.push.textContent = "Push";
  }
  if (ui.sync) {
    ui.sync.classList.remove("confirm");
    ui.sync.textContent = "Sync";
  }
}

function setButtonsDisabled(disabled) {
  if (ui.checkUpd) ui.checkUpd.disabled = disabled;
  if (ui.sync) ui.sync.disabled = disabled;
  if (ui.update) ui.update.disabled = disabled;
  if (ui.push) ui.push.disabled = disabled;
}

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function setVer(dotClass, title, detail) {
  ui.verDot.className = `dot ${dotClass}`;
  ui.verTitle.textContent = title;
  ui.verDetail.textContent = detail || "";
  ui.verDetail.classList.toggle("hidden", !detail);
}

// The popup re-reads the status every couple of seconds, which is what keeps
// "Connecting…" resolving on its own. That must not wipe the answer to
// something the user just did, so a note written by an action is held for a
// while and the polling stops overwriting it.
let verNoteLockUntil = 0;
const holdVerNote = (ms) => { verNoteLockUntil = Date.now() + (ms || 12000); };
const verNote = (text, kind) => {
  if (Date.now() < verNoteLockUntil) return;
  setNote(ui.verNote, text, kind);
};

function renderVersion(v) {
  if (!v) {
    setVer("", "Version unknown", "");
    setButtonsDisabled(true);
    return;
  }
  if (v.ok === false && v.error === "not-a-repo") {
    setVer("err", "Not a git checkout", "The controller could not find the project files.");
    setButtonsDisabled(true);
    return;
  }

  const where = `${v.branch || "?"} · ${(v.sha || "?").slice(0, 7)}`;
  const checked = v.checkedAt ? ` · checked ${ago(v.checkedAt)}` : "";

  setButtonsDisabled(false);

  // Clear primary emphasis by default
  if (ui.sync) ui.sync.classList.remove("primary");
  if (ui.update) ui.update.classList.remove("primary");
  if (ui.push) ui.push.classList.remove("primary");

  // Reset base button labels if not currently armed
  if (!updateArmed && ui.update) ui.update.textContent = "Pull";
  if (!pushArmed && ui.push) ui.push.textContent = "Push";
  if (!syncArmed && ui.sync) ui.sync.textContent = "Sync";

  if (v.dirty) {
    // Uncommitted edits: pull or sync would be refused to avoid clobbering work
    if (ui.sync) ui.sync.disabled = true;
    if (ui.update) ui.update.disabled = true;
    if (ui.push) ui.push.disabled = true;
    setVer("wait", "Local changes", `${where} · uncommitted`);
    verNote("You have uncommitted edits. Commit or stash them before syncing, pulling, or pushing.", "warn");
    return;
  }
  if (v.checkFailed === "unreachable") {
    setVer("wait", "Could not reach the remote", where + checked);
    verNote("The repository could not be reached, so this is the last known result rather than a fresh one.", "warn");
    return;
  }
  if (v.behind === null || v.behind === undefined) {
    setVer("", "Update status unknown", where + checked);
    if (!v.upstream) verNote("This checkout has no upstream branch to compare with.", "warn");
    else verNote("Press Check for updates to ask the remote.", "idle");
    return;
  }

  const behind = Number(v.behind) || 0;
  const ahead = Number(v.ahead) || 0;

  if (behind > 0 && ahead > 0) {
    setVer("wait", `${behind} behind, ${ahead} ahead`, where + checked);
    if (ui.sync) {
      ui.sync.classList.add("primary");
      if (!syncArmed) ui.sync.textContent = `Sync (${behind}↓ ${ahead}↑)`;
    }
    if (!updateArmed && ui.update) ui.update.textContent = `Pull (${behind})`;
    if (!pushArmed && ui.push) ui.push.textContent = `Push (${ahead})`;
    verNote("Checkout has diverged from remote. Press Sync to pull updates and push commits.", "idle");
    return;
  }
  if (behind > 0) {
    setVer("wait", `${behind} update${behind === 1 ? "" : "s"} available`, where + checked);
    if (ui.update) {
      ui.update.classList.add("primary");
      if (!updateArmed) ui.update.textContent = `Pull (${behind})`;
    }
    verNote("Updates fast-forward this checkout to the latest commit on the remote.", "idle");
    return;
  }
  if (ahead > 0) {
    setVer("", `${ahead} local commit${ahead === 1 ? "" : "s"} ahead`, where + checked);
    if (ui.push) {
      ui.push.classList.add("primary");
      if (!pushArmed) ui.push.textContent = `Push (${ahead})`;
    }
    verNote("Your checkout has commits the remote has not seen.", "idle");
    return;
  }

  setVer("on", "Up to date", where + checked);
  verNote("", "idle");
}

async function versionStatus() {
  try {
    const r = await req("/version");
    return r.ok ? r.body : null;
  } catch {
    return null;
  }
}

function disarmUpdate() {
  disarmAllActions();
}

ui.checkUpd.addEventListener("click", async () => {
  setButtonsDisabled(true);
  disarmAllActions();
  setVer("busy", "Checking…", "");
  setNote(ui.verNote, "Asking the remote what it has.", "idle");
  holdVerNote();
  try {
    const r = await req("/version/check", { method: "POST" });
    renderVersion(r.ok ? r.body : null);
  } catch {
    renderVersion(null);
    setNote(ui.verNote, "Lost contact with the controller.", "error");
  }
  setButtonsDisabled(false);
});

ui.update.addEventListener("click", async () => {
  if (!updateArmed) {
    disarmAllActions();
    updateArmed = true;
    ui.update.textContent = "Confirm pull";
    ui.update.classList.add("confirm");
    holdVerNote();
    setNote(ui.verNote,
      "This fast-forwards your checkout to the latest commit on the remote. Uncommitted edits are never touched, and untracked files do not block it.",
      "warn");
    disarmTimer = setTimeout(disarmAllActions, 6000);
    return;
  }
  disarmAllActions();
  holdVerNote();
  setButtonsDisabled(true);
  setVer("busy", "Pulling…", "");
  setNote(ui.verNote, "Fast-forwarding to the latest commit.", "idle");

  let r;
  try { r = await req("/update", { method: "POST" }); }
  catch {
    setButtonsDisabled(false);
    setVer("err", "Pull failed", "");
    setNote(ui.verNote, "Lost contact with the controller.", "error");
    return;
  }

  const body = r.body || {};
  if (!r.ok) {
    setButtonsDisabled(false);
    if (body.error === "local-changes") {
      setVer("err", "Pull refused", "You have uncommitted edits.");
      setNote(ui.verNote, "Commit or stash your work first — the pull will not touch it.", "warn");
    } else {
      setVer("err", "Pull failed", "");
      setNote(ui.verNote, body.detail || body.error || "The pull could not be applied.", "error");
    }
    return;
  }

  if (!body.updated) {
    setButtonsDisabled(false);
    setVer("on", "Up to date", "");
    setNote(ui.verNote, "Already on the latest commit.", "ok");
    renderVersion(await versionStatus());
    return;
  }

  // Reloading closes the popup, so leave the result where it can be read
  // next time it opens.
  const message = `Pulled ${body.from} → ${body.to}${body.restartController ? ". The controller is restarting." : ""}`;
  await store.set({ updateNotice: { text: message, at: Date.now(), reloadExtension: Boolean(body.reloadExtension) } });
  setVer("on", "Pulled", `${body.to.slice(0, 7)}`);
  setNote(ui.verNote, message, "ok");
  setButtonsDisabled(false);
  renderVersion(await versionStatus());

  if (body.reloadExtension) {
    // The extension on disk changed, but the running copy is the old one
    // until it is reloaded.
    setTimeout(() => chrome.runtime.reload(), 900);
  }
});

if (ui.push) {
  ui.push.addEventListener("click", async () => {
    if (!pushArmed) {
      disarmAllActions();
      pushArmed = true;
      ui.push.textContent = "Confirm push";
      ui.push.classList.add("confirm");
      holdVerNote();
      setNote(ui.verNote,
        "This pushes your local commits to the remote repository.",
        "warn");
      disarmTimer = setTimeout(disarmAllActions, 6000);
      return;
    }
    disarmAllActions();
    holdVerNote();
    setButtonsDisabled(true);
    setVer("busy", "Pushing…", "");
    setNote(ui.verNote, "Pushing local commits to remote.", "idle");

    let r;
    try { r = await req("/push", { method: "POST" }); }
    catch {
      setButtonsDisabled(false);
      setVer("err", "Push failed", "");
      setNote(ui.verNote, "Lost contact with the controller.", "error");
      return;
    }

    const body = r.body || {};
    if (!r.ok) {
      setButtonsDisabled(false);
      if (body.error === "push-rejected-behind") {
        setVer("err", "Push rejected", "Remote has newer commits.");
        setNote(ui.verNote, "Remote has changes you do not have. Pull or Sync first.", "warn");
      } else {
        setVer("err", "Push failed", "");
        setNote(ui.verNote, body.detail || body.error || "The push could not be completed.", "error");
      }
      return;
    }

    setButtonsDisabled(false);
    setVer("on", "Pushed", (body.sha || "").slice(0, 7));
    setNote(ui.verNote, "Successfully pushed commits to remote.", "ok");
    renderVersion(await versionStatus());
  });
}

if (ui.sync) {
  ui.sync.addEventListener("click", async () => {
    if (!syncArmed) {
      disarmAllActions();
      syncArmed = true;
      ui.sync.textContent = "Confirm sync";
      ui.sync.classList.add("confirm");
      holdVerNote();
      setNote(ui.verNote,
        "This synchronizes your checkout with remote: pulling updates and pushing your commits.",
        "warn");
      disarmTimer = setTimeout(disarmAllActions, 6000);
      return;
    }
    disarmAllActions();
    holdVerNote();
    setButtonsDisabled(true);
    setVer("busy", "Syncing…", "");
    setNote(ui.verNote, "Synchronizing with remote repository.", "idle");

    let r;
    try { r = await req("/sync", { method: "POST" }); }
    catch {
      setButtonsDisabled(false);
      setVer("err", "Sync failed", "");
      setNote(ui.verNote, "Lost contact with the controller.", "error");
      return;
    }

    const body = r.body || {};
    if (!r.ok) {
      setButtonsDisabled(false);
      if (body.error === "local-changes") {
        setVer("err", "Sync refused", "You have uncommitted edits.");
        setNote(ui.verNote, "Commit or stash your work first — sync will not touch it.", "warn");
      } else if (body.error === "sync-conflict") {
        setVer("err", "Sync conflict", "Merge conflict detected.");
        setNote(ui.verNote, body.detail || "Rebase conflict detected. Rebase was aborted to protect your code.", "error");
      } else {
        setVer("err", "Sync failed", "");
        setNote(ui.verNote, body.detail || body.error || "Sync could not be completed.", "error");
      }
      return;
    }

    setButtonsDisabled(false);
    let msg = "Checkout synchronized.";
    if (body.pulled && body.pushed) {
      msg = `Synced: pulled ${body.from} → ${body.to} and pushed commits.`;
    } else if (body.pulled) {
      msg = `Synced: pulled ${body.from} → ${body.to}.`;
    } else if (body.pushed) {
      msg = "Synced: pushed local commits to remote.";
    } else {
      msg = "Already fully synchronized with remote.";
    }

    if (body.restartController) msg += " The controller is restarting.";
    if (body.reloadExtension) {
      await store.set({ updateNotice: { text: msg, at: Date.now(), reloadExtension: true } });
      setTimeout(() => chrome.runtime.reload(), 900);
    }

    setVer("on", "Synchronized", (body.to || body.sha || "").slice(0, 7));
    setNote(ui.verNote, msg, "ok");
    renderVersion(await versionStatus());
  });
}

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