/* Loaded inside the editor page: returns to the login page when the session ends. */
(function () {
  'use strict';
  function leave() { document.body.textContent = ''; location.replace('/editor'); }
  setInterval(async function () {
    try { var r = await fetch('/api/editor-session', { cache: 'no-store' }); if (r.status === 401) leave(); } catch (_) { /* offline: keep working */ }
  }, 60000);
})();
