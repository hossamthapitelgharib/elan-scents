/* Editor package entry: loads the visual edit-mode implementation.
   Full body at /edit-mode.js (shared). Entry under editor/ is the public surface. */
(function () {
  'use strict';
  var v = (document.currentScript && document.currentScript.src.split('?v=')[1]) || '1';
  var s = document.createElement('script');
  s.src = '/edit-mode.js?v=' + v;
  s.onerror = function () { console.error('edit-mode failed to load'); };
  document.head.appendChild(s);
})();
