/* Loaded inside the editor page: logout button + automatic return to login when the session ends. */
(function () {
  'use strict';
  var b = document.createElement('button');
  b.textContent = 'تسجيل الخروج';
  b.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:99999;padding:6px 12px;border:1px solid #c2a66a;border-radius:7px;background:#fffaf0;color:#29251c;font:inherit;cursor:pointer';
  function leave() { document.body.textContent = ''; location.replace('/editor'); }
  b.addEventListener('click', async function () {
    if (window.elanLiveEditorBridge && window.elanLiveEditorBridge.getState().dirty && !confirm('في تعديلات لسه ما اتحفظتش. تخرجي برضه؟')) return;
    try { await fetch('/api/editor-logout', { method: 'POST' }); } catch (_) { /* leave anyway */ }
    leave();
  });
  document.body.appendChild(b);
  setInterval(async function () {
    try { var r = await fetch('/api/editor-session', { cache: 'no-store' }); if (r.status === 401) leave(); } catch (_) { /* offline: keep working */ }
  }, 60000);
})();
