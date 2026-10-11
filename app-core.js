/* Restore full core from last good commit, then remove only Follow Us text links (keep social icons). */
(function () {
  var s = document.createElement('script');
  s.src = 'https://raw.githubusercontent.com/hossamthapitelgharib/elan-scents/a5c9a6ea1de9aa92d0f65c40502aea7db971ac98/app-core.js';
  s.onload = function () {
    if (typeof footer18 !== 'function') return;
    var original = footer18;
    footer18 = function (t) {
      original(t);
      var el = document.getElementById('fcols');
      if (!el) return;
      var nodes = Array.prototype.slice.call(el.querySelectorAll('h5'));
      nodes.forEach(function (h) {
        var label = (h.textContent || '').trim();
        if (label === 'تابعنا' || label === 'Follow us') {
          var n = h.nextSibling;
          while (n && n.nodeType === 3) n = n.nextSibling;
          // remove following social text links until next h5/div
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
        }
      });
    };
    try {
      footer18(typeof T === 'function' ? T() : {});
    } catch (e) {}
  };
  s.onerror = function () {
    console.error('failed to restore app-core.js');
  };
  document.head.appendChild(s);
})();
