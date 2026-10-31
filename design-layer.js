/* Élan Scents — storefront design layer.
   Reads /design/home.json and applies it on top of the existing page after every render().
   Safe by construction: if the file is missing, invalid or empty, the page is left exactly as it is. */
(function () {
  'use strict';
  var ED = window.ElanDesign;
  if (!ED) return;

  var design = null;
  var editing = false;
  var touched = [];
  var lastDevice = null;
  var SEC_NAMES = { brands: 'الماركات', offers: 'العروض', new: 'وصل حديثًا', cats: 'الأقسام', master: 'الأعلى مبيعًا', occ: 'المناسبات', notes: 'النوتات العطرية', soon: 'قريبًا', stores: 'المتاجر' };
  var STYLE_ID = 'elan-design-style';
  var CSS = [
    '.elan-block{max-width:900px;margin:18px auto;padding:0 16px;box-sizing:border-box}',
    '.elan-align-start{text-align:start}.elan-align-center{text-align:center}.elan-align-end{text-align:end}',
    '.elan-text p{margin:0;line-height:1.9;white-space:pre-line}',
    '.elan-size-sm p,.elan-size-sm h3{font-size:14px}.elan-size-md p,.elan-size-md h3{font-size:17px}',
    '.elan-size-lg p,.elan-size-lg h3{font-size:22px}.elan-size-xl p,.elan-size-xl h3{font-size:30px}',
    '.elan-banner{position:relative;overflow:hidden;isolation:isolate;border-radius:14px;padding:36px 20px;background-size:cover;background-position:center}',
    '.elan-banner>.elan-bgvideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none}',
    '.elan-banner:before{content:"";position:absolute;inset:0;background:rgba(20,12,4,.35)}',
    '.elan-banner>*{position:relative}.elan-banner h3,.elan-banner p{margin:6px 0;color:#fff}',
    '.elan-image img,.elan-image video{max-width:100%;height:auto;display:block;margin:0 auto;border-radius:12px}',
    '.elan-block a{color:inherit;text-decoration:none;display:block}',
    '.elan-smart{max-width:1200px}.elan-smart h3{margin:0 0 12px;text-align:start}',
    /* A free text: a zero-height slot in the flow (nothing moves for it) and the text itself laid over the page from that slot. */
    '.elan-float{position:relative;height:0;max-width:none;margin:0;padding:0;overflow:visible;z-index:100}',
    '.elan-float p{position:absolute;top:0;inset-inline-start:16px;width:320px;min-height:90px;max-width:calc(100% - 32px);margin:0;padding:8px;box-sizing:border-box}'
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
  /* A video the owner put on the page: it plays by itself, muted and looping, like a moving picture (browsers refuse sound without a tap). */
  function videoNode(src) {
    var v = document.createElement('video');
    v.setAttribute('src', src); v.muted = true; v.loop = true; v.autoplay = true;
    v.setAttribute('muted', ''); v.setAttribute('loop', ''); v.setAttribute('autoplay', ''); v.setAttribute('playsinline', ''); v.setAttribute('preload', 'metadata');
    return v;
  }
  function playQuietly(v) { try { var pl = v.play && v.play(); if (pl && pl.catch) pl.catch(function () {}); } catch (_) { /* optional */ } }


  // ----- smart sections: definition + items live in Supabase (public read; RLS hides archived/expired ones) -----
  var smartCache = {};
  window.ElanPendingSections = window.ElanPendingSections || {};   // edit mode only: drafts not saved yet
  function perfumeBy(id) { try { return PERFUMES.filter(function (x) { return String(x.id) === String(id); })[0] || null; } catch (e) { return null; } }
  function sameCatalogName(value, filter) {
    var actual = String(value == null ? '' : value), wanted = String(filter == null ? '' : filter);
    if (actual === wanted) return true;
    try { return typeof esc === 'function' && actual === esc(wanted); } catch (e) { return false; }
  }
  function autoList(f) {
    f = f || {};
    var l = [];
    try {
      l = PERFUMES.map(function (p) {
        var offerSource = f.store ? (p.allOffers || []) : (p.offers || []);
        var offers = offerSource.filter(function (o) {
          return o && o.avail && (!f.store || sameCatalogName(o.store, f.store)) && (!f.flag || (o.flags || []).indexOf(f.flag) > -1);
        });
        offers.sort(function (a, b) { return a.price - b.price; });
        return { p: p, b: offers[0] || null };
      }).filter(function (x) { return x.b; });
    } catch (e) { return []; }
    l = l.filter(function (x) {
      var p = x.p;
      if (f.brand && !sameCatalogName(p.brand, f.brand)) return false;
      if (f.size_ml != null && f.size_ml !== '' && Number(p.sizeMl) !== Number(f.size_ml)) return false;
      if (f.cat && !(p.cats || []).some(function (i) { return sameCatalogName(nmOf('cats', i), f.cat); })) return false;
      if (f.occ && !(p.occs || []).some(function (i) { return sameCatalogName(nmOf('occ', i), f.occ); })) return false;
      if (f.note && !(p.notes || []).some(function (i) { return sameCatalogName(nmOf('notes', i), f.note); })) return false;
      if (f.min !== undefined && f.min !== '' && x.b.price < +f.min) return false;
      if (f.max !== undefined && f.max !== '' && x.b.price > +f.max) return false;
      return true;
    });
    if (f.sort === 'price_asc') l.sort(function (a, b) { return a.b.price - b.b.price; });
    else if (f.sort === 'price_desc') l.sort(function (a, b) { return b.b.price - a.b.price; });
    else l.sort(function (a, b) { return (b.p.rel || 0) - (a.p.rel || 0); });
    return l;
  }
  function manualList(ids) {
    return ids.map(perfumeBy).filter(Boolean).map(function (p) { return { p: p, b: best(p) }; });
  }
  function paint(root, name, list) {
    root.textContent = '';
    if (name) { var h = el('h3'); h.textContent = name; root.appendChild(h); }
    var g = el('div', 'grid section-perfume-grid');
    g.innerHTML = list.map(function (x) { return pc(x); }).join('');   // pc() output is built from the storefront's own escaped data
    root.appendChild(g);
  }
  function fillSmart(root, ref) {
    var pend = window.ElanPendingSections[ref];
    if (pend) { paint(root, pend.name, pend.mode === 'auto' ? autoList(pend.filters) : manualList(pend.items || [])); return; }
    if (typeof SB === 'undefined' || !SB || !SB.url) { root.remove(); return; }
    var hit = smartCache[ref];
    if (hit && Date.now() - hit.t < 60000) { if (hit.def) paint(root, hit.def.name, hit.list()); else root.remove(); return; }
    var H = { apikey: SB.key, Authorization: 'Bearer ' + SB.key };
    fetch(SB.url + '/rest/v1/editor_sections?element_id=eq.' + encodeURIComponent(ref) + '&select=id,name,selection_mode,filters&limit=1', { headers: H })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (!rows.length) { smartCache[ref] = { t: Date.now(), def: null }; root.remove(); return null; }
        var def = rows[0];
        if (def.selection_mode === 'auto') { smartCache[ref] = { t: Date.now(), def: def, list: function () { return autoList(def.filters); } }; paint(root, def.name, autoList(def.filters)); return null; }
        return fetch(SB.url + '/rest/v1/editor_section_items?section_id=eq.' + def.id + '&select=product_size_id&order=sort_order', { headers: H })
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (items) { var ids = items.map(function (i) { return i.product_size_id; }); smartCache[ref] = { t: Date.now(), def: def, list: function () { return manualList(ids); } }; paint(root, def.name, manualList(ids)); });
      })
      .catch(function () { root.remove(); });
  }

  function buildBlock(b) {
    var st = b.style || {};
    var root = el('div', 'elan-block elan-' + b.type + ' elan-size-' + (st.size || 'md') + ' elan-align-' + (st.align || 'center'));
    root.setAttribute('data-elan-id', b.id);
    root.setAttribute('data-elan-custom', '1');
    if (st.color) root.style.color = st.color;
    if (st.background) root.style.backgroundColor = st.background;
    var inner = root;
    if (b.href && b.type !== 'smart') {
      var a = el('a');
      a.setAttribute('href', b.href);
      root.appendChild(a);
      inner = a;
    }
    if (b.type === 'smart') {
      root.classList.add('elan-smart');
      fillSmart(root, b.ref);
    } else if (b.type === 'text') {
      var p = el('p');
      p.textContent = pick(b.text);
      inner.appendChild(p);
      if (b.float) root.classList.add('elan-float');
    } else if (b.type === 'banner') {
      if (b.image) root.style.backgroundImage = 'url("' + b.image + '")';
      if (b.video) { var bv = videoNode(b.video); bv.className = 'elan-bgvideo'; root.appendChild(bv); }
      var t = pick(b.title);
      var s = pick(b.subtitle);
      if (t) { var h = el('h3'); h.textContent = t; inner.appendChild(h); }
      if (s) { var sp = el('p'); sp.textContent = s; inner.appendChild(sp); }
    } else if (b.type === 'image') {
      if (ED.isVideoUrl && ED.isVideoUrl(b.src)) {
        var vv = videoNode(b.src);
        vv.setAttribute('aria-label', pick(b.alt));
        inner.appendChild(vv);
      } else {
        var img = el('img');
        img.setAttribute('src', b.src);
        img.setAttribute('alt', pick(b.alt));
        img.setAttribute('loading', 'lazy');
        inner.appendChild(img);
      }
    }
    return root;
  }

  function hash(str) { var h = 5381, i; for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }

  /* A free text has no box of its own (its slot is zero high), so the text inside is the element the editor selects and moves. */
  function blockNode(b) { return b.classList && b.classList.contains('elan-float') && b.firstElementChild ? b.firstElementChild : b; }

  /* Every element the editor can touch, with a stable id that does not change between renders. */
  function elements() {
    var out = [], seen = {};
    function add(id, el, kind, name) { if (!el || seen[id]) return; seen[id] = 1; out.push({ id: id, el: el, kind: kind, name: name }); }
    var hero = document.getElementById('hero');
    if (hero) {
      add('hero', hero, 'hero', 'الواجهة الرئيسية');
    }
    /* The title, its arrow and the counters sit just under the hero (#intro), but keep the ids they had inside it so saved edits still match. */
    add('hero:magic', document.querySelector('#intro .magic'), 'hero-text', 'نص الواجهة');
    add('hero:counters', document.querySelector('#intro .counters'), 'hero-counters', 'العدّادات');
    var V = document.getElementById('view');
    if (V && document.body.classList.contains('inner')) {
      var pk = hash(pageKey() || 'page'), vn = 0;
      var vt = V.querySelector('h3'); if (vt) add('pg:' + pk + ':title', vt, 'title', 'عنوان الصفحة');
      Array.prototype.slice.call(V.querySelectorAll('[data-elan-custom]')).forEach(function (b) { add(b.getAttribute('data-elan-id'), blockNode(b), 'block', 'بلوك إضافي'); });
      Array.prototype.slice.call(V.querySelectorAll('.card')).forEach(function (card, i) {
        var base = 'pcard:' + pk + hash(card.getAttribute('data-go') || 'i' + i), id = base;
        while (seen[id]) id = base + '-' + (++vn);
        var h4 = card.querySelector('h4');
        add(id, card, 'card', 'كارت ' + ((h4 && h4.textContent.trim().slice(0, 24)) || (i + 1)));
      });
    }
    /* The parts of the page below the sections: about, contact and every part of the footer. */
    if (!document.body.classList.contains('inner')) {
      add('about', document.getElementById('about'), 'section', 'قسم عن إيلان سينتس');
      Array.prototype.slice.call(document.querySelectorAll('#abIn p')).forEach(function (p, i) {
        add('about:p' + (i || ''), p, 'text-area', 'فقرة عن إيلان سينتس ' + (i + 1));
      });
      add('about:logo', document.querySelector('#about .alogo'), 'section', 'شعار عن إيلان سينتس');
      var ct = document.getElementById('contact');
      add('contact', ct, 'section', 'قسم تواصل معنا');
      add('contact:title', ct && ct.querySelector('h3'), 'title', 'عنوان تواصل معنا');
    }
    var ft = document.querySelector('footer');
    if (ft) {
      add('footer', ft, 'section', 'الفوتر');
      add('footer:logo', ft.querySelector('.footer-logo'), 'image-el', 'شعار الفوتر');
      add('footer:cols', document.getElementById('fcols'), 'group', 'روابط الفوتر');
      add('footer:channels', document.getElementById('fch'), 'group', 'قنوات التواصل');
      add('footer:phones', document.getElementById('fph'), 'group', 'أرقام الفوتر');
      add('footer:bar', document.getElementById('fbar'), 'group', 'شريط الفوتر');
      add('footer:credit', document.getElementById('fcr'), 'text-area', 'حقوق الفوتر');
      Array.prototype.slice.call(ft.querySelectorAll('#fcols h5')).forEach(function (h, i) { add('footer:h' + (i || ''), h, 'text-area', 'عنوان في الفوتر ' + (i + 1)); });
      Array.prototype.slice.call(ft.querySelectorAll('#fcols a')).forEach(function (l, i) { add('footer:l' + (i || ''), l, 'text-area', 'رابط في الفوتر: ' + l.textContent.trim().slice(0, 20)); });
      Array.prototype.slice.call(ft.querySelectorAll('#fbar span')).forEach(function (sp, i) { add('footer:b' + (i || ''), sp, 'text-area', 'نص شريط الفوتر ' + (i + 1)); });
    }
    var main = document.getElementById('main');
    if (!main) return out;
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (c.hasAttribute('data-elan-custom')) { add(c.getAttribute('data-elan-id'), blockNode(c), 'block', 'بلوك إضافي'); return; }
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
    if (e.kind === 'title' || e.kind === 'text-area') return e.el;
    if (e.kind === 'hero-text') return e.el.querySelector('h2');
    if (e.kind === 'card') return e.el.querySelector('h4');
    if (e.kind === 'block') return e.el.matches && e.el.matches('p, h3') ? e.el : e.el.querySelector('p, h3');
    return null;
  }

  function unpaint(el) {
    if (el.__elanBase !== undefined) {
      if (el.__elanBase) el.setAttribute('style', el.__elanBase); else el.removeAttribute('style');
      delete el.__elanBase; el.removeAttribute('data-elan-edited');
    }
    if (el.__elanMedia) { el.__elanMedia.forEach(function (u) { try { u(); } catch (_) { /* keep going */ } }); delete el.__elanMedia; }
    if (el.__elanText) {
      var t = el.__elanText; t.node.textContent = t.children && t.children.length ? '' : t.value;
      (t.children || []).forEach(function (child) { t.node.appendChild(child); }); delete el.__elanText;
    }
    if (el.__elanStrip) { var st = el.__elanStrip; if (st.base) st.node.setAttribute('style', st.base); else st.node.removeAttribute('style'); delete el.__elanStrip; }
  }

  /* A card's own artwork (a picture or a drawing) sits over the card; to show anything else, or to leave the white base, it is hidden.
     style.css gives the card its own !important rules, so only an inline !important wins. */
  function hideArt(el, undo) {
    var art = el.querySelector('.artbg');
    if (!art) return;
    var shown = art.style.display;
    art.style.setProperty('display', 'none', 'important');
    undo.push(function () { art.style.setProperty('display', shown || ''); });
  }

  /* Replace the picture or video of an element: the hero video, a card picture, or a section background. Reversible. */
  function paintMedia(entry, m) {
    if (typeof m === 'string') m = { src: m, kind: ED.isVideoUrl && ED.isVideoUrl(m) ? 'video' : 'image' };
    var el = entry.el, undo = el.__elanMedia = el.__elanMedia || [];
    var video = entry.kind === 'hero' ? el.querySelector('#heroVideo, video') : null;
    if (video) {
      var prev = { src: video.getAttribute('src'), poster: video.getAttribute('poster'), display: video.style.display, srcs: Array.prototype.map.call(video.querySelectorAll('source'), function (n) { return [n, n.getAttribute('src')]; }) };
      /* The hero is a white slot; the picture or the video sits on top of it. data-media tells style.css so (it drops the white-slot
         look: the dark overlay and the dark text are only for a hero with nothing behind them to cover). */
      el.setAttribute('data-media', m.kind === 'video' ? 'video' : 'image');
      /* hero-early.js sizes the hero to a hero picture's own proportions (the whole picture shows); a video keeps the plain hero. */
      if (typeof window.ElanHeroFit === 'function') window.ElanHeroFit(m.kind === 'video' ? '' : m.src);
      undo.push(function () {
        if (typeof window.ElanHeroFit === 'function') window.ElanHeroFit('');
        el.removeAttribute('data-media');
        video.style.display = prev.display;
        if (prev.poster !== null) video.setAttribute('poster', prev.poster);
        prev.srcs.forEach(function (p) { p[0].setAttribute('src', p[1]); });
        if (prev.src === null) video.removeAttribute('src'); else video.setAttribute('src', prev.src);
        try { video.load(); var pl = video.play(); if (pl && pl.catch) pl.catch(function () {}); } catch (_) { /* optional */ }
      });
      if (m.kind === 'video') {
        prev.srcs.forEach(function (p) { p[0].setAttribute('src', m.src); });
        video.setAttribute('src', m.src); video.removeAttribute('poster');
        try { video.load(); var p2 = video.play(); if (p2 && p2.catch) p2.catch(function () {}); } catch (_) { /* optional */ }
      } else {
        try { video.pause(); } catch (_) { /* optional */ }
        /* style.css pins the hero's background and its video's display with !important, and a plain inline value loses to that: the
           picture was saved but never showed (the old video kept playing over it). Only an inline !important wins. Undo clears it
           again with `video.style.display = prev.display`, and the hero's own style is restored by unpaint. */
        video.style.setProperty('display', 'none', 'important');
        undo.push(function () { /* hero style is restored by unpaint */ });
        el.style.setProperty('background-image', 'url("' + m.src + '")', 'important');
        el.style.setProperty('background-size', 'cover', 'important');
        el.style.setProperty('background-position', 'center', 'important');
      }
      return;
    }
    var img = el.tagName === 'IMG' ? el : el.querySelector('.artbg img, img');
    if (img && m.kind === 'video' && img.parentNode) {
      // the card's (or the element's) picture is swapped for the video in the same place; the picture itself stays, hidden, for undo
      var swap = videoNode(m.src), shown = img.style.display;
      swap.className = img.className; swap.style.cssText = 'display:block;width:100%;height:100%;object-fit:cover';
      img.style.display = 'none'; img.parentNode.insertBefore(swap, img.nextSibling);
      undo.push(function () { swap.remove(); img.style.display = shown; });
      playQuietly(swap);
      return;
    }
    if (img && m.kind !== 'video') {
      var old = { src: img.getAttribute('src'), srcset: img.getAttribute('srcset') };
      undo.push(function () { img.setAttribute('src', old.src); if (old.srcset === null) img.removeAttribute('srcset'); else img.setAttribute('srcset', old.srcset); });
      img.removeAttribute('srcset'); img.setAttribute('src', m.src);
      return;
    }
    if (entry.kind === 'card') hideArt(el, undo);   // the card's drawing would otherwise stay on top of the new picture or video
    if (m.kind === 'video') {
      var v = document.createElement('video');
      v.src = m.src; v.muted = true; v.loop = true; v.autoplay = true; v.setAttribute('playsinline', '');
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none';
      if (!el.style.position) el.style.position = 'relative';
      el.insertBefore(v, el.firstChild);
      undo.push(function () { v.remove(); });
      try { var p3 = v.play(); if (p3 && p3.catch) p3.catch(function () {}); } catch (_) { /* optional */ }
      return;
    }
    el.style.setProperty('background-image', 'url("' + m.src + '")', 'important');
    el.style.setProperty('background-size', 'cover', 'important');
    el.style.setProperty('background-position', 'center', 'important');
  }

  /* Extra web fonts load only when a saved design really uses one; device and shipped fonts need nothing. */
  var loadedFonts = {};
  function loadFont(name) {
    if (!ED.WEB_FONTS || ED.WEB_FONTS.indexOf(name) === -1 || loadedFonts[name]) return;
    loadedFonts[name] = true;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name).replace(/%20/g, '+') + ':wght@400;700&display=swap';
    document.head.appendChild(l);
  }

  function paint(entry, ed) {
    var el = entry.el, st = ed.style || {};
    el.__elanBase = el.getAttribute('style') || '';
    el.setAttribute('data-elan-edited', '1');
    if (ed.hidden || ed.archived) {
      if (entry.kind === 'hero') return;   // the hero is the page's white base: deleting it only removes what sat on top of it
      el.style.setProperty('display', 'none', 'important'); return;
    }
    if (ed.dx || ed.dy) {
      el.style.transform = 'translate(' + (ed.dx || 0) + 'px,' + (ed.dy || 0) + 'px)';
      if (!el.style.position && getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.style.zIndex = '3';
      var strip = entry.kind === 'card' && el.closest('.strip');
      if (strip && !el.__elanStrip) { el.__elanStrip = { node: strip, base: strip.getAttribute('style') || '' }; strip.style.overflow = 'visible'; }
    }
    if (ed.w) { el.style.width = ed.w + 'px'; el.style.maxWidth = 'none'; el.style.flex = '0 0 auto'; }
    if (ed.h) { el.style.height = ed.h + 'px'; }
    if (st.color) el.style.color = st.color;
    if (st.background) el.style.backgroundColor = st.background;
    if (st.media) paintMedia(entry, st.media);
    if (st.fontSize) el.style.fontSize = st.fontSize + 'px';
    if (st.weight) el.style.fontWeight = String(st.weight);
    if (st.radius !== undefined) el.style.borderRadius = st.radius + 'px';
    if (st.align) el.style.textAlign = ({ start: 'start', end: 'end', center: 'center', left: 'left', right: 'right' })[st.align] || 'center';
    if (st.fontFamily) { loadFont(st.fontFamily); el.style.fontFamily = st.fontFamily === 'system-ui' ? 'system-ui, sans-serif' : '"' + st.fontFamily + '", sans-serif'; }
    if (st.effect === 'soft') { el.style.textShadow = '0 1px 0 #fff,0 3px 4px rgba(0,0,0,.22)'; el.style.boxShadow = '0 7px 18px rgba(0,0,0,.14)'; }
    if (st.effect === 'gold') { el.style.color = st.color || '#ae852e'; el.style.textShadow = '0 1px 0 #fceab1,0 2px 0 #77541e,0 4px 6px rgba(80,52,0,.3)'; el.style.boxShadow = '0 2px 0 #d6bc79,0 9px 22px rgba(101,72,18,.22)'; }
    if (st.effect === 'deep') { el.style.textShadow = '1px 1px 0 rgba(255,255,255,.6),2px 3px 3px rgba(0,0,0,.3)'; el.style.boxShadow = '0 4px 0 rgba(0,0,0,.13),0 14px 26px rgba(0,0,0,.2)'; }
    if (st.opacity !== undefined) el.style.opacity = String(st.opacity);
    if (ed.media && ed.media.src) paintMedia(entry, ed.media);
    if (ed.noMedia && entry.kind === 'card' && !st.media && !(ed.media && ed.media.src)) {
      /* the card's own picture was deleted in the editor: the card is its white base until a picture or a video is added */
      el.__elanMedia = el.__elanMedia || [];
      hideArt(el, el.__elanMedia); el.setAttribute('data-no-media', '1');
      el.__elanMedia.push(function () { el.removeAttribute('data-no-media'); });
    }
    if (ed.text) {
      var node = textTarget(entry), t = ed.text[lang()] || ed.text.ar || ed.text.en;
      if (node && t) { el.__elanText = { node: node, value: node.textContent, children: Array.prototype.slice.call(node.childNodes) }; node.textContent = t; }
    }
  }

  /* Free-form edits for the current screen size. Idempotent: always undo the last paint first. */
  function applyEdits() {
    touched.forEach(unpaint);
    touched = [];
    if (!design || (!design.edits && !design.pages)) return;
    var dev = ED.deviceOf(window.innerWidth);
    var key = pageKey(), pg = design.pages && design.pages[key], view = document.getElementById('view');
    elements().forEach(function (entry) {
      var ed = ED.editFor(design, dev, entry.id);
      if (pg && view && view.contains(entry.el)) {
        var local = ED.editFor(pg, dev, entry.id);
        if (local) ed = Object.assign({}, ed || {}, local, { style: Object.assign({}, ed && ed.style, local.style) });
      }
      if (!ed) return;
      paint(entry, ed);
      touched.push(entry.el);
    });
  }

  function apply() {
    var main = document.getElementById('main');
    if (!main || !design) return;
    if (ED.isEmpty(design)) { applyEdits(); return; }

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
    applyCardOrder(); // the cards the owner dropped between others, in the order he dropped them
    applyEdits(); // free-form edits from the visual editor, for the current screen size
  }


  // Inner pages (brands, stores, categories, occasions, notes, collections): blocks go at the top or bottom of #view.
  function pageKey() {
    if (!document.body.classList.contains('inner')) return 'home';
    try {
      var x = P[P.length - 1];
      if (!x) return null;
      if (x.k === 'sec') return 'sec:' + x.id;
      if (x.k === 'col') return 'col:' + x.id + ':' + x.i;
      if (x.k === 'prod') return 'prod:' + x.sid;
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

  /* An element that opens another page when a visitor clicks it (cards, lists): its go-target, or null. */
  function goTargetOf(el) {
    var n = el && el.closest ? el.closest('[data-go]') : null;
    return n ? n.getAttribute('data-go') : null;
  }

  /* Automatic displacement saved by the editor: the cards of one container in the order the owner dropped them.
     Cards a saved list does not know about (a new product, say) keep their natural order after the listed ones.
     Cards swap places with each other, so buttons or other things that sit between them stay where they are. */
  function sortCards(root, ids) {
    var cards = elements().filter(function (e) { return e.kind === 'card' && root.contains(e.el); });
    var groups = [];
    cards.forEach(function (e) {
      var parent = e.el.parentNode, g = groups.filter(function (x) { return x.parent === parent; })[0];
      if (!g) groups.push(g = { parent: parent, cards: [] });
      g.cards.push(e.el);
    });
    groups.forEach(function (g) {
      var rank = function (el) { var e = cards.filter(function (c) { return c.el === el; })[0], i = e ? ids.indexOf(e.id) : -1; return i === -1 ? 1e6 : i; };
      var natural = Array.prototype.filter.call(g.parent.children, function (c) { return g.cards.indexOf(c) !== -1; });
      var wanted = natural.map(function (el, i) { return { el: el, i: i, r: rank(el) }; })
        .sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.el; });
      if (wanted.every(function (el, i) { return el === natural[i]; })) return;
      var slots = natural.map(function (el) { var m = document.createComment(''); g.parent.insertBefore(m, el); return m; });
      wanted.forEach(function (el, i) { g.parent.replaceChild(el, slots[i]); });
    });
  }
  function applyCardOrder() {
    if (!design) return;
    var inner = document.body.classList.contains('inner'), view = document.getElementById('view');
    if (!inner) {
      var map = design.cardOrder || {};
      Object.keys(map).forEach(function (key) {
        var section = document.getElementById(key);
        if (section && section.tagName === 'SECTION' && section.parentNode && section.parentNode.id === 'main') sortCards(section, map[key]);
      });
    } else if (view) {
      var pg = design.pages && design.pages[pageKey()];
      if (pg && pg.cardOrder && pg.cardOrder.view) sortCards(view, pg.cardOrder.view);
    }
  }

  function wrapView() {
    var orig = window.view;
    if (typeof orig !== 'function' || orig.__elanDesign) return;
    var wrapped = function () {
      var r = orig.apply(this, arguments);
      try { applyPage(); applyCardOrder(); applyEdits(); } catch (e) { console.error('design layer', e); }
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

  window.ElanDesignLayer = { apply: apply, set: set, pageKey: pageKey, current: function () { return design; }, applyEdits: applyEdits, elements: elements, textTarget: textTarget, goTargetOf: goTargetOf };

  // A different screen size means a different set of free-form edits.
  window.addEventListener('resize', function () {
    if (!design || (!design.edits && !design.pages)) return;
    var d = ED.deviceOf(window.innerWidth);
    if (d !== lastDevice) { lastDevice = d; try { applyEdits(); } catch (e) { /* keep the page usable */ } }
  });
  lastDevice = ED.deviceOf(window.innerWidth);

  /* hero-early.js (in the page head) has usually asked for the design file already: take its answer instead of fetching it again. */
  (window.__elanDesignJson || fetch('/design/home.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }))
    .then(function (json) {
      if (!json) return;
      waitFor(function () { return typeof window.render === 'function' && document.getElementById('main'); },
        function () { start(json); }, 15000);
    })
    .catch(function () { /* design is optional */ });
})();
