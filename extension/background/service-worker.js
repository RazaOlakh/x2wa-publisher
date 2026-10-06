// MV3 service worker: handles messages from the content script and talks to the
// local controller at http://127.0.0.1:47825. Image source resolution is based on
// article-scoped references gathered by the content script.
const CONTROLLER = 'http://127.0.0.1:47825';

// --- Video manifest capture (needed because the X <video> element only exposes a blob:).
const videoRequests = new Map(); // tabId -> [{url, ts}]
chrome.webRequest && chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (/video\.twimg\.com.*\.m3u8/.test(details.url)) {
      const arr = videoRequests.get(details.tabId) || [];
      arr.unshift({ url: details.url, ts: Date.now() });
      videoRequests.set(details.tabId, arr.slice(0, 20));
    }
  },
  { urls: ['https://video.twimg.com/*'] },
);

function latestVideoUrl(tabId) {
  const arr = videoRequests.get(tabId) || [];
  return arr.length ? arr[0].url : null;
}

function reply(sendResponse, obj) {
  try { sendResponse(obj); } catch {}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'SEND_POST') return false;
  (async () => {
    try {
      const p = msg.post;
      const media = [];
      // Image: resolve tweet-scoped pbs media URL through the article's photo route.
      if (p.hasImage && p.photoHrefs && p.photoHrefs.length > 0) {
        try {
          const imageUrl = await resolvePhotoUrl(p.photoHrefs[0]);
          if (imageUrl) media.push({ type: 'image', source: imageUrl });
        } catch {}
      }
      if (p.hasVideo) {
        const tabId = _sender && _sender.tab && _sender.tab.id;
        const m = latestVideoUrl(tabId);
        if (m) media.push({ type: 'video', source: m });
      }
      const payload = {
        tweetId: p.tweetId,
        tweetUrl: p.tweetUrl,
        text: p.text,
        media: media.filter((m) => m.source),
        channelId: await getDefaultChannel(),
      };

      if (!payload.channelId) {
        return reply(sendResponse, { ok: false, error: 'no-default-channel' });
      }

      if (!payload.text && payload.media.length === 0) {
        return reply(sendResponse, { ok: false, error: 'empty-post' });
      }

      const res = await fetch(`${CONTROLLER}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      reply(sendResponse, j && j.ok ? { ok: true, jobId: j.jobId, sent: j.sent } : { ok: false, error: (j && j.error) || 'send-failed' });
    } catch (e) { reply(sendResponse, { ok: false, error: e.message }); }
  })();
  return true;
});

async function resolvePhotoUrl(href) {
  // href is already a tweet-scoped /status/<id>/photo/<n> reference.
  const res = await fetch(href, { credentials: 'omit' });
  if (!res.ok) return null;
  const html = await res.text();
  const m = /<meta property="og:image" content="([^"]+)"/.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

async function getDefaultChannel() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['defaultChannel'], (r) => resolve(r.defaultChannel || ''));
  });
}
