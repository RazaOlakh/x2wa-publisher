// Content script: inject "Post to WhatsApp" buttons, delegate click to background.
const INJECTION_FLAG = '__xwapButtonInjected';

function xlog(level,event,data){ const rec={ts:new Date().toISOString(),level,component:'content',event,...(data||{})}; try{ console.log(JSON.stringify(rec)); }catch{ console.log(`${level} ${event}`); } }

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

    // Resolve the *current* article at click time (X SPA pipelines can reuse
    // DOM nodes, so the article captured at injection may be stale).
    const currentArticle = btn.closest('article');
    if (!currentArticle) { btn.textContent = 'Err'; return; }

    const _reqId = 'xwap-' + Date.now() + '-' + Math.random().toString(36).slice(2,9);
    const startTs = performance.now();
    xlog('info','button-click',{requestId:_reqId});
    const post = window.__xwapExtractPost(currentArticle);
    xlog('info','extraction-started',{requestId:_reqId});
    xlog('info','extraction-result',{requestId:_reqId,tweetId:post&&post.tweetId,mediaTypes:post&&post.hasImage?['image']:[].concat(post&&post.hasVideo?['video']:[]),error:post.error||null});
    if (post.error) { btn.textContent = 'Unsupported'; return; }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SEND_POST', post, requestId: _reqId });
      xlog('info','response-received',{requestId:_reqId,ok:result&&result.ok,error:result&&result.error,jobId:result&&result.jobId,durationMs:Math.round(performance.now()-startTs)});
      btn.textContent = result && result.ok ? 'Sent' : `Err: ${(result && result.error) || 'failed'}`;
    } catch (e) {
      btn.textContent = 'Err';
      xlog('error','send-failed',{requestId:_reqId,error:e&&e.message});
    } finally {
      // Restore the original state after a short timeout so the user can see the result.
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
