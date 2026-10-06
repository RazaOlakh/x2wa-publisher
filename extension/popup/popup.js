const status = document.getElementById('status');
const controllerIn = document.getElementById('controller');
const channelIn = document.getElementById('channel');

chrome.storage.local.get(['controller', 'defaultChannel'], (r) => {
  if (r.controller) controllerIn.value = r.controller;
  if (r.defaultChannel) channelIn.value = r.defaultChannel;
  checkStatus();
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set({ controller: controllerIn.value, defaultChannel: channelIn.value }, () => {
    status.textContent = 'Saved';
    checkStatus();
  });
});

async function checkStatus() {
  try {
    const res = await fetch(`${controllerIn.value}/status`);
    const j = await res.json();
    status.textContent = `Controller: ${j.state}`;
  } catch {
    status.textContent = 'Controller: unreachable';
  }
}
