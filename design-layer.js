/* Élan Scents — storefront design layer.
   Reads /design/home.json and applies it on top of the existing page after every render().
   Safe by construction: if the file is missing, invalid or empty, the page is left exactly as it is. */
(function () {
  'use strict';
  var ED = window.ElanDesign;
  if (!ED) return;

  var design = null;
  var touched = [];
  var lastDevice = null;
  var SEC_NAMES = { brands: 'الماركات', offers: 'العروض', new: 'وصل حديثًا', cats: 'الأقسام', master: 'الأعلى مبيعًا', occ: 'المناسبات', notes: 'النوتات العطرية', soon: 'قريبًا', stores: 'المتاجر' };
  function inEditor() {
    try { return window.parent !== window && /(?:^|[?&])elan_editor=1(?:&|$)/.test(location.search); } catch (e) { return false; }
  }
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


  function hash(str) { var h = 5381, i; for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }

  /* Every element the editor can touch, with a stable id that does not change between renders. */
  function elements() {
    var out = [], seen = {};
    function add(id, el, kind, name) { if (!el || seen[id]) return; seen[id] = 1; out.push({ id: id, el: el, kind: kind, name: name }); }
    var hero = document.getElementById('hero');
    if (hero) {
      add('hero', hero, 'hero', 'الواجهة الرئيسية');
      add('hero:magic', hero.querySelector('.magic'), 'hero-text', 'نص الواجهة');
      add('hero:counters', hero.querySelector('.counters'), 'hero-counters', 'العدّادات');
    }
    var main = document.getElementById('main');
    if (!main) return out;
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (c.hasAttribute('data-elan-custom')) { add(c.getAttribute('data-elan-id'), c, 'block', 'بلوك إضافي'); return; }
      if (c.tagName !== 'SECTION' || !c.id || ED.BUILTIN.indexOf(c.id) === -1) return;
      add('sec:' + c.id, c, 'section', 'سيكشن ' + (SEC_NAMES[c.id] || c.id));
      add('sec:' + c.id + ':title', c.querySelector('h3'), 'title', 'عنوان ' + (SEC_NAMES[c.id] || c.id));
      var n = 0;
      Array.prototype.slice.call(c.querySelectorAll('.card')).forEach(function (card, i) {
        var base = 'card:' + hash(c.id + '|' + (card.getAttribute('data-go') || 'i' + i)), id = base;
        while (seen[id]) id = base + '-' + (++n);
        var h4 = card.querySelector('h4');
        add(id, card, 'card', 'كارت ' + ((h4 && h4.textContent.trim().slice(0, 24)) || (i + 1)));
      });
    });
    return out;
  }

  function textTarget(e) {
    if (e.kind === 'title') return e.el;
    if (e.kind === 'hero-text') return e.el.querySelector('h2');
    if (e.kind === 'card') return e.el.querySelector('h4');
    if (e.kind === 'block') return e.el.querySelector('p, h3');
    return null;
  }

  function unpaint(el) {
    if (el.__elanBase !== undefined) {
      if (el.__elanBase) el.setAttribute('style', el.__elanBase); else el.removeAttribute('style');
      delete el.__elanBase; el.removeAttribute('data-elan-edited');
    }
    if (el.__elanText) { el.__elanText.node.textContent = el.__elanText.value; delete el.__elanText; }
    if (el.__elanStrip) { var st = el.__elanStrip; if (st.base) st.node.setAttribute('style', st.base); else st.node.removeAttribute('style'); delete el.__elanStrip; }
  }

  function paint(entry, ed) {
    var el = entry.el, st = ed.style || {};
    el.__elanBase = el.getAttribute('style') || '';
    el.setAttribute('data-elan-edited', '1');
    if (ed.hidden || ed.archived) { el.style.display = 'none'; return; }
    if (ed.dx || ed.dy) {
      el.style.transform = 'translate(' + (ed.dx || 0) + 'px,' + (ed.dy || 0) + 'px)';
      el.style.position = el.style.position || 'relative';
      el.style.zIndex = '3';
      var strip = entry.kind === 'card' && el.closest('.strip');
      if (strip && !el.__elanStrip) { el.__elanStrip = { node: strip, base: strip.getAttribute('style') || '' }; strip.style.overflow = 'visible'; }
    }
    if (ed.w) { el.style.width = ed.w + 'px'; el.style.maxWidth = 'none'; el.style.flex = '0 0 auto'; }
    if (ed.h) { el.style.height = ed.h + 'px'; }
    if (st.color) el.style.color = st.color;
    if (st.background) el.style.backgroundColor = st.background;
    if (st.fontSize) el.style.fontSize = st.fontSize + 'px';
    if (st.weight) el.style.fontWeight = String(st.weight);
    if (st.radius !== undefined) el.style.borderRadius = st.radius + 'px';
    if (st.align) el.style.textAlign = st.align === 'start' ? 'start' : st.align === 'end' ? 'end' : 'center';
    if (st.opacity !== undefined) el.style.opacity = String(st.opacity);
    if (ed.text) {
      var node = textTarget(entry), t = ed.text[lang()] || ed.text.ar || ed.text.en;
      if (node && t) { el.__elanText = { node: node, value: node.textContent }; node.textContent = t; }
    }
  }

  /* Free-form edits for the current screen size. Idempotent: always undo the last paint first. */
  function applyEdits() {
    touched.forEach(unpaint);
    touched = [];
    if (!design || !design.edits) return;
    var dev = ED.deviceOf(window.innerWidth);
    elements().forEach(function (entry) {
      var ed = ED.editFor(design, dev, entry.id);
      if (!ed) return;
      paint(entry, ed);
      touched.push(entry.el);
    });
  }

  function apply() {
    var main = document.getElementById('main');
    if (!main || !design || ED.isEmpty(design)) { if (design) applyEdits(); return; }

    // Idempotent: drop what we added before, then re-apply on the freshly rendered page.
    Array.prototype.slice.call(main.querySelectorAll('[data-elan-custom]')).forEach(function (n) { n.remove(); });

    var nodes = {};
    var present = [];
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (c.tagName === 'SECTION' && c.id && ED.BUILTIN.indexOf(c.id) !== -1) { nodes[c.id] = c; present.push(c.id); }
    });

    var plan = ED.plan(design, present, lang());

    plan.hide.forEach(function (id) {
      nodes[id].style.display = 'none';
      nodes[id].setAttribute('data-elan-hidden', '1');
    });
    Object.keys(plan.titles).forEach(function (id) {
      var h = nodes[id].querySelector('h3');
      if (h) h.textContent = plan.titles[id];
    });
    plan.blocks.forEach(function (b) { nodes[b.id] = buildBlock(b); });

    // Only touch the order when the design asks for it or adds blocks.
    plan.order.forEach(function (id) { if (nodes[id]) main.appendChild(nodes[id]); });
    applyEdits();
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
    var editing = inEditor();
    if (!n.ok && !editing) return;
    if (!n.ok) n = { ok: true, design: ED.normalize({ version: ED.VERSION }).design };
    if (ED.isEmpty(n.design) && !editing) return; // nothing to do: page stays untouched
    design = n.design;
    ensureStyle();
    if (typeof D === 'object' && D) ED.applyTexts(D, design);
    wrapRender();
    if (typeof window.render === 'function') window.render();
    if (editing) loadEditMode();
    window.addEventListener('resize', function () {
      var d = ED.deviceOf(window.innerWidth);
      if (d !== lastDevice) { lastDevice = d; try { applyEdits(); } catch (e) { /* keep page usable */ } }
    });
    lastDevice = ED.deviceOf(window.innerWidth);
  }

  function loadEditMode() {
    var b = document.createElement('script');
    b.src = '/elan-host-bridge.js?v=20261010-02';
    b.onload = function () {
      var m = document.createElement('script');
      m.src = '/edit-mode.js?v=20261010-02';
      document.head.appendChild(m);
    };
    document.head.appendChild(b);
  }

  /* Editor only: replace the working design and repaint. */
  function setDesign(next) {
    var n = ED.normalize(next, { strict: false });
    design = n.design;
    ensureStyle();
    wrapRender();
    if (typeof window.render === 'function') window.render();
  }

  window.ElanDesignLayer = { apply: apply, applyEdits: applyEdits, elements: elements, textTarget: textTarget, setDesign: setDesign, current: function () { return design; } };

  fetch('/design/home.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (json) {
      if (!json && inEditor()) json = { version: ED.VERSION };
      if (!json) return;
      waitFor(function () { return typeof window.render === 'function' && document.getElementById('main'); },
        function () { start(json); }, 15000);
    })
    .catch(function () { if (inEditor()) waitFor(function () { return typeof window.render === 'function' && document.getElementById('main'); }, function () { start({ version: ED.VERSION }); }, 15000); /* otherwise the design is optional */ });
})();
