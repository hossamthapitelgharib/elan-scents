/* The home hero picture, as early as the page can know about it.
   Before this file the picture was requested only after the page scripts had loaded, the store data had been fetched, design-layer.js
   had read /design/home.json and the first render had run, so the hero stayed an empty white slot for seconds. This small script sits in
   the <head>: it reads /design/home.json at once (design-layer.js reuses that answer instead of asking again), starts the picture's
   download, and, when the picture arrives, sizes the hero to the picture's own proportions so the whole picture shows instead of a
   centre crop (a picture wider than the hero used to lose its left and right sides).
   An external file because the page policy forbids inline scripts. It changes nothing when the home design has no hero picture. */
(function () {
  'use strict';
  var root = document.documentElement;
  // Same rules design-schema.js applies to every media link (kept equal by tests/hero-early.test.js).
  var PREFIXES = ['/assets/', 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/'];
  var IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i;
  var MIN_HERO = 360;           // the hero keeps room for its title, button and counters under the header
  var current = '', token = 0, held = null;

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
    var a = ed.all && ed.all.hero, b = ed[deviceOf(window.innerWidth)] && ed[deviceOf(window.innerWidth)].hero;
    var pick = function (e) { return e && ((e.style && e.style.media) || (e.media && e.media.src)) || ''; };
    return safe(pick(b) || pick(a));
  }

  function clear() {
    root.classList.remove('hero-fit', 'hero-contain');
    root.style.removeProperty('--hero-ar');
    root.style.removeProperty('--hero-img');
  }

  /* Wider than the hero can be at its smallest height: the picture is shown whole (contain) over a blurred copy of itself. */
  function tooWide() {
    var ar = parseFloat(root.style.getPropertyValue('--hero-ar'));
    return ar > 0 && window.innerWidth / ar < MIN_HERO;
  }
  function syncContain() { if (root.classList.contains('hero-fit')) root.classList.toggle('hero-contain', tooWide()); }

  function fit(src) {
    src = safe(src);
    if (src === current) return;
    current = src;
    var mine = ++token;
    if (!src) { held = null; clear(); return; }
    var img = new Image();
    held = img;                                   // keep it alive until it has loaded
    try { img.fetchPriority = 'high'; } catch (e) { /* optional */ }
    img.decoding = 'async';
    img.onload = function () {
      if (mine !== token || !img.naturalWidth || !img.naturalHeight) return;
      var ar = img.naturalWidth / img.naturalHeight;
      if (!(ar > 0.2 && ar < 5)) return;          // an odd strip: leave the hero as it was
      root.style.setProperty('--hero-ar', ar.toFixed(4));
      root.style.setProperty('--hero-img', 'url("' + src + '")');
      root.classList.add('hero-fit');
      syncContain();
    };
    img.src = src;
  }

  window.ElanHeroFit = fit;
  window.addEventListener('resize', syncContain);

  // design-layer.js takes this answer instead of fetching the same file again.
  try {
    window.__elanDesignJson = fetch('/design/home.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { try { fit(heroPicture(json)); } catch (e) { /* optional */ } return json; })
      .catch(function () { return null; });
  } catch (e) { /* no fetch: design-layer.js asks for the file itself */ }
})();
