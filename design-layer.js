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
    /* The top bar was hidden in the editor: the header, which sits just under it, goes up to the top. */
    'html body.elan-no-bar header{top:0!important}',
    /* A free text: a zero-height slot in the flow (nothing moves for it) and the text itself laid over the page from that slot. */
    /* A picture or a video in an element that was given a size: shown whole (never cut, never stretched); what the shape of the frame leaves over around it is the same picture, blurred (see fitMedia). */
    '[data-elan-fit]{isolation:isolate}.elan-image[data-elan-fit]{overflow:hidden;border-radius:12px}',
    '.elan-fit-back{position:absolute!important;inset:-40px;z-index:-1;pointer-events:none;background-position:center;background-size:cover;background-repeat:no-repeat;filter:blur(26px);clip-path:inset(40px)}',
    'video.elan-fit-back{width:calc(100% + 80px);height:calc(100% + 80px);object-fit:cover}',
    '.elan-fit-front{position:absolute!important;inset:0;z-index:-1;pointer-events:none;background-position:center;background-size:contain;background-repeat:no-repeat}',
    /* The platform's two fixed gaps (owner, 2026-11-12): the space between one row of the page and the next (--elan-gap-y: the page's own rhythm between sections, 14px + 22px + 46px of padding ≈ 80px)
       and the space between two things in one row (--elan-gap-x: the gap the platform already leaves between its cards). Rows built by the editor use these and nothing else. */
    ':root{--elan-gap-y:80px;--elan-gap-x:var(--cg,16px)}',
    '.elan-row{display:flex;flex-wrap:nowrap;justify-content:center;align-items:flex-start;column-gap:var(--elan-gap-x);box-sizing:border-box;width:100%;max-width:1200px;margin-inline:auto;padding-inline:var(--cp,16px)}',
    '.elan-row>*{margin:0!important;min-width:0;max-width:100%;flex:1 1 0!important}',
    '.elan-row>.elan-block{padding-inline:0;max-width:100%}',
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
  function genderKey(value) {
    var s = String(value == null ? '' : value).toLowerCase();
    var aliases = { men: 'men', women: 'women', unisex: 'unisex' };
    return aliases[s] || s;
  }
  function taxonomyMatches(p, group, value) {
    if (!value) return true;
    if (group === 'cats' && ['men', 'women', 'unisex'].indexOf(String(value)) > -1) return String(p.gender || '') === String(value);
    var keysField = { cats: 'categoryKeys', occ: 'occasionKeys', notes: 'noteKeys' }[group];
    var idsField = { cats: 'categoryIds', occ: 'occasionIds', notes: 'noteIds' }[group];
    var keys = (p[keysField] || p[group === 'occ' ? 'occs' : group] || []).map(String);
    var ids = (p[idsField] || []).map(String), wanted = String(value);
    return keys.indexOf(wanted) > -1 || ids.indexOf(wanted) > -1;
  }
  /* «قريبًا» is an ANNOUNCEMENT (catalog_coming_soon_announcements): a size a store says it will offer, with no price, no stock and no cart.
     It is not a sale offer, so it never needs platformEligibleOffer; it has no price, so a price bound is ignored (it never removes an announcement). */
  function soonList(f) {
    var src = typeof ANNOUNCEMENTS !== 'undefined' && Array.isArray(ANNOUNCEMENTS) ? ANNOUNCEMENTS : [];
    return src.filter(function (p) {
      if (f.store && String(p.announcedById) !== String(f.store)) return false;
      if (f.brand && !sameCatalogName(p.brand, f.brand)) return false;
      if (f.size_ml != null && f.size_ml !== '' && Number(p.sizeMl) !== Number(f.size_ml)) return false;
      if (f.cat && !taxonomyMatches(p, 'cats', f.cat)) return false;
      if (f.occ && !taxonomyMatches(p, 'occ', f.occ)) return false;
      if (f.note && !taxonomyMatches(p, 'notes', f.note)) return false;
      return true;
    }).sort(function (a, b) { return (b.rel || 0) - (a.rel || 0); }).map(function (p) { return { p: p, b: null }; });
  }
  function autoList(f) {
    f = f || {};
    if (f.flag === 'soon') return soonList(f);
    var l = [];
    try {
      l = PERFUMES.map(function (p) {
        var offer = Object.prototype.hasOwnProperty.call(p, 'platformEligibleOffer') ? p.platformEligibleOffer : null;
        var matches = offer && offer.avail && (!f.store || String(offer.storeId) === String(f.store)) && (!f.flag || (offer.flags || []).indexOf(f.flag) > -1);
        return { p: p, b: matches ? offer : null };
      }).filter(function (x) { return x.b; });
    } catch (e) { return []; }
    l = l.filter(function (x) {
      var p = x.p;
      if (f.brand && !sameCatalogName(p.brand, f.brand)) return false;
      if (f.size_ml != null && f.size_ml !== '' && Number(p.sizeMl) !== Number(f.size_ml)) return false;
      if (f.cat && !taxonomyMatches(p, 'cats', f.cat)) return false;
      if (f.occ && !taxonomyMatches(p, 'occ', f.occ)) return false;
      if (f.note && !taxonomyMatches(p, 'notes', f.note)) return false;
      if (f.min !== undefined && f.min !== '' && x.b.price < +f.min) return false;
      if (f.max !== undefined && f.max !== '' && x.b.price > +f.max) return false;
      return true;
    });
    if (f.sort === 'price_asc') l.sort(function (a, b) { return a.b.price - b.b.price; });
    else if (f.sort === 'price_desc') l.sort(function (a, b) { return b.b.price - a.b.price; });
    else l.sort(function (a, b) { return (b.p.rel || 0) - (a.p.rel || 0); });
    return l;
  }
  function manualList(ids, f) {
    f = f || {};
    return ids.map(perfumeBy).filter(Boolean).map(function (p) {
      var offer = platformEligibleOffer(p);
      return { p: p, b: offer && (!f.store || String(offer.storeId) === String(f.store)) ? offer : null };
    }).filter(function (x) { return x.b; });
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
    if (pend) { paint(root, pend.name, pend.mode === 'auto' ? autoList(pend.filters) : manualList(pend.items || [], pend.filters)); return; }
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
          .then(function (items) { var ids = items.map(function (i) { return i.product_size_id; }); smartCache[ref] = { t: Date.now(), def: def, list: function () { return manualList(ids, def.filters); } }; paint(root, def.name, manualList(ids, def.filters)); });
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
      if (b.image) { root.style.backgroundImage = 'url("' + b.image + '")'; warm(b.image); }
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
    var out = [], seen = {}, seenDefault = {};
    function add(id, el, kind, name, did) { if (!el || seen[id]) return; seen[id] = 1; out.push({ id: id, el: el, kind: kind, name: name, did: did }); }
    /* The scrolling bar at the very top of every page (its text is the site's own «bar» text). The header under it is not an editable element. */
    add('top:bar', document.getElementById('bar'), 'top-bar', 'الشريط العلوي');
    var hero = document.getElementById('hero');
    if (hero) {
      add('hero', hero, 'hero', 'الواجهة الرئيسية');
    }
    /* The title, its arrow and the counters sit just under the hero (#intro), but keep the ids they had inside it so saved edits still match. */
    add('hero:magic', document.querySelector('#intro .magic'), 'hero-text', 'نص الواجهة');
    add('hero:counters', document.querySelector('#intro .counters'), 'hero-counters', 'العدّادات');
    var V = document.getElementById('view');
    if (V && document.body.classList.contains('inner')) {
      /* `did` is the same element's id on a default page (all products, all brands, all stores): it does not depend on which page it is,
         so a design saved once for the default finds its title, its cards and its blocks on every page of the kind. */
      var pk = hash(pageKey() || 'page'), vn = 0, dn = 0;
      var vt = V.querySelector('h3'); if (vt) add('pg:' + pk + ':title', vt, 'title', 'عنوان الصفحة', 'pg:_:title');
      Array.prototype.slice.call(V.querySelectorAll('[data-elan-custom]')).forEach(function (b) { var bid = b.getAttribute('data-elan-id'); add(bid, blockNode(b), 'block', 'بلوك إضافي', bid); });
      Array.prototype.slice.call(V.querySelectorAll('.card')).forEach(function (card, i) {
        var tag = hash(card.getAttribute('data-go') || 'i' + i), base = 'pcard:' + pk + tag, id = base, dbase = 'pcard:_:' + tag, did = dbase;
        while (seen[id]) id = base + '-' + (++vn);
        while (seenDefault[did]) did = dbase + '-' + (++dn);
        seenDefault[did] = 1;
        var h4 = card.querySelector('h4');
        add(id, card, 'card', 'كارت ' + ((h4 && h4.textContent.trim().slice(0, 24)) || (i + 1)), did);
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
    topNodes(main).forEach(function (c) {
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
    if (e.kind === 'top-bar') return e.el.querySelector('#barT');
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
    endLive(el);
    if (el.__elanText) {
      var t = el.__elanText; t.node.textContent = t.children && t.children.length ? '' : t.value;
      (t.children || []).forEach(function (child) { t.node.appendChild(child); }); delete el.__elanText;
    }
    if (el.__elanInner) { var inn = el.__elanInner; if (inn.base === null) inn.node.removeAttribute('style'); else inn.node.setAttribute('style', inn.base); delete el.__elanInner; }
    if (el.__elanBar) { document.body.classList.remove('elan-no-bar'); delete el.__elanBar; }
    delete el.__elanOff; delete el.__elanApplied;
  }

  /* The bar's text runs as a marquee: the site draws its text four times in a row so the line never has a gap. A text chosen in the editor is drawn the same way. */
  function barText(t) { return (String(t) + '  •  ').repeat(4); }
  /* The page's own sheet sets the bar's height and size with !important on phones, so a size chosen here is drawn with !important too; the bar's words are
     a gold-gradient text of their own, so a colour chosen here has to reach them. */
  function paintBar(el, ed, st) {
    if (st.fontSize) el.style.setProperty('font-size', st.fontSize + 'px', 'important');
    if (ed.h) el.style.setProperty('height', ed.h + 'px', 'important');
    var inner = el.querySelector('#barT'), c = st.color || (st.effect === 'gold' ? '#ae852e' : '');
    if (inner && (c || el.style.textShadow)) {
      el.__elanInner = { node: inner, base: inner.getAttribute('style') };
      if (c) { inner.style.background = 'none'; inner.style.color = c; inner.style.setProperty('-webkit-text-fill-color', c); }
      if (el.style.textShadow) inner.style.textShadow = el.style.textShadow;
    }
  }

  /* A card moved inside a card strip stays inside it. A strip scrolls sideways only while it clips, so it is never opened up (overflow:visible, which is what
     used to be done: the moved card then showed in full but every visitor lost the sideways scroll). The offset that is drawn is the saved one limited to the
     strip's own box: along the strip within its scrollable length, across it within its height. The saved numbers are not changed; the editor starts the next
     move from what is drawn (__elanApplied). */
  function fitStripCards(list) {
    var cards = list.filter(function (c) { return c.__elanOff && c.closest('.strip'); });
    if (!cards.length) return;
    cards.forEach(function (c) { c.style.transform = ''; });                  // measure where the card sits without any offset
    var boxes = cards.map(function (c) { var s = c.closest('.strip'); return { c: c, s: s, r: c.getBoundingClientRect(), sr: s.getBoundingClientRect(), rtl: getComputedStyle(s).direction === 'rtl' }; });
    function limit(v, lo, hi) { return lo > hi ? 0 : Math.round(Math.max(lo, Math.min(hi, v))); }
    boxes.forEach(function (x) {
      var s = x.s, along = s.scrollLeft + (x.rtl ? s.scrollWidth - s.clientWidth : 0);   // scrolled distance counted from the left edge, in either direction
      var left = x.sr.left + s.clientLeft - along, right = left + s.scrollWidth, top = x.sr.top + s.clientTop, bottom = top + s.clientHeight;
      var dx = limit(x.c.__elanOff.dx, left - x.r.left, right - x.r.right), dy = limit(x.c.__elanOff.dy, top - x.r.top, bottom - x.r.bottom);
      x.c.__elanApplied = { dx: dx, dy: dy };
      x.c.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    });
  }

  /* ---------- rows: things side by side, and one fixed gap from row to row ----------
     Owner, 2026-11-12: two new sections placed side by side from the standard sizes, then the gap above that row differed from the gap below it, and the gap between the two
     sections was whatever the drag left. Moving by an offset can never keep gaps (the slot an element left stays in the flow, and every width has its own heights), so a thing
     placed beside another is laid out by the page itself instead: an edit {beside: <id>} puts it in the same row as that element, right after it (a flex row that keeps
     --elan-gap-x between the two), and every row of the page is then spaced from the one before it by --elan-gap-y between what can be SEEN (a section's own padding is air, a
     banner's edge is not), so the gap above a row equals the gap below it whatever sits next to it. Rows are rebuilt from the saved edits on every paint; nothing is saved but the {beside}. */
  var rowUndo = [], rowManaged = [];
  function unrows() { var u = rowUndo; rowUndo = []; rowManaged = []; for (var i = u.length - 1; i >= 0; i--) { try { u[i](); } catch (_) { /* keep going */ } } }
  function rowKeep(el) {
    if (el.__elanRowStyle !== undefined) return;
    var was = el.getAttribute('style'); el.__elanRowStyle = was;
    rowUndo.push(function () { delete el.__elanRowStyle; if (was === null) el.removeAttribute('style'); else el.setAttribute('style', was); });
  }
  /* The page's top-level things in the order they are read, a row's members in place of the row. */
  function topNodes(main) {
    var out = [];
    Array.prototype.forEach.call(main.children, function (c) {
      if (c.hasAttribute && c.hasAttribute('data-elan-row')) Array.prototype.forEach.call(c.children, function (m) { out.push(m); });
      else out.push(c);
    });
    return out;
  }
  function shown(n) { return !!n && n.nodeType === 1 && getComputedStyle(n).display !== 'none'; }
  function px(v) { return parseFloat(v) || 0; }
  function gapY() { var v = px(getComputedStyle(document.documentElement).getPropertyValue('--elan-gap-y')); return v > 0 ? v : 80; }
  /* A box that can be seen on its own (a background, a border, a shadow, a banner): its edge is what the eye meets, so no padding of its own counts as empty room. */
  function painted(n, cs, top) {
    if (n.classList && n.classList.contains('elan-banner')) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    var bg = cs.backgroundColor;
    if (bg && bg !== 'transparent' && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(bg) && !/^rgb\(\s*255,\s*255,\s*255\s*\)$/.test(bg)) return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    var side = top ? 'Top' : 'Bottom';
    return px(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none';
  }
  function edgeChild(n, top) {
    var list = n.children, i = top ? 0 : list.length - 1, step = top ? 1 : -1;
    for (; i >= 0 && i < list.length; i += step) {
      var c = list[i], cs = getComputedStyle(c);
      if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/i.test(c.tagName) || cs.display === 'none' || cs.position === 'absolute' || cs.position === 'fixed') continue;
      return c;
    }
    return null;
  }
  /* The empty room at the top (or the bottom) of an element before anything can be seen: its padding and the edge margins and paddings of what it starts (or ends) with, down to the
     first box that shows itself. A section of cards is 46px of padding above its title and 14px + the strip's 22px under its cards; a picture or a banner has none. */
  function airOf(node, top) {
    var sum = 0, n = node, depth = 0;
    while (n && depth < 5) {
      var cs = getComputedStyle(n);
      if (depth > 0) sum += px(top ? cs.marginTop : cs.marginBottom);
      if (painted(n, cs, top)) break;
      sum += px(top ? cs.paddingTop : cs.paddingBottom);
      n = edgeChild(n, top); depth++;
    }
    return sum;
  }
  /* The gap between one row and the next, set from what the two rows leave empty. A row is a section, a block or a flex row of them; only a row made of the editor's own things
     (an extra block, a row, a section the owner resized) is spaced, so a page nobody touched keeps its natural gaps exactly. */
  function spaceRows() {
    var main = document.getElementById('main');
    if (!main || document.body.classList.contains('inner')) return;
    var G = gapY(), units = [];
    Array.prototype.forEach.call(main.children, function (c) {
      if (!shown(c) || (c.classList && c.classList.contains('elan-float'))) return;
      var row = c.hasAttribute('data-elan-row');
      units.push({ el: c, row: row, managed: row || c.hasAttribute('data-elan-custom') || rowManaged.indexOf(c) !== -1 });
    });
    units.forEach(function (u) {
      if (!u.row) { u.airT = airOf(u.el, true); u.airB = airOf(u.el, false); return; }
      var ms = Array.prototype.filter.call(u.el.children, shown), tops = ms.map(function (m) { return airOf(m, true); }), most = Math.max.apply(null, tops.concat(0)), seen = -Infinity;
      ms.forEach(function (m, i) { rowKeep(m); m.style.setProperty('margin-top', (most - tops[i]) + 'px', 'important'); });   // the members' visible tops line up
      var r = u.el.getBoundingClientRect();
      ms.forEach(function (m) { seen = Math.max(seen, m.getBoundingClientRect().bottom - airOf(m, false)); });
      u.airT = most; u.airB = seen === -Infinity ? 0 : Math.max(0, r.bottom - seen);
    });
    units.forEach(function (u, i) {
      var prev = units[i - 1];
      if (u.managed) { rowKeep(u.el); u.el.style.setProperty('margin-bottom', '0px', 'important'); }
      if (!(u.managed || (prev && prev.managed))) return;
      var want = prev ? G - prev.airB - u.airT : Math.max(0, G - u.airT);
      rowKeep(u.el); u.el.style.setProperty('margin-top', Math.round(want * 100) / 100 + 'px', 'important');
    });
  }
  /* Put every element that names another one in {beside} into one row with it. `managed` lists the built-in sections the owner resized (they are spaced like the rest). */
  function buildRows(beside, managed) {
    var main = document.getElementById('main');
    if (!main || document.body.classList.contains('inner')) return;
    if (!main.__elanSpaced) { main.__elanSpaced = true; main.addEventListener('load', respace, true); }   // a picture that arrives late changes a row's height
    if (!Object.keys(beside).length && !Object.keys(managed).length) { spaceRows(); return; }
    var tops = elements().filter(function (e) { return (e.kind === 'section' || e.kind === 'block') && e.el.parentNode === main && shown(e.el); }), byId = {}, groups = {};
    tops.forEach(function (e, i) { e.pos = i; byId[e.id] = e; });
    rowManaged = tops.filter(function (e) { return managed[e.id]; }).map(function (e) { return e.el; });
    tops.forEach(function (e) {
      var anchor = beside[e.id];
      if (!anchor || anchor === e.id || !byId[anchor]) return;
      var root = anchor, hops = 0;
      while (beside[root] && byId[beside[root]] && hops < 12) { root = beside[root]; hops++; }
      if (hops >= 12 || root === e.id) return;                      // a loop (A beside B, B beside A): nobody in it is placed
      (groups[root] = groups[root] || [byId[root]]).push(e);
    });
    Object.keys(groups).forEach(function (rootId) {
      var list = groups[rootId].sort(function (a, b) { return a.pos - b.pos; }).slice(0, 4);
      if (list.length < 2) return;
      var row = document.createElement('div');
      row.className = 'elan-row'; row.setAttribute('data-elan-row', '1');
      main.insertBefore(row, list[0].el);
      var moved = list.map(function (e) {
        var ph = document.createComment('elan-row');
        main.replaceChild(ph, e.el); row.appendChild(e.el);
        return { el: e.el, ph: ph };
      });
      rowUndo.push(function () { moved.forEach(function (m) { if (m.ph.parentNode) m.ph.parentNode.replaceChild(m.el, m.ph); }); if (row.parentNode) row.parentNode.removeChild(row); });
      list.forEach(function (e) {
        rowKeep(e.el);
        e.el.style.transform = '';
        if (e.el.style.getPropertyValue('width')) e.el.style.setProperty('flex', '0 1 auto', 'important');   // a standard size: the row may shrink it a little so the two fit with the fixed gap
      });
    });
    spaceRows();
  }
  var spaceTimer = null;
  function respace() { clearTimeout(spaceTimer); spaceTimer = setTimeout(function () { try { if (design) spaceRows(); } catch (_) { /* keep the page usable */ } }, 120); }

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
        /* style.css pins the video's display with !important, and a plain inline value loses to that (the old video kept playing over
           the picture). Only an inline !important wins; undo clears it again with `video.style.display = prev.display`.
           The picture itself is drawn by hero-early.js (ElanHeroFit above: class hero-img and --hero-img, the whole picture over a blurred
           copy of itself). Writing it here too, as a cropped background of the hero itself, made a third copy of the same picture that
           only showed at the hero's edges and only after this script had run: one more thing changing while the page opened. A page
           without hero-early.js (none today) still gets the plain background, so the picture is never lost. */
        video.style.setProperty('display', 'none', 'important');
        if (typeof window.ElanHeroFit !== 'function') {
          el.style.setProperty('background-image', 'url("' + m.src + '")', 'important');
          el.style.setProperty('background-size', 'cover', 'important');
          el.style.setProperty('background-position', 'center', 'important');
        }
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
    warm(m.src);
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


  /* ---------- the size of an element, and everything around it ----------
     A width and a height chosen for an element (from the menu or by dragging its corner) are the element's size, whatever the page's own sheet says (an inline !important
     wins over one in a sheet): the hero's height, a card's minimum height and the 900px limit of a block no longer hold it. The page lays everything out again by itself, so the
     elements around it move aside to make room (a strip, a column of sections, a wrapping row): in a grid, an element wider than one cell takes as many cells as it needs
     (span), so the rest of the grid flows around it instead of the element lying over its neighbour. */
  function gridSpan(el, w) {
    var box = el.parentElement, cs;
    if (!box || !(w > 0)) return;
    try { cs = getComputedStyle(box); } catch (_) { return; }
    if (!/grid/.test(cs.display || '')) return;
    var tracks = String(cs.gridTemplateColumns || '').split(/\s+/).map(parseFloat).filter(function (n) { return n > 0; });
    if (!tracks.length) return;
    var gap = parseFloat(cs.columnGap) || 0, span = 1, room = tracks[0];
    while (span < tracks.length && w > room + 1) { room += gap + tracks[span]; span++; }
    el.style.setProperty('grid-column', 'span ' + span);
  }
  function sizeBox(el, w, h) {
    if (w) { el.style.setProperty('width', w + 'px', 'important'); el.style.setProperty('max-width', 'none', 'important'); el.style.setProperty('flex', '0 0 auto', 'important'); }
    if (h) { el.style.setProperty('height', h + 'px', 'important'); el.style.setProperty('min-height', '0', 'important'); el.style.setProperty('max-height', 'none', 'important'); }
    if (w) gridSpan(el, w);
  }

  /* ---------- a picture or a video in a resized element ----------
     Owner, 2026-11-11: when an element changes size, its picture or video must not be cut, must fill the whole element and must not be stretched. Those three only fit together
     when the frame has the picture's own shape; for any other frame the picture is shown WHOLE (object-fit: contain: nothing cut, nothing stretched) and the room its shape leaves
     over is filled with the same picture, blurred (the way the hero already draws its picture). «نفس شكل الصورة» in the dimensions window makes the frame the picture's own shape,
     so nothing is left over at all. */
  var sizeCache = {};
  function loadSize(url, then) {
    try {
      var im = new Image();
      im.onload = function () { if (im.naturalWidth > 0) { sizeCache[url] = { w: im.naturalWidth, h: im.naturalHeight }; if (then) then(sizeCache[url]); } };
      im.src = url;
    } catch (_) { /* optional */ }
  }
  function warm(url) { if (url && sizeCache[url] === undefined) { sizeCache[url] = null; loadSize(url); } }
  function bgUrl(el) {
    var m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/.exec(el.style.backgroundImage || '');
    return m ? (m[1] || m[2] || m[3] || '') : '';
  }
  function visibleMedia(n) { return !!n && n.style.display !== 'none' && !/(^|\s)elan-fit-(back|front)(\s|$)/.test(n.className || ''); }
  /* The picture or video an element shows as its own: { kind: 'img' | 'video' | 'bg', node | url, self }, or null. A section or a block of cards owns none (its cards do). */
  function findMedia(entry) {
    var el = entry.el, kind = entry.kind, i, list, n;
    if (kind === 'hero') {
      n = el.querySelector('#heroVideo, video');
      return n && n.getAttribute('src') && visibleMedia(n) ? { kind: 'video', node: n } : null;   // the hero's picture is drawn whole over its own blurred copy by the stylesheet
    }
    if (['card', 'block', 'image-el', 'section'].indexOf(kind) === -1) return null;
    if (el.classList && el.classList.contains('elan-smart')) return null;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') return { kind: el.tagName === 'IMG' ? 'img' : 'video', node: el, self: true };
    if (kind !== 'section') {
      n = kind === 'card' ? el.querySelector('.artbg video, .artbg img') : null;
      if (visibleMedia(n)) return { kind: n.tagName === 'VIDEO' ? 'video' : 'img', node: n };
      list = el.querySelectorAll('video, img');
      for (i = 0; i < list.length; i++) if (visibleMedia(list[i])) return { kind: list[i].tagName === 'VIDEO' ? 'video' : 'img', node: list[i] };
    }
    var url = bgUrl(el);
    if (!url) { var shown = el.querySelector(':scope > .elan-fit-front'); url = shown ? bgUrl(shown) : ''; }   // already fitted: the picture is in the layer that replaced the background
    return url ? { kind: 'bg', url: url } : null;
  }
  /* The picture's own pixels ({ w, h, video }), or null when there is none or it has not arrived yet. */
  function mediaSize(entry) {
    var f = entry && findMedia(entry), n = f && f.node;
    if (!f) { var hs = entry && entry.kind === 'hero' && typeof window.ElanHeroFit === 'function' && window.ElanHeroFit.size; return hs ? window.ElanHeroFit.size() : null; }
    if (f.kind === 'img') return n.naturalWidth > 0 ? { w: n.naturalWidth, h: n.naturalHeight } : null;
    if (f.kind === 'video') return n.videoWidth > 0 ? { w: n.videoWidth, h: n.videoHeight, video: true } : null;
    var known = sizeCache[f.url]; if (!known) warm(f.url);
    return known || null;
  }
  function whenSized(f, then) {
    var n = f.node, done = function () { var s = f.kind === 'img' ? { w: n.naturalWidth, h: n.naturalHeight } : { w: n.videoWidth, h: n.videoHeight }; if (s.w > 0 && s.h > 0) then(s); };
    if (f.kind === 'bg') { if (sizeCache[f.url]) then(sizeCache[f.url]); else loadSize(f.url, then); return; }
    if (f.kind === 'img') { if (n.complete && n.naturalWidth > 0) done(); else n.addEventListener('load', done, { once: true }); return; }
    if (n.readyState >= 1 && n.videoWidth > 0) done(); else n.addEventListener('loadedmetadata', done, { once: true });
  }
  function keepStyle(n, undo) { var was = n.getAttribute('style'); undo.push(function () { if (was === null) n.removeAttribute('style'); else n.setAttribute('style', was); }); }
  function fitMedia(entry) {
    var f = findMedia(entry), el = entry.el;
    if (!f || el.__elanFitUndo) return;
    var undo = el.__elanFitUndo = [], token = {}, imp = function (n, k, v) { n.style.setProperty(k, v, 'important'); };
    el.__elanFit = token;
    el.setAttribute('data-elan-fit', '1');
    undo.push(function () { el.removeAttribute('data-elan-fit'); if (el.__elanFit === token) delete el.__elanFit; });
    if (f.self) { imp(el, 'object-fit', 'contain'); return; }   // a lone picture (a logo) has no room for a backdrop: shown whole, the page shows through
    try { if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; } catch (_) { /* optional */ }
    if (el.classList.contains('elan-image')) imp(el, 'padding', '0');
    var host = el;
    if (f.kind === 'bg') {
      imp(el, 'background-image', 'none');
      var front = document.createElement('div'); front.className = 'elan-fit-front'; front.style.backgroundImage = 'url("' + f.url + '")';
      host = el; el.insertBefore(front, el.firstChild);
      undo.push(function () { front.remove(); });
    } else {
      var n = f.node;
      keepStyle(n, undo);
      imp(n, 'width', '100%'); imp(n, 'height', '100%'); imp(n, 'max-width', 'none'); imp(n, 'object-fit', 'contain'); imp(n, 'margin', '0');
      for (var up = n.parentNode; up && up !== el; up = up.parentNode) { keepStyle(up, undo); imp(up, 'width', '100%'); imp(up, 'height', '100%'); }
      host = n.parentNode;
    }
    var before = f.kind === 'bg' ? el.firstChild : f.node;
    whenSized(f, function (nat) {
      if (el.__elanFit !== token || el.isConnected === false) return;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && Math.abs((r.width / r.height) / (nat.w / nat.h) - 1) < 0.02) return;   // the frame has the picture's own shape: nothing is left over
      var back;
      if (f.kind === 'video') { back = document.createElement('video'); back.setAttribute('src', f.node.getAttribute('src') || f.node.currentSrc); back.muted = true; back.loop = true; back.autoplay = true; back.setAttribute('muted', ''); back.setAttribute('loop', ''); back.setAttribute('autoplay', ''); back.setAttribute('playsinline', ''); back.setAttribute('aria-hidden', 'true'); }
      else { back = document.createElement('div'); back.style.backgroundImage = 'url("' + (f.kind === 'bg' ? f.url : (f.node.currentSrc || f.node.getAttribute('src'))) + '")'; }
      back.className = 'elan-fit-back';
      host.insertBefore(back, f.kind === 'bg' ? host.firstChild : before);
      undo.push(function () { back.remove(); });
      if (f.kind === 'video') playQuietly(back);
    });
  }
  /* The same while the corner is being dragged: the size is written straight onto the element, and the picture follows it. */
  function liveSize(entry, w, h) { sizeBox(entry.el, w, h); fitMedia(entry); }
  function endLive(el) { var u = el && el.__elanFitUndo; if (!u) return; delete el.__elanFitUndo; u.forEach(function (f) { try { f(); } catch (_) { /* keep going */ } }); }

  function paint(entry, ed) {
    var el = entry.el, st = ed.style || {};
    el.__elanBase = el.getAttribute('style') || '';
    el.setAttribute('data-elan-edited', '1');
    if (ed.hidden || ed.archived) {
      if (entry.kind === 'hero') return;   // the hero is the page's white base: deleting it only removes what sat on top of it
      el.style.setProperty('display', 'none', 'important');
      if (entry.kind === 'top-bar') { document.body.classList.add('elan-no-bar'); el.__elanBar = true; }
      return;
    }
    if ((ed.dx || ed.dy) && !ed.beside) {
      el.style.transform = 'translate(' + (ed.dx || 0) + 'px,' + (ed.dy || 0) + 'px)';
      if (!el.style.position && getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.style.zIndex = '3';
      if (entry.kind === 'card' && el.closest('.strip')) el.__elanOff = { dx: ed.dx || 0, dy: ed.dy || 0 };   // limited to the strip once every size is painted (fitStripCards)
    }
    if (ed.w || ed.h) sizeBox(el, ed.w, ed.h);
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
    if (entry.kind === 'top-bar') paintBar(el, ed, st);
    if (ed.media && ed.media.src) paintMedia(entry, ed.media);
    if (ed.noMedia && entry.kind === 'card' && !st.media && !(ed.media && ed.media.src)) {
      /* the card's own picture was deleted in the editor: the card is its white base until a picture or a video is added */
      el.__elanMedia = el.__elanMedia || [];
      hideArt(el, el.__elanMedia); el.setAttribute('data-no-media', '1');
      el.__elanMedia.push(function () { el.removeAttribute('data-no-media'); });
    }
    if (ed.text) {
      var node = textTarget(entry), t = ed.text[lang()] || ed.text.ar || ed.text.en;
      if (node && t) { el.__elanText = { node: node, value: node.textContent, children: Array.prototype.slice.call(node.childNodes) }; node.textContent = entry.kind === 'top-bar' ? barText(t) : t; }
    }
    if (ed.w || ed.h) fitMedia(entry);
  }

  function mergeEdit(base, over) {
    if (!over) return base;
    return Object.assign({}, base || {}, over, { style: Object.assign({}, base && base.style, over.style) });
  }

  /* Free-form edits for the current screen size. Idempotent: always undo the last paint first. */
  function applyEdits() {
    unrows();
    touched.forEach(unpaint);
    touched = [];
    if (!design) return;
    var beside = {}, managed = {};
    if (design.edits || design.pages) {
      var dev = ED.deviceOf(window.innerWidth);
      var key = pageKey(), pg = design.pages && design.pages[key], view = document.getElementById('view');
      var dpg = design.pages && design.pages[ED.defaultKeyOf(key)];
      elements().forEach(function (entry) {
        var ed = ED.editFor(design, dev, entry.id), inView = !!(view && view.contains(entry.el));
        /* the page's own edits win over the default page's, which win over the site-wide ones */
        if (dpg && inView && entry.did) ed = mergeEdit(ed, ED.editFor(dpg, dev, entry.did));
        if (pg && inView) ed = mergeEdit(ed, ED.editFor(pg, dev, entry.id));
        if (!ed) return;
        if (!inView && !ed.hidden && !ed.archived) { if (ed.beside) beside[entry.id] = ed.beside; if (ed.beside || ed.w || ed.h) managed[entry.id] = true; }
        paint(entry, ed);
        touched.push(entry.el);
      });
      fitStripCards(touched);
    }
    try { buildRows(beside, managed); } catch (e) { /* rows are optional: the page stays as the edits left it */ }
  }

  function apply() {
    var main = document.getElementById('main');
    if (!main || !design) return;
    unrows();
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
    var key = pageKey(), pg = design.pages && key && design.pages[key], dpg = design.pages && key && design.pages[ED.defaultKeyOf(key)];
    if (!pg && !dpg) return;
    var all = ((dpg && dpg.blocks) || []).concat((pg && pg.blocks) || []);
    var top = all.filter(function (b) { return b.slot !== 'bottom'; });
    var bottom = all.filter(function (b) { return b.slot === 'bottom'; });
    var h = V.querySelector('h3') || V.querySelector('.bc'), ref = h || null;
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
  function sortCards(root, ids, byDefaultId) {
    var cards = elements().filter(function (e) { return e.kind === 'card' && root.contains(e.el); });
    var idOf = function (e) { return byDefaultId ? e.did : e.id; };
    var groups = [];
    cards.forEach(function (e) {
      var parent = e.el.parentNode, g = groups.filter(function (x) { return x.parent === parent; })[0];
      if (!g) groups.push(g = { parent: parent, cards: [] });
      g.cards.push(e.el);
    });
    groups.forEach(function (g) {
      var rank = function (el) { var e = cards.filter(function (c) { return c.el === el; })[0], i = e ? ids.indexOf(idOf(e)) : -1; return i === -1 ? 1e6 : i; };
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
      var pgKey = pageKey(), pg = design.pages && design.pages[pgKey], dpg = design.pages && design.pages[ED.defaultKeyOf(pgKey)];
      /* the page's own order replaces the default one; without it the default order (in default ids) applies */
      if (pg && pg.cardOrder && pg.cardOrder.view) sortCards(view, pg.cardOrder.view);
      else if (dpg && dpg.cardOrder && dpg.cardOrder.view) sortCards(view, dpg.cardOrder.view, true);
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

  window.ElanDesignLayer = { topNodes: topNodes, airOf: airOf, gapY: gapY, apply: apply, set: set, pageKey: pageKey, defaultKey: function () { var k = pageKey(); return k ? ED.defaultKeyOf(k) : null; }, current: function () { return design; }, applyEdits: applyEdits, elements: elements, textTarget: textTarget, goTargetOf: goTargetOf, mediaSize: mediaSize, liveSize: liveSize, endLive: function (entry) { endLive(entry && entry.el); } };

  // A different screen size means a different set of free-form edits.
  window.addEventListener('resize', function () {
    respace();
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
