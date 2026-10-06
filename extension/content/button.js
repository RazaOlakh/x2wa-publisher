// Content script: inject "Post to WhatsApp" buttons, delegate click to background.
const INJECTION_FLAG = '__xwapButtonInjected';

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

    const post = window.__xwapExtractPost(currentArticle);
    if (post.error) { btn.textContent = 'Unsupported'; return; }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SEND_POST', post });
      btn.textContent = result && result.ok ? 'Sent' : `Err: ${(result && result.error) || 'failed'}`;
    } catch (e) {
      btn.textContent = 'Err';
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
