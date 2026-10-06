// MV3 service worker: handles messages from the content script and talks to the
// local controller at http://127.0.0.1:47825. Image source resolution is based on
// article-scoped references gathered by the content script.
const CONTROLLER = 'http://127.0.0.1:47825';

function swLog(level,event,data){ const rec={ts:new Date().toISOString(),level,component:'sw',event,...(data||{})}; try{ console.log(JSON.stringify(rec)); }catch{ console.log(`${level} ${event}`); } }

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
  swLog('info','received-message',{requestId:msg.requestId,type:msg.type,tweetId:msg.post&&msg.post.tweetId,mediaTypes:msg.post&&msg.post.hasImage?['image']:[].concat(msg.post&&msg.post.hasVideo?['video']:[])});
  try{ chrome.storage.local.set({swSawMessage: JSON.stringify(msg).slice(0,200)}); }catch(e){}
  (async () => {
    try {
      const p = msg.post;
      const media = [];
      // Image: resolve tweet-scoped pbs media URL through the article's photo route.
      if (p.hasImage && p.photoHrefs && p.photoHrefs.length > 0) {
        try {
          swLog('info','media-resolve-image',{requestId:msg.requestId,href:p.photoHrefs[0]});
          const imageUrl = await resolvePhotoUrl(p.photoHrefs[0]);
          if (imageUrl) { media.push({ type: 'image', source: imageUrl }); swLog('info','media-resolved',{requestId:msg.requestId,type:'image',source:imageUrl.slice(0,50)}); } else { swLog('warn','media-resolve-empty',{requestId:msg.requestId,type:'image'}); }
        } catch (e) { swLog('error','media-resolve-error',{requestId:msg.requestId,type:'image',error:e.message}); }
      }
      if (p.hasVideo) {
        const tabId = _sender && _sender.tab && _sender.tab.id;
        const m = latestVideoUrl(tabId);
        if (m) { media.push({ type: 'video', source: m }); swLog('info','media-resolved',{requestId:msg.requestId,type:'video',source:m.slice(0,50)}); } else { swLog('warn','media-resolve-empty',{requestId:msg.requestId,type:'video'}); }
      }
      if (p.hasVideo && !media.some((m) => m.type === 'video' && m.source)) {
        return reply(sendResponse, { ok: false, error: 'video-media-unavailable' });
      }
      const payload = {
        tweetId: p.tweetId,
        tweetUrl: p.tweetUrl,
        text: p.text,
        media: media.filter((m) => m.source),
        channelId: await getDefaultChannel(),
      };
      try{ chrome.storage.local.set({lastMedia: JSON.stringify(media).slice(0,400)}); }catch{}

      if (!payload.channelId) {
        return reply(sendResponse, { ok: false, error: 'no-default-channel' });
      }

      if (!payload.text && payload.media.length === 0) {
        return reply(sendResponse, { ok: false, error: 'empty-post' });
      }

      swLog('info','controller-request-start',{requestId:msg.requestId,tweetId:p.tweetId,mediaTypes:payload.media.map(m=>m.type)});
      const res = await fetch(`${CONTROLLER}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      try{ chrome.storage.local.set({swResp: JSON.stringify(j).slice(0,300)}); }catch{}
      reply(sendResponse, j && j.ok ? { ok: true, jobId: j.jobId, sent: j.sent } : { ok: false, error: (j && j.error) || 'send-failed' });
    } catch (e) { try{ chrome.storage.local.set({swError: e.message}); }catch{} reply(sendResponse, { ok: false, error: e.message }); }
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
