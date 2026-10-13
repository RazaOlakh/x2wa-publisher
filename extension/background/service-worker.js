// MV3 service worker: handles messages from the content script and talks to the
// local controller at http://127.0.0.1:47825. Image source resolution is based on
// article-scoped references gathered by the content script.
// video-source.js holds the (testable) rule that names a post's video.
importScripts('video-source.js');

const CONTROLLER = 'http://127.0.0.1:47825';

function swLog(level,event,data){ const rec={ts:new Date().toISOString(),level,component:'sw',event,...(data||{})}; try{ console.log(JSON.stringify(rec)); }catch{ console.log(`${level} ${event}`); } }

// --- Video manifest capture (needed because the X <video> element only exposes a blob:).
//
// Captured per tab AND per video id, never as one tab-wide "latest URL":
// the manifest path names its own video
// (video.twimg.com/amplify_video/<id>/pl/...), so the same id the
// content script read from the post's poster identifies exactly which
// video a manifest belongs to. That keeps a capture made while some
// other post's video was loading out of this post's media list.
const videoRequests = new Map(); // tabId -> Map<videoId, {master, variants, ts}>

// A master playlist carries every stream (video and audio) and its path
// holds no codec or resolution directory: /pl/k_<token>.m3u8 for amplify
// video, /pu/pl/<token>.m3u8 for the older ext_tw_video shape. A rendition
// nests those directories instead: /pl/avc1/720x720/tok.m3u8,
// /pl/mp4a/32000/tok.m3u8 (audio only), /pu/vid/avc1/720x720/tok.m3u8.
const RENDITION_DIRS = /^(?:avc1|hev1|hvc1|vp9|av01|mp4a|vid|aud|\d+x\d+)$/;
function isMasterPlaylistPath(rest) {
  const parts = rest.replace(/\?.*$/, '').split('/');
  parts.pop();
  return !parts.some((seg) => RENDITION_DIRS.test(seg));
}

function parseHls(url) {
  const m = /video\.twimg\.com\/(?:amplify|ext_tw)_video\/([A-Za-z0-9_-]+)\/([^?#]+)/.exec(url);
  if (!m) return null;
  if (!/\.m3u8$/i.test(m[2])) return null;
  return { videoId: m[1], master: isMasterPlaylistPath(m[2]), url };
}

chrome.webRequest && chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!/\.m3u8(\?|$)/.test(details.url)) return;
    const parsed = parseHls(details.url);
    if (!parsed || details.tabId < 0) return;
    let byId = videoRequests.get(details.tabId);
    if (!byId) { byId = new Map(); videoRequests.set(details.tabId, byId); }
    const rec = byId.get(parsed.videoId) || { master: null, variants: [], ts: Date.now() };
    if (parsed.master) { if (!rec.master) rec.master = parsed.url; }
    else if (rec.variants.indexOf(parsed.url) === -1 && rec.variants.length < 8) rec.variants.push(parsed.url);
    rec.ts = Date.now();
    byId.set(parsed.videoId, rec);
    if (byId.size > 24) {
      // Drop the least recently seen id so the map cannot grow unbounded.
      let oldest = null;
      for (const [id, r] of byId) { if (!oldest || r.ts < oldest.ts) oldest = { id, ts: r.ts }; }
      if (oldest) byId.delete(oldest.id);
    }
  },
  { urls: ['https://video.twimg.com/*'] },
);

// Pick the manifest for one specific video id: the master playlist this
// tab captured for it, else the master playlist from the post's
// server-rendered HTML.
//
// Only masters are ever used. A rendition such as /pl/avc1/3840x2160/
// <token>.m3u8 is a single stream with no audio, so muxing one yields a
// silent video, and /pl/mp4a/... is audio with no picture. Losing audio
// (or the picture) silently would be worse than reporting the item as
// failed, so a video without a master is reported, never downgraded.
//
// Never returns a manifest belonging to another id, so two videos in one
// post can never resolve to the same source.
function resolveVideoSource(videoId, tabId, hints) {
  if (!videoId) return { error: 'video-id-unknown' };
  const captured = (videoRequests.get(tabId) || new Map()).get(videoId);
  if (captured && captured.master) return { source: captured.master, via: 'captured-master' };
  const hint = hints && hints[videoId];
  if (hint && hint.master) return { source: hint.master, via: 'html-master' };
  return { error: 'video-master-unavailable' };
}

// inferVideoId() lives in video-source.js so its ambiguity rule can be
// tested without a browser; see that file for why it refuses to guess.

