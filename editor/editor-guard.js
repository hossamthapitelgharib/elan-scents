/* Loaded inside the editor page. While the page is open it polls the session (which also keeps the session alive on
   the server). When the session has really ended it only shows a warning: wiping the page would throw away edits that
   are not saved yet. Signing in again, in another tab, revives this one on its own because the cookie is shared. */
(function () {
  'use strict';
  var box = null, busy = false;
  function show() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('role', 'alertdialog');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6);font-family:inherit';
    var card = document.createElement('div');
    card.style.cssText = 'max-width:420px;background:#fff;color:#222;border-radius:14px;padding:22px;text-align:center;line-height:1.8;direction:rtl';
    var title = document.createElement('b');
    title.style.cssText = 'display:block;font-size:18px;margin-bottom:6px';
    title.textContent = 'انتهت جلسة الدخول';
    var text = document.createElement('p');
    text.style.cssText = 'margin:0 0 14px';
    text.textContent = 'تعديلاتك اللي لسه ما اتحفظتش موجودة في الصفحة دي ولسه ما ضاعتش. افتحي صفحة الدخول في تبويب جديد وسجّلي، وبعدها ارجعي هنا وهتكمل الصفحة لوحدها.';
    var open = document.createElement('button');
    open.type = 'button';
    open.style.cssText = 'padding:10px 18px;border:0;border-radius:10px;background:#c8962a;color:#fff;font-size:15px;cursor:pointer';
    open.textContent = 'فتح صفحة الدخول';
    open.addEventListener('click', function () { window.open('/editor', '_blank', 'noopener'); });
    card.appendChild(title); card.appendChild(text); card.appendChild(open);
    box.appendChild(card);
    document.body.appendChild(box);
  }
  function hide() {
    if (!box) return;
    if (box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }
  async function check() {
    if (busy) return;
    busy = true;
    try {
      var r = await fetch('/api/editor-session', { cache: 'no-store' });
      if (r.status === 401) show(); else if (r.ok) hide();
    } catch (_) { /* offline: keep working */ }
    finally { busy = false; }
  }
  setInterval(check, 60000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
})();
