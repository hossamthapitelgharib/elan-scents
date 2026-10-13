/* Owner login for Élan Editor. The session lives in this tab's memory only: no "remember me", no storage.
   Reopening or reloading the editor asks for the password again. */
(function () {
  'use strict';
  var session = null, timer = null;
  window.elanEditorSession = { token: function () { return session && session.access_token || null; } };
  var gate = document.getElementById('elan-gate'), form = document.getElementById('elan-gate-form'), msg = document.getElementById('elan-gate-msg');
  var gateStyle = document.getElementById('elan-gate-style');

  async function cfg() { return fetch('/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }); }
  async function grant(kind, body) {
    var c = await cfg();
    var r = await fetch(c.url + '/auth/v1/token?grant_type=' + kind, { method: 'POST', headers: { apikey: c.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var d = await r.json(); if (!r.ok || !d.access_token) throw Error('auth');
    return d;
  }
  function schedule() {
    clearTimeout(timer);
    var ms = Math.max(30000, ((session.expires_in || 3600) - 120) * 1000);
    timer = setTimeout(async function () {
      try { session = await grant('refresh_token', { refresh_token: session.refresh_token }); schedule(); }
      catch (e) { lock('انتهت الجلسة. سجلي الدخول تاني.'); }
    }, ms);
  }
  function lock(text) {
    session = null; clearTimeout(timer);
    if (!document.getElementById('elan-gate-style')) { var s = document.createElement('style'); s.id = 'elan-gate-style'; s.textContent = 'body>*:not(#elan-gate){display:none!important}'; document.head.appendChild(s); gateStyle = s; }
    gate.style.display = 'flex'; msg.textContent = text || '';
  }
  function unlock() { gate.style.display = 'none'; var s = document.getElementById('elan-gate-style'); if (s) s.remove(); }


  // "تحديث": confirms the last save is really live, then reloads the isolated platform copy at that version.
  function addRefresh() {
    var rb = document.createElement('button');
    rb.textContent = '⟳ تحديث وتأكيد آخر نشر'; rb.style.marginInlineStart = '8px';
    var note = document.createElement('b'); note.id = 'elan-refresh-note'; note.style.cssText = 'display:block;margin-top:6px;font-size:13px';
    rb.onclick = async function () {
      if (bridgeDirty && !confirm('فيه تعديلات لسه ما اتحفظتش، والتحديث هيمسحها. نكمل؟')) return;
      rb.disabled = true; note.textContent = ('بنتأكد إن آخر حفظ اتنشر على Railway...');
      try {
        var h = { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' };
        var st = await fetch('/api/editor?action=state', { headers: h, cache: 'no-store' }).then(function (r) { return r.json(); });
        if (!st.ok) throw Error('تعذر قراءة آخر إصدار.');
        var rev = st.revision;
        if (!rev) { note.textContent = ('لسه مفيش تعديلات محفوظة، الصفحة زي ما هي.'); }
        else {
          var chk = await fetch('/api/editor', { method: 'POST', headers: h, cache: 'no-store', body: JSON.stringify({ action: 'status', revision: rev }) }).then(function (r) { return r.json(); });
          if (!chk.published) { note.textContent = ('⏳ التعديل اتحفظ على GitHub بس لسه بيتنشر على Railway. استني شوية وجربي تاني.'); return; }
          note.textContent = ('✓ آخر تعديل منشور فعليًا (الإصدار ' + String(rev).slice(0, 7) + '). تم تحميل الصفحة على آخر وضع.');
        }
        bridgeDirty = false; abandonBridge();
        var u = new URL(liveFrame.src); u.searchParams.set('cb', Date.now()); liveFrame.src = u.href;
      } catch (e) { note.textContent = (e.message || 'تعذر التحديث.'); }
      finally { rb.disabled = false; }
    };
    livePanel.append(rb, note);
  }

  form.addEventListener('submit', async function (ev) {
    ev.preventDefault(); msg.textContent = '';
    try {
      session = await grant('password', { email: form.email.value.trim(), password: form.password.value });
      form.password.value = '';
      var chk = await fetch('/api/editor?action=state', { headers: { Authorization: 'Bearer ' + session.access_token }, cache: 'no-store' });
      if (chk.status === 403 || chk.status === 401) { lock('الحساب ده مش أدمن للمنصة.'); return; }
      if (chk.status !== 200) { lock('الإديتور لسه مش جاهز على السيرفر.'); return; }
      schedule(); unlock();
      if (typeof openLive !== 'undefined') openLive.click();
      addRefresh();
      var out = document.createElement('button'); out.textContent = 'خروج'; out.style.cssText = 'position:fixed;bottom:12px;inset-inline-start:12px;z-index:9000;padding:6px 12px';
      out.onclick = function () { location.reload(); }; document.body.appendChild(out);
    } catch (e) { session = null; msg.textContent = 'الإيميل أو كلمة السر غلط.'; }
  });
})();
