/* Élan Scents — storefront design layer.
   Reads /design/home.json and applies it on top of the existing page after every render().
   Safe by construction: if the file is missing, invalid or empty, the page is left exactly as it is. */
(function () {
  'use strict';
  var ED = window.ElanDesign;
  if (!ED) return;

  var design = null;
  var editing = false;
  var STYLE_ID = 'elan-design-style';
  var CSS = [
    '.elan-block{max-width:900px;margin:18px auto;padding:0 16px;box-sizing:border-box}',
    '.elan-align-start{text-align:start}.elan-align-center{text-align:center}.elan-align-end{text-align:end}',
    '.elan-text p{margin:0;line-height:1.9;white-space:pre-line}',
    '.elan-size-sm p,.elan-size-sm h3{font-size:14px}.elan-size-md p,.elan-size-md h3{font-size:17px}',
    '.elan-size-lg p,.elan-size-lg h3{font-size:22px}.elan-size-xl p,.elan-size-xl h3{font-size:30px}',
    '.elan-banner{position:relative;overflow:hidden;border-radius:14px;padding:36px 20px;background-size:cover;background-position:center}',
    '.elan-banner:before{content:"";position:absolute;inset:0;background:rgba(20,12,4,.35)}',
    '.elan-banner>*{position:relative}.elan-banner h3,.elan-banner p{margin:6px 0;color:#fff}',
    '.elan-image img{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:12px}',
    '.elan-block a{color:inherit;text-decoration:none;display:block}'
  ].join('\n');

  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'ar'; }
  function pick(o) { return o ? (o[lang()] || o.ar || o.en || '') : ''; }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function buildBlock(b) {
    var st = b.style || {};
    var root = el('div', 'elan-block elan-' + b.type + ' elan-size-' + (st.size || 'md') + ' elan-align-' + (st.align || 'center'));
    root.setAttribute('data-elan-id', b.id);
    root.setAttribute('data-elan-custom', '1');
    if (st.color) root.style.color = st.color;
    if (st.background) root.style.backgroundColor = st.background;
    var inner = root;
    if (b.href) {
      var a = el('a');
      a.setAttribute('href', b.href);
      root.appendChild(a);
      inner = a;
    }
    if (b.type === 'text') {
      var p = el('p');
      p.textContent = pick(b.text);
      inner.appendChild(p);
    } else if (b.type === 'banner') {
      if (b.image) root.style.backgroundImage = 'url("' + b.image + '")';
      var t = pick(b.title);
      var s = pick(b.subtitle);
      if (t) { var h = el('h3'); h.textContent = t; inner.appendChild(h); }
      if (s) { var sp = el('p'); sp.textContent = s; inner.appendChild(sp); }
    } else if (b.type === 'image') {
      var img = el('img');
      img.setAttribute('src', b.src);
      img.setAttribute('alt', pick(b.alt));
      img.setAttribute('loading', 'lazy');
      inner.appendChild(img);
    }
    return root;
  }

  function apply() {
    var main = document.getElementById('main');
    if (!main || !design || ED.isEmpty(design)) return;

    // Idempotent: drop what we added before, then re-apply on the freshly rendered page.
    Array.prototype.slice.call(main.querySelectorAll('[data-elan-custom]')).forEach(function (n) { n.remove(); });

    var nodes = {};
    var present = [];
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (c.tagName === 'SECTION' && c.id && ED.BUILTIN.indexOf(c.id) !== -1) { nodes[c.id] = c; present.push(c.id); }
    });

    var plan = ED.plan(design, present, lang());

    plan.hide.forEach(function (id) {
      nodes[id].setAttribute('data-elan-hidden', '1');
      if (editing) nodes[id].style.opacity = '.4'; else nodes[id].style.display = 'none';
    });
    Object.keys(plan.titles).forEach(function (id) {
      var h = nodes[id].querySelector('h3');
      if (h) h.textContent = plan.titles[id];
    });
    plan.blocks.forEach(function (b) { nodes[b.id] = buildBlock(b); });

    // Only touch the order when the design asks for it or adds blocks.
    plan.order.forEach(function (id) { if (nodes[id]) main.appendChild(nodes[id]); });
  }


  // Inner pages (brands, stores, categories, occasions, notes, collections): blocks go at the top or bottom of #view.
  function pageKey() {
    if (!document.body.classList.contains('inner')) return 'home';
    try {
      var x = P[P.length - 1];
      if (!x) return null;
      if (x.k === 'sec') return 'sec:' + x.id;
      if (x.k === 'col') return 'col:' + x.id + ':' + x.i;
      if (x.k === 'brand') return 'brand:' + x.n;
      if (x.k === 'store') return 'store:' + x.n;
    } catch (e) { /* no page stack yet */ }
    return null;
  }

  function applyPage() {
    var V = document.getElementById('view');
    if (!V || !design) return;
    Array.prototype.slice.call(V.querySelectorAll('[data-elan-custom]')).forEach(function (n) { n.remove(); });
    var key = pageKey(), pg = design.pages && key && design.pages[key];
    if (!pg) return;
    var top = pg.blocks.filter(function (b) { return b.slot !== 'bottom'; });
    var bottom = pg.blocks.filter(function (b) { return b.slot === 'bottom'; });
    var h = V.querySelector('h3'), ref = h || null;
    top.forEach(function (b) {
      var n = buildBlock(b);
      if (ref) { ref.parentNode.insertBefore(n, ref.nextSibling); ref = n; } else { V.insertBefore(n, V.firstChild); ref = n; }
    });
    bottom.forEach(function (b) { V.appendChild(buildBlock(b)); });
  }

  function wrapView() {
    var orig = window.view;
    if (typeof orig !== 'function' || orig.__elanDesign) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try { applyPage(); } catch (e) { console.error('design layer', e); }
      return r;
    };
    wrapped.__elanDesign = true;
    window.view = wrapped;
  }

  function waitFor(test, cb, timeoutMs) {
    var t0 = Date.now();
    (function tick() {
      if (test()) return cb();
      if (Date.now() - t0 > timeoutMs) return;
      setTimeout(tick, 60);
    })();
  }

  function wrapRender() {
    var orig = window.render;
    if (typeof orig !== 'function' || orig.__elanDesign) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try { apply(); } catch (e) { console.error('design layer', e); }
      return r;
    };
    wrapped.__elanDesign = true;
    window.render = wrapped;
  }

  function start(json) {
    var n = ED.normalize(json, { strict: false });
    if (!n.ok || ED.isEmpty(n.design)) return; // nothing to do: page stays untouched
    design = n.design;
    ensureStyle();
    if (typeof D === 'object' && D) ED.applyTexts(D, design);
    wrapRender(); wrapView();
    if (typeof window.render === 'function') window.render();
    if (document.body.classList.contains('inner') && typeof window.view === 'function') window.view();
  }

  // Used only by the editor's edit mode: swap in a draft design and redraw. Customers never call this.
  function set(json, opts) {
    var n = ED.normalize(json, { strict: false });
    if (!n.ok) return false;
    editing = !!(opts && opts.editing);
    design = n.design;
    ensureStyle();
    if (typeof D === 'object' && D) ED.applyTexts(D, design);
    wrapRender(); wrapView();
    if (typeof window.render === 'function') window.render();
    if (document.body.classList.contains('inner') && typeof window.view === 'function') window.view();
    return true;
  }

  window.ElanDesignLayer = { apply: apply, set: set, pageKey: pageKey, current: function () { return design; } };

  fetch('/design/home.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (json) {
      if (!json) return;
      waitFor(function () { return typeof window.render === 'function' && document.getElementById('main'); },
        function () { start(json); }, 15000);
    })
    .catch(function () { /* design is optional */ });
})();
