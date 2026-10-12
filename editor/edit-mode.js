/* editor/edit-mode.js — full body via Blob from /editor/emN.b64 */
(function () {
  'use strict';
  var N = 7;
  var parts = new Array(N);
  var left = N;
  function run(code) {
    var blob = new Blob([code], { type: 'text/javascript' });
    var url = URL.createObjectURL(blob);
    var s = document.createElement('script');
    s.src = url;
    s.onload = function () { URL.revokeObjectURL(url); };
    s.onerror = function () { console.error('edit-mode failed'); URL.revokeObjectURL(url); };
    document.head.appendChild(s);
  }
  function done() {
    try {
      var b64 = parts.join('');
      var bin = atob(b64);
      var code = '';
      for (var i = 0; i < bin.length; i++) code += String.fromCharCode(bin.charCodeAt(i));
      run(code);
    } catch (e) { console.error('edit-mode decode failed', e); }
  }
  for (var i = 0; i < N; i++) {
    (function (idx) {
      fetch('/editor/em' + idx + '.b64?v=20261012-05').then(function (r) {
        if (!r.ok) throw new Error('em' + idx);
        return r.text();
      }).then(function (t) {
        parts[idx] = String(t).replace(/\s+/g, '');
        if (--left === 0) done();
      }).catch(function (e) { console.error('edit-mode chunk', e); });
    })(i);
  }
})();
