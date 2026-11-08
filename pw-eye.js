/* An «eye» on every password field: pressed once it shows what was typed, pressed again it hides it.
   A field always starts hidden. It is added by wrapping each input[type=password] (also the ones a page builds later), so no page needs its own markup. */
(function () {
  'use strict';
  var LABELS = { ar: ['إظهار كلمة المرور', 'إخفاء كلمة المرور'], en: ['Show password', 'Hide password'] };
  var OPEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var SHUT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 6.1A10.7 10.7 0 0 1 12 6c6.5 0 10.5 6 10.5 6a17.7 17.7 0 0 1-3.2 3.8M6.5 7.6A17.4 17.4 0 0 0 1.5 12S5.5 18 12 18c1.6 0 3-.3 4.3-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function lang() { return String(document.documentElement.lang || 'ar').slice(0, 2) === 'en' ? 'en' : 'ar'; }

  function addStyle() {
    if (document.getElementById('pw-eye-style')) return;
    var st = document.createElement('style');
    st.id = 'pw-eye-style';
    st.textContent = '.pw-wrap{position:relative;display:block;width:100%}' +
      '.pw-wrap>input{width:100%;box-sizing:border-box;padding-inline-end:48px!important}' +
      '.pw-eye{position:absolute;top:50%;inset-inline-end:6px;transform:translateY(-50%);display:grid;place-items:center;width:38px;height:38px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:#8a6a1b;cursor:pointer;box-shadow:none;min-width:0}' +
      '.pw-eye:hover,.pw-eye:focus-visible{background:rgba(200,150,42,.14);outline:none}' +
      '.pw-eye[aria-pressed="true"]{color:#c8962a}';
    document.head.appendChild(st);
  }

  function decorate(input) {
    if (!input || input.dataset.pwEye || input.closest('.pw-wrap')) return;
    input.dataset.pwEye = '1';
    var wrap = document.createElement('span'), btn = document.createElement('button');
    wrap.className = 'pw-wrap';
    btn.type = 'button'; btn.className = 'pw-eye'; btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', LABELS[lang()][0]); btn.innerHTML = OPEN;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input); wrap.appendChild(btn);
  }

  function scan(root) {
    var list = (root.querySelectorAll ? root.querySelectorAll('input[type="password"]') : []);
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.pw-eye');
    if (!btn) return;
    e.preventDefault();
    var input = btn.parentNode.querySelector('input');
    if (!input) return;
    var show = input.type === 'password', L = LABELS[lang()];
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.setAttribute('aria-label', show ? L[1] : L[0]);
    btn.innerHTML = show ? SHUT : OPEN;
    try { input.focus({ preventScroll: true }); } catch (_) {}
  });

  function start() {
    addStyle();
    scan(document);
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) for (var j = 0; j < records[i].addedNodes.length; j++) {
        var n = records[i].addedNodes[j];
        if (n.nodeType === 1) { if (n.matches && n.matches('input[type="password"]')) decorate(n); else scan(n); }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());
