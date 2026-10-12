/* Élan Scents — editor package entry for edit-mode.
   Loads the implementation. Prefer keeping the single source under editor/ once the full file is moved. */
(function () {
  'use strict';
  var v = (document.currentScript && document.currentScript.src.split('?v=')[1]) || '1';
  var s = document.createElement('script');
  s.src = '/edit-mode.impl.js?v=' + v;
  s.onerror = function () {
    // Fallback while root edit-mode.js still holds the implementation body.
    var f = document.createElement('script');
    f.src = '/edit-mode.js?v=' + v;
    f.onerror = function () { console.error('edit-mode failed to load'); };
    document.head.appendChild(f);
  };
  document.head.appendChild(s);
})();
