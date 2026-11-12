/* Loads the editing tools ONLY when the page is opened inside Élan Editor (?elan_editor=1 and framed).
   Customers never download or run any of it. */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  if (q.get('elan_editor') !== '1' || window.parent === window) return;
  var v = (document.currentScript && document.currentScript.src.split('?v=')[1]) || '1';
  /* All three download at once and still run in this order (a script added by code with async=false runs in the order it was added): they used to be fetched one after the other. */
  Promise.all(['/elan-host-bridge.js', '/editor/editor-geometry.js', '/edit-mode.js'].map(function (src) {
    return new Promise(function (ok, no) { var s = document.createElement('script'); s.async = false; s.src = src + '?v=' + v; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  })).catch(function () { console.error('edit mode failed to load'); });
})();
