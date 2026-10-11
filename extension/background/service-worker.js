// MV3 service worker: handles messages from the content script and talks to the
// local controller at http://127.0.0.1:47825. Image source resolution is based on
// article-scoped references gathered by the content script.
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

// A video whose poster carries no id (older posts show a plain
// /media/<id>.jpg thumbnail) can still be named when this post's own
// document holds exactly one video: one video item maps 1:1 onto one
// manifest id. With more than one candidate the mapping is ambiguous, so
// the item is reported instead of guessed.
function inferVideoId(videoId, hints, usedIds, videoCount) {
  if (videoId) return videoId;
  const candidates = Object.keys(hints || {}).filter((id) => hints[id] && hints[id].master);
  if (videoCount !== 1 || candidates.length !== 1) return null;
  if (usedIds.has(candidates[0])) return null;
  return candidates[0];
}

function reply(sendResponse, obj) {
  try { sendResponse(obj); } catch {}
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
  if (!msg || msg.type !== 'SEND_POST') return false;
  swLog('info','received-message',{requestId:msg.requestId,type:msg.type,tweetId:msg.post&&msg.post.tweetId,mediaTypes:(msg.post&&msg.post.mediaItems||[]).map((m)=>m.type),hasImage:msg.post&&msg.post.hasImage,hasVideo:msg.post&&msg.post.hasVideo});
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
            swLog('info','media-resolved',{requestId:msg.requestId,type:'video',index:i,videoId:videoId,via:r.via,inferred:!it.videoId,source:r.source.slice(0,70)});
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
