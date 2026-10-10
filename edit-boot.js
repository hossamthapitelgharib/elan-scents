/* Loads the editing tools ONLY when the page is opened inside Élan Editor (?elan_editor=1 and framed).
   Customers never download or run any of it. */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  if (q.get('elan_editor') !== '1' || window.parent === window) return;
  var v = (document.currentScript && document.currentScript.src.split('?v=')[1]) || '1';
  ['/elan-host-bridge.js', '/edit-model.js', '/edit-host.js'].reduce(function (p, src) {
    return p.then(function () { return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src + '?v=' + v; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); });
  }, Promise.resolve()).catch(function () { console.error('edit mode failed to load'); });
})();
