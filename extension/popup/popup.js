const waStatusText = document.getElementById('waStatusText');
const waStatusDot = document.querySelector('#waStatus .dot');
const waStatusRow = document.getElementById('waStatus');
const connectBtn = document.getElementById('connectBtn');
const checkBtn = document.getElementById('checkBtn');
const channelSelect = document.getElementById('channelSelect');
const refreshBtn = document.getElementById('refreshBtn');
const messageEl = document.getElementById('message');

const CONTROLLER = 'http://127.0.0.1:47825';

function setMessage(text, cls = 'muted') {
  messageEl.textContent = text;
  messageEl.className = cls;
}

function setWaStatus(text, dotClass) {
  waStatusText.textContent = text;
  waStatusDot.className = `dot ${dotClass}`;
}

async function fetchStatus() {
  try {
    const res = await fetch(`${CONTROLLER}/status`);
    return await res.json();
  } catch {
    return { state: 'unavailable' };
  }
}

async function fetchChannels() {
  try {
    const res = await fetch(`${CONTROLLER}/channels`);
    const j = await res.json();
    if (j && Array.isArray(j.channels)) return j.channels;
    throw new Error((j && j.error) || 'channel-list-failed');
  } catch (e) {
    throw new Error('channel-fetch-failed');
  }
}

function renderChannels(channels, selectedId) {
  channelSelect.innerHTML = '';
  channelSelect.disabled = false;
  refreshBtn.disabled = false;

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a Channel…';
  channelSelect.appendChild(placeholder);

  let found = false;
  for (const ch of channels) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name || ch.id;
    if (ch.id === selectedId) {
      opt.selected = true;
      found = true;
    }
    channelSelect.appendChild(opt);
  }

  if (!found && selectedId) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(previous selection unavailable)';
    opt.disabled = true;
    channelSelect.insertBefore(opt, placeholder.nextSibling);
  }
  return found;
}

channelSelect.addEventListener('change', (e) => {
  const value = e.target.value;
  if (!value) {
    chrome.storage.local.remove(['selectedChannelId'], () => {
      setMessage('Select a WhatsApp Channel before posting.', 'muted');
    });
    return;
  }
  const opt = channelSelect.options[channelSelect.selectedIndex];
  chrome.storage.local.set({ selectedChannelId: value, selectedChannelName: opt.textContent }, () => {
    setMessage('Selected channel saved.', 'success');
  });
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  setMessage('Refreshing channels…', 'muted');
  try {
    const channels = await fetchChannels();
    chrome.storage.local.get(['selectedChannelId'], (r) => {
      const found = renderChannels(channels, r.selectedChannelId);
      if (channels.length === 0) setMessage('No WhatsApp Channels found for this account.', 'muted');
      else if (!found && r.selectedChannelId) setMessage('Previous selection is unavailable. Please choose another Channel.', 'error');
      else setMessage('', 'muted');
    });
  } catch {
    setMessage('Could not fetch channels. Make sure the controller is running.', 'error');
    channelSelect.innerHTML = '<option value="">Unavailable</option>';
    channelSelect.disabled = true;
  } finally {
    refreshBtn.disabled = false;
  }
});

connectBtn.addEventListener('click', async () => {
  setMessage('Checking connection …', 'muted');
  await init();
});

checkBtn.addEventListener('click', async () => {
  setMessage('Checking connection …', 'muted');
  await init();
});

async function init() {
  const status = await fetchStatus();

  switch (status.state) {
    case 'ready':
      setWaStatus('Connected', 'dot-on');
      connectBtn.disabled = true;
      checkBtn.disabled = true;
      break;
    case 'qr':
      setWaStatus('Authentication required', 'dot-warn');
      connectBtn.disabled = true;
      checkBtn.disabled = false;
      setMessage('Open the controller window in the terminal and scan the QR with the dedicated WhatsApp account.', 'muted');
      return;
    case 'auth_failure':
      setWaStatus('Authentication failed', 'dot-err');
      connectBtn.disabled = false;
      checkBtn.disabled = false;
      setMessage('Authentication failed. Restart the controller and scan the QR again.', 'error');
      return;
    case 'disconnected':
      setWaStatus('Disconnected', 'dot-err');
      connectBtn.disabled = false;
      checkBtn.disabled = false;
      return;
    case 'authenticated':
    case 'starting':
      setWaStatus('Connecting…', 'dot-warn');
      connectBtn.disabled = false;
      checkBtn.disabled = false;
      return;
    default:
      setWaStatus('Controller unavailable', 'dot-err');
      connectBtn.disabled = false;
      checkBtn.disabled = false;
      setMessage('Make sure the X → WhatsApp controller is running on 127.0.0.1:47825.', 'error');
      return;
  }

  try {
    const channels = await fetchChannels();
    const store = await new Promise((r) => chrome.storage.local.get(['selectedChannelId'], r));
    const found = renderChannels(channels, store.selectedChannelId);
    if (channels.length === 0) {
      setMessage('No WhatsApp Channels found for this account.', 'muted');
    } else if (!found && store.selectedChannelId) {
      setMessage('Previous selection is unavailable. Please choose another Channel.', 'error');
    } else {
      setMessage('', 'muted');
    }
  } catch {
    setMessage('Could not load channels. Try Refresh.', 'error');
    channelSelect.innerHTML = '<option value="">Unavailable</option>';
    channelSelect.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', init);