function reply(sendResponse, obj) {
  try { sendResponse(obj); } catch {}
}

// --- screenshot capture --------------------------------------------------
// A post is captured as an image of that post alone, not of the window or
// the page. That needs the DevTools capture command with a crop, because
// chrome.tabs.captureVisibleTab can only ever return the whole viewport, and
// reaching it would mean asking for <all_urls> - a view of every site the
// user visits - which is far more than this feature needs.
//
// The debugger is attached for the length of one capture and detached again
// immediately, and only ever to the tab the user just clicked in.
const CAPTURE_FORMAT = 'jpeg';
const CAPTURE_QUALITY = 88;

async function captureClip(tabId, clip) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: CAPTURE_FORMAT,
      quality: CAPTURE_QUALITY,
      captureBeyondViewport: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
    });
    if (!shot || !shot.data) return { error: 'capture-failed' };
    return { dataUrl: `data:image/${CAPTURE_FORMAT};base64,${shot.data}` };
  } finally {
    // Always detached, including when the capture threw: leaving it
    // attached would hold a debugging banner over the user's page.
    try { await chrome.debugger.detach(target); } catch { /* already gone */ }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Resolve t.co shortlinks to their canonical destination URLs.
  // The content script cannot read the expanded URL from the DOM (X only
  // exposes the shortlink href), so the resolution happens here where the
  // https://t.co/* host permission is available.
  if (msg && msg.type === 'RESOLVE_LINKS' && Array.isArray(msg.hrefs)) {
    (async () => {
      try {
        swLog('info', 'link-resolve-start', { count: msg.hrefs.length });
        const resolved = {};
        for (const href of msg.hrefs) {
          resolved[href] = await resolveTcoUrl(href);
        }
        swLog('info', 'link-resolve-done', {
          count: msg.hrefs.length,
          okCount: Object.values(resolved).filter(Boolean).length,
        });
        reply(sendResponse, { ok: true, resolved });
      } catch (e) {
        swLog('error', 'link-resolve-error', { count: msg.hrefs.length, error: e.message });
        reply(sendResponse, { ok: false, error: e.message });
      }
    })();
    return true;
  }
  // Translate a short string on its own - the author's name that heads an Urdu
  // post. The post's own text is translated by the controller as part of the
  // send; this is the small, separate request for the name.
  if (msg && msg.type === 'TRANSLATE_TEXT' && typeof msg.text === 'string') {
    (async () => {
      try {
        const res = await fetch(`${CONTROLLER}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: msg.text, to: msg.to || 'ur' }),
        });
        const j = await res.json();
        if (j && j.ok) return reply(sendResponse, { ok: true, text: j.text });
        return reply(sendResponse, { ok: false, error: (j && j.error) || 'translate-failed' });
      } catch (e) {
        swLog('warn', 'translate-text-failed', { error: e.message });
        reply(sendResponse, { ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg && msg.type === 'SEND_SCREENSHOT') {
    swLog('info', 'screenshot-received', { requestId: msg.requestId, tweetId: msg.post && msg.post.tweetId });
    (async () => {
      const tabId = _sender && _sender.tab && _sender.tab.id;
      if (typeof tabId !== 'number') return reply(sendResponse, { ok: false, error: 'no-tab' });
      const clip = msg.clip;
      if (!clip || !(clip.width > 0) || !(clip.height > 0)) {
        return reply(sendResponse, { ok: false, error: 'capture-too-small' });
      }
      const channelId = await getDefaultChannel();
      if (!channelId) return reply(sendResponse, { ok: false, error: 'no-default-channel' });

      let shot;
      try {
        shot = await captureClip(tabId, clip);
      } catch (e) {
        // Chrome refuses this while Developer Tools is open on the tab, which
        // is the common cause and worth saying so plainly.
        const reason = String((e && e.message) || e);
        const error = /devtools/i.test(reason) ? 'capture-unavailable' : 'capture-failed';
        swLog('warn', 'screenshot-capture-failed', { requestId: msg.requestId, error, reason: reason.slice(0, 120) });
        return reply(sendResponse, { ok: false, error, reason });
      }
      if (shot.error) return reply(sendResponse, { ok: false, error: shot.error });

      // The screenshot is deduplicated under its own key, so photographing a
      // post neither trips nor is tripped by that post's own guard. The
      // prefix is re-checked rather than trusted, so a stray value cannot
      // quietly become the post's real id and make a screenshot block the
      // post it was taken from.
      const shotId = typeof msg.dedupeKey === 'string' && msg.dedupeKey.indexOf('shot:') === 0
        ? msg.dedupeKey
        : `shot:${msg.requestId || Date.now()}`;

      // Sent through exactly the same endpoint and pipeline as a normal
      // post, so authentication, channel eligibility, media handling,
      // duplicate protection and error reporting are all the ones already
      // in use.
      const payload = {
        tweetId: shotId,
        tweetUrl: (msg.post && msg.post.tweetUrl) || null,
        text: (msg.post && msg.post.text) || '',
        media: [{ type: 'image', source: shot.dataUrl }],
        mediaFailures: [],
        channelId,
        kind: 'screenshot',
      };
      swLog('info', 'screenshot-controller-request', { requestId: msg.requestId, bytes: shot.dataUrl.length });
      try {
        const res = await fetch(`${CONTROLLER}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        if (j && j.ok) return reply(sendResponse, { ok: true, jobId: j.jobId, sent: j.sent });
        if (j && j.partial) {
          return reply(sendResponse, { ok: false, partial: true, jobId: j.jobId, sent: j.sent, failures: j.failures, error: j.error || 'partial-send' });
        }
        return reply(sendResponse, { ok: false, error: (j && j.error) || 'send-failed', ...(j && j.failures ? { failures: j.failures } : {}) });
      } catch (e) {
        reply(sendResponse, { ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (!msg || msg.type !== 'SEND_POST') return false;
  swLog('info','received-message',{requestId:msg.requestId,type:msg.type,tweetId:msg.post&&msg.post.tweetId,translateTo:msg.translateTo||null,mediaTypes:(msg.post&&msg.post.mediaItems||[]).map((m)=>m.type),hasImage:msg.post&&msg.post.hasImage,hasVideo:msg.post&&msg.post.hasVideo});
  (async () => {
    try {
      const p = msg.post;
      const media = [];
      const mediaFailures = [];
      const tabId = _sender && _sender.tab && _sender.tab.id;
      // Images and videos are resolved and emitted in the order the
      // content script read them from the clicked post, so the Channel
      // receives the post's real media order instead of images-then-video.
      //
      // Each video is matched to a captured HLS manifest by the video id
      // read from its poster, so a manifest captured for a different video
      // on the same tab is never substituted, and two videos in one post
      // never resolve to the same manifest.
      const items = Array.isArray(p.mediaItems) && p.mediaItems.length
        ? p.mediaItems
        // Fallback for a post extracted without an ordered item list.
        : (Array.isArray(p.mediaUrls) ? p.mediaUrls.map((u) => ({ type: 'image', url: u })) : []);
      const imageCount = items.filter((m) => m && m.type === 'image').length;
      const videoCount = items.filter((m) => m && m.type === 'video').length;
      const usedSources = new Set();
      const usedVideoIds = new Set();
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        if (it.type === 'image') {
          if (it.url) {
            media.push({ type: 'image', source: it.url });
            swLog('info','media-resolved',{requestId:msg.requestId,type:'image',index:i,source:it.url.slice(0,60)});
          } else {
            mediaFailures.push({ index: i, type: 'image', error: 'media-not-extracted' });
          }
        } else if (it.type === 'video') {
          const videoId = inferVideoId(it.videoId, p.hlsSources, usedVideoIds, videoCount);
          const r = resolveVideoSource(videoId, tabId, p.hlsSources);
          if (videoId) usedVideoIds.add(videoId);
          if (r.source && !usedSources.has(r.source)) {
            usedSources.add(r.source);
            media.push({ type: 'video', source: r.source });
            // Only the origin and path are logged: the playlist query carries
            // signed parameters that should not sit in logs.
            swLog('info','media-resolved',{requestId:msg.requestId,type:'video',index:i,videoId:videoId,via:r.via,inferred:!it.videoId,source:r.source.split('?')[0]});
          } else {
            const error = usedSources.has(r.source) ? 'video-source-already-used' : (r.error || 'video-source-unavailable');
            mediaFailures.push({ index: i, type: 'video', videoId: videoId || it.videoId || null, error });
            swLog('warn','media-resolve-failed',{requestId:msg.requestId,type:'video',index:i,videoId:videoId || it.videoId || null,error});
          }
        }
      }
      // A /photo/ link that produced no media URL means that image could
      // not be extracted: report it so the post is not silently reduced to
      // whatever subset the live DOM happened to render.
      const photoCount = p.photoHrefs ? p.photoHrefs.length : imageCount;
      for (let i = imageCount; i < photoCount; i++) {
        mediaFailures.push({ index: i, type: 'image', href: (p.photoHrefs && p.photoHrefs[i]) || null, error: 'media-not-extracted' });
      }
      // A single-image post whose URL was never rendered: resolve it the
      // old way rather than reporting an extraction failure.
      if (imageCount === 0 && photoCount === 1 && !media.length && mediaFailures.length === 0) {
        try {
          const imageUrl = await resolvePhotoUrl(p.photoHrefs[0]);
          if (imageUrl) {
            media.unshift({ type: 'image', source: imageUrl });
            mediaFailures.length = 0;
            swLog('info','media-resolved',{requestId:msg.requestId,type:'image',index:0,via:'photo-href-fallback',source:imageUrl.slice(0,60)});
          }
        } catch (e) {
          mediaFailures.push({ index: 0, type: 'image', href: p.photoHrefs[0], error: e.message });
        }
      }
      // A video post with no identifiable video at all (e.g. a live-stream
      // replay served from another host) must still be reported, never
      // silently reduced to text.
      if (p.hasVideo && items.every((m) => m && m.type !== 'video')) {
        mediaFailures.push({ index: 0, type: 'video', videoId: null, error: 'video-not-detected' });
        swLog('warn','media-video-not-detected',{requestId:msg.requestId});
      }
      if (p.hasVideo && !media.some((m) => m.type === 'video') && !mediaFailures.some((f) => f.type === 'video')) {
        mediaFailures.push({ index: 0, type: 'video', videoId: null, error: 'video-source-unavailable' });
      }

      const payload = {
        tweetId: p.tweetId,
        tweetUrl: p.tweetUrl,
        text: p.text,
        media: media.filter((m) => m.source),
        mediaFailures,
        // Kept under the old key too so an older controller still sees them.
        imageFailures: mediaFailures,
        channelId: await getDefaultChannel(),
      };
      // The "post in Urdu" button asks the controller to translate the text
      // before sending it. Forwarded as-is; the controller validates it.
      if (msg.translateTo) payload.translateTo = msg.translateTo;

      if (!payload.channelId) {
        return reply(sendResponse, { ok: false, error: 'no-default-channel' });
      }

      if (!payload.text && payload.media.length === 0) {
        return reply(sendResponse, { ok: false, error: 'empty-post', failures: mediaFailures });
      }

      swLog('info','controller-request-start',{requestId:msg.requestId,tweetId:p.tweetId,mediaTypes:payload.media.map(m=>m.type)});
      const res = await fetch(`${CONTROLLER}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (j && j.ok) return reply(sendResponse, { ok: true, jobId: j.jobId, sent: j.sent });
      if (j && j.partial) return reply(sendResponse, { ok: false, partial: true, jobId: j.jobId, sent: j.sent, failures: j.failures, error: j.error || 'partial-send' });
      return reply(sendResponse, { ok: false, error: (j && j.error) || 'send-failed', ...(j && j.failures ? { failures: j.failures } : {}) });
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

async function resolveTcoUrl(href) {
  // X wraps every external post link in a t.co shortlink. The canonical
  // destination is only available by following it: t.co answers with
  // either a redirect chain or a JS interstitial (location.replace).
  if (!href || !href.includes('//t.co/')) return href || null;
  try {
    const res = await fetch(href, { redirect: 'follow', credentials: 'omit' });
    if (res.url && !res.url.includes('//t.co/')) return res.url;
    const html = await res.text();
    // The interstitial redirects via JS. Its string literal encodes
    // the URL with escaped slashes — location.replace("https:\/\/example.com\/…")
    // — so the captured value must be unescaped.
    const m = /location\.replace\(\s*["']([^"']+)["']\s*\)/.exec(html);
    if (m && m[1]) return unescapeJsString(m[1]);
    // <noscript> fallback: <META http-equiv="refresh" content="0;URL=…">
    const noscript = /URL=([^">]+)/.exec(html);
    if (noscript && noscript[1] && /^https?:\/\//.test(noscript[1])) return noscript[1];
    const t = /<title[^>]*>([^<]*)<\/title>/.exec(html);
    if (t && t[1] && /^https?:\/\//.test(t[1].trim())) return t[1].trim();
    return null;
  } catch {
    return null;
  }
}

function unescapeJsString(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(['"\\\/bfnrt])/g, (_, ch) => {
      switch (ch) {
        case 'b': return '\b';
        case 'f': return '\f';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        default: return ch;
      }
    });
}

async function getDefaultChannel() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['defaultChannel','selectedChannelId'], (r) => resolve(r.selectedChannelId || r.defaultChannel || ''));
  });
}
