// Content script: inject "Post to WhatsApp" buttons, delegate click to background.
const INJECTION_FLAG = '__xwapButtonInjected';

function xlog(level, event, data) {
  const rec = { ts: new Date().toISOString(), level, component: 'content', event, ...(data || {}) };
  try { console.log(JSON.stringify(rec)); } catch { console.log(`${level} ${event}`); }
}

function injectButton(article) {
  if (article[INJECTION_FLAG]) return;
  article[INJECTION_FLAG] = true;

  const bar = article.querySelector('div[role="group"]');
  if (!bar) return;

  const btn = document.createElement('button');
  btn.textContent = 'Post to WhatsApp';
  btn.style.cssText = 'background:#25D366;color:#fff;border:0;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;margin-left:6px;';
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (btn.disabled) return;
    const requestId = 'req-' + Date.now();
    try { xlog('info', 'button-click', { requestId, articleUrl: location.href }); } catch {}

    const currentArticle = btn.closest('article');
    if (!currentArticle) { btn.textContent = 'Err'; xlog('error', 'extraction-failed', { requestId, error: 'no article' }); return; }

    try { xlog('info', 'extraction-started', { requestId }); } catch {}
    const post = await window.__xwapExtractPostAsync(currentArticle);
    try { xlog('info', 'extraction-succeeded', { requestId, tweetId: post && post.tweetId, textLength: post && post.text ? post.text.length : 0, mediaTypes: post ? [post.hasImage ? 'image' : null, post.hasVideo ? 'video' : null].filter(Boolean) : [], error: post ? post.error : 'missing' }); } catch {}

    if (post.error) { btn.textContent = 'Unsupported'; xlog('error', 'extraction-failed', { requestId, error: post.error }); return; }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const started = Date.now();
      try { xlog('info', 'send-started', { requestId, tweetId: post.tweetId, mediaTypes: post.hasImage ? ['image'] : [] }); } catch {}
      const result = await chrome.runtime.sendMessage({ type: 'SEND_POST', post, requestId });
      try { xlog('info', 'response-received', { requestId, jobId: result && result.jobId, durationMs: Date.now() - started }); } catch {}
      btn.textContent = result && result.ok ? 'Sent' : `Err: ${(result && result.error) || 'failed'}`;
      if (result && result.ok) {
        try { xlog('info', 'send-succeeded', { requestId, tweetId: post.tweetId, jobId: result.jobId }); } catch {}
      } else {
        try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: result ? result.error : 'unknown' }); } catch {}
      }
    } catch (e) {
      btn.textContent = 'Err';
      try { xlog('error', 'send-failed', { requestId, tweetId: post.tweetId, error: e && e.message }); } catch {}
    } finally {
      btn.disabled = false;
    }
    setTimeout(() => { btn.textContent = 'Post to WhatsApp'; }, 4000);
  });

  bar.appendChild(btn);
}

function scan() {
  for (const art of document.querySelectorAll('article')) {
    injectButton(art);
  }
}

const mo = new MutationObserver(scan);
mo.observe(document.body, { childList: true, subtree: true });
scan();
