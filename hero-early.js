/* The home hero picture, as early as the page can know about it.
   Before this file the picture was requested only after the page scripts had loaded, the store data had been fetched, design-layer.js
   had read /design/home.json and the first render had run, so the hero stayed an empty slot for seconds. This small script sits in the
   <head>: it reads /design/home.json at once (design-layer.js reuses that answer instead of asking again), starts the picture's download
   (the Cloudflare build also sends it as a Link preload header, so the download usually started before this script ran), and gives
   <html> what the stylesheet uses:
     --hero-img     the picture, drawn whole (never cropped) over a blurred copy of itself, with no background colour of its own;
     hero-img       a hero picture exists;
     hero-pending   the picture is still on its way: the hero's dark veil, title and counters wait for it, and the header stays gold,
                    so a half-built hero (white text on a bare page) is never shown. Removed when the picture is in, failed, or after 15 s;
   The Cloudflare build (scripts/build-cloudflare.js) also writes the design's picture into the page itself (class hero-img and
   --hero-img in the first <style>), so the first frame already shows it; this file then adopts that picture, tracks its load, and
   still reconciles with the live design file below.
   When the build also copied the picture to this site (a Supabase object is stored with "no-cache": every visit would ask Supabase
   about it before drawing anything), the page names the pairs "<address the design names> <copy>" in --hero-map, and every address
   the design gives is swapped for its copy here. A copy that fails to load falls back to the design's own address.
   An external file because the page policy forbids inline scripts. It changes nothing when the home design has no hero picture. */
(function () {
  'use strict';
  var root = document.documentElement;
  // Same rules design-schema.js applies to every media link (kept equal by tests/hero-early.test.js).
  var PREFIXES = ['/assets/', 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/'];
  var IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
  var WAIT_MS = 15000;
  var current = '', token = 0, held = null, timer = 0;
  var mirrors = {}, origins = {};                 // design address -> copy on this site, and back

  function deviceOf(width) { return width < 640 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop'; }

  function safe(url) {
    if (typeof url !== 'string' || url.length > 500 || /[\u0000- \u007f"'<>\\]/.test(url) || url.indexOf('..') !== -1) return '';
    if (!IMAGE_EXT.test(url)) return '';
    for (var i = 0; i < PREFIXES.length; i++) if (url.indexOf(PREFIXES[i]) === 0 && url.length > PREFIXES[i].length) return url;
    return '';
  }

  /* The hero picture of the design for this screen size: the size-specific edit on top of "all", like design-layer.js merges them. */
  function heroPicture(json) {
    var ed = json && json.edits;
    if (!ed || typeof ed !== 'object') return '';
    var device = deviceOf(window.innerWidth);
    var a = ed.all && ed.all.hero, b = ed[device] && ed[device].hero;
    var pick = function (e) { return e && ((e.style && e.style.media) || (e.media && e.media.src)) || ''; };
    return safe(pick(b) || pick(a));
  }

  /* The picture the page itself already names (written by the build into its first <style>): the one the stylesheet is drawing. */
  function named() {
    try {
      var v = window.getComputedStyle(root).getPropertyValue('--hero-img');
      var m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/.exec(v || '');
      return m ? safe(m[1] || m[2] || m[3] || '') : '';
    } catch (e) { return ''; }
  }

  /* The copies the build made (--hero-map in the first <style>): "<design address> <copy>" pairs. */
  function readMirrors() {
    try {
      var v = window.getComputedStyle(root).getPropertyValue('--hero-map') || '';
      var m = /^\s*(?:"([^"]*)"|'([^']*)')\s*$/.exec(v);
      var parts = m ? (m[1] || m[2] || '').split(' ') : [];
      for (var i = 0; i + 1 < parts.length; i += 2) {
        var from = safe(parts[i]), to = safe(parts[i + 1]);
        if (from && to) { mirrors[from] = to; origins[to] = from; }
      }
    } catch (e) { /* optional */ }
  }

  function settle(mine) {
    if (mine !== token) return;
    clearTimeout(timer);
    root.classList.remove('hero-pending');
  }

  function fit(src) {
    src = safe(src);
    if (mirrors[src]) src = mirrors[src];
    // The same picture again changes nothing, but "no picture" must still clear a class the page was served with.
    if (src === current && (src || !root.classList.contains('hero-img'))) return;
    current = src;
    var mine = ++token;
    clearTimeout(timer);
    if (!src) {
      held = null;
      root.classList.remove('hero-img', 'hero-pending');
      root.style.removeProperty('--hero-img');
      return;
    }
    root.style.setProperty('--hero-img', 'url("' + src + '")');
    root.classList.add('hero-img', 'hero-pending');
    var img = new Image();
    held = img;                                   // keep it alive until it has loaded
    try { img.fetchPriority = 'high'; } catch (e) { /* optional */ }
    img.decoding = 'async';
    img.onload = function () { settle(mine); };
    img.onerror = function () {
      if (mine !== token) return;
      // The copy on this site is missing or broken: the design's own address is still good.
      var orig = origins[src];
      if (orig) { delete mirrors[orig]; delete origins[src]; fit(orig); return; }
      root.classList.remove('hero-img');          // a picture that will not load must not leave the hero empty
      root.style.removeProperty('--hero-img');
      settle(mine);
    };
    timer = setTimeout(function () { settle(mine); }, WAIT_MS);
    img.src = src;
    // On a repeat visit the picture is already here (the Link preload put it in the memory cache before this script ran): the hero is
    // then final in the very first frame. Waiting for the load event instead let the picture paint first and the veil and the header
    // colours follow a frame or more later, which is what showed as the hero shaking while the page opened.
    if (img.complete && img.naturalWidth > 0) settle(mine);
  }

  /* The hero picture's own pixels (the editor's «نفس شكل الصورة» makes the hero that shape), or null while it is not in yet. */
  fit.size = function () { return held && held.naturalWidth > 0 ? { w: held.naturalWidth, h: held.naturalHeight } : null; };
  window.ElanHeroFit = fit;

  // Until the design file answers, a hero picture is assumed (the page waits instead of flashing a bare hero).
  root.classList.add('hero-pending');
  // The page may already name its picture (Cloudflare build): start tracking that one at once, before the design file answers.
  try { readMirrors(); var first = named(); if (first) fit(first); } catch (e) { /* optional */ }
  // design-layer.js takes this answer instead of fetching the same file again.
  var none = function () { if (!current) root.classList.remove('hero-pending'); };
  try {
    window.__elanDesignJson = fetch('/design/home.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { try { fit(heroPicture(json)); } catch (e) { /* optional */ } none(); return json; })
      .catch(function () { none(); return null; });
  } catch (e) { none(); /* no fetch: design-layer.js asks for the file itself */ }
})();
