/* Loads the last known-good full core, then removes only the Follow Us text links (keeps social icons).
   Uses jsDelivr instead of raw.githubusercontent.com so browsers accept the script MIME type. */
(function () {
  var PINNED = 'https://cdn.jsdelivr.net/gh/hossamthapitelgharib/elan-scents@a5c9a6ea1de9aa92d0f65c40502aea7db971ac98/app-core.js';
  var s = document.createElement('script');
  s.src = PINNED;
  s.onload = function () {
    if (typeof footer18 !== 'function') return;
    var original = footer18;
    footer18 = function (t) {
      original(t);
      var el = document.getElementById('fcols');
      if (!el) return;
      Array.prototype.slice.call(el.querySelectorAll('h5')).forEach(function (h) {
        var label = (h.textContent || '').trim();
        if (label !== '\u062a\u0627\u0628\u0639\u0646\u0627' && label !== 'Follow us') return;
        var cur = h.nextSibling;
        while (cur && !(cur.nodeType === 1 && (cur.tagName === 'H5' || cur.tagName === 'DIV'))) {
          var next = cur.nextSibling;
          if (cur.nodeType === 1 && (cur.tagName === 'A' || cur.tagName === 'SPAN')) {
            cur.parentNode.removeChild(cur);
          } else if (cur.nodeType === 3) {
            cur.parentNode.removeChild(cur);
          } else {
            break;
          }
          cur = next;
        }
        h.parentNode.removeChild(h);
      });
    };
    try { footer18(typeof T === 'function' ? T() : {}); } catch (e) {}
  };
  s.onerror = function () { console.error('failed to load pinned app-core.js'); };
  document.head.appendChild(s);
})();
