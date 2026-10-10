/* Élan editor — draft model. Pure logic: every edit happens on a local copy of the design,
   with undo/redo, and nothing touches the network until the owner saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./design-schema.js'));
  else root.ElanEditModel = factory(root.ElanDesign);
})(typeof self !== 'undefined' ? self : this, function (ED) {
  'use strict';
  var SIZES = ['sm', 'md', 'lg', 'xl'];
  var ALIGNS = ['start', 'center', 'end'];
  var LIMIT = 100;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function newId() {
    var s = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) { var a = new Uint8Array(5); crypto.getRandomValues(a); a.forEach(function (b) { s += b.toString(16).padStart(2, '0'); }); }
    else s = Math.random().toString(16).slice(2, 12);
    return 'x-' + s;
  }

  function create(initial) {
    var base = ED.normalize(initial || {}, { strict: false }).design;
    var cur = clone(base);
    cur.order = seqOf(cur);
    var past = [], future = [], archived = [], page = 'home', pending = {};

    function seqOf(d) {
      var all = ED.BUILTIN.concat((d.blocks || []).map(function (b) { return b.id; })), out = [];
      (d.order || []).forEach(function (id) { if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id); });
      all.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
      return out;
    }
    function isBuiltin(id) { return ED.BUILTIN.indexOf(id) !== -1; }
    function block(id) {
      var b = (cur.blocks || []).filter(function (x) { return x.id === id; })[0];
      if (b) return b;
      var pg = cur.pages || {}, keys = Object.keys(pg);
      for (var i = 0; i < keys.length; i++) { var f = pg[keys[i]].blocks.filter(function (x) { return x.id === id; })[0]; if (f) return f; }
      return null;
    }
    function pageOf(id) {
      var pg = cur.pages || {}, keys = Object.keys(pg);
      for (var i = 0; i < keys.length; i++) if (pg[keys[i]].blocks.some(function (x) { return x.id === id; })) return keys[i];
      return null;
    }
    function displayOrder(key) {           // what the visitor sees: top blocks first, then bottom ones
      var l = (cur.pages && cur.pages[key] && cur.pages[key].blocks) || [];
      return l.filter(function (b) { return b.slot !== 'bottom'; }).concat(l.filter(function (b) { return b.slot === 'bottom'; })).map(function (b) { return b.id; });
    }
    function pageList(key) { cur.pages = cur.pages || {}; cur.pages[key] = cur.pages[key] || { blocks: [] }; return cur.pages[key].blocks; }
    function reorderPage(key, ids) {
      var l = pageList(key), by = {}; l.forEach(function (b) { by[b.id] = b; });
      cur.pages[key].blocks = ids.map(function (id) { return by[id]; });
    }
    function addBlock(b, afterId) {
      if (page === 'home') { cur.blocks = (cur.blocks || []).concat([b]); place(b.id, afterId); return; }
      pageList(page).push(b);
      var ids = displayOrder(page).filter(function (x) { return x !== b.id; }), at = afterId ? ids.indexOf(afterId) : -1;
      ids.splice(at < 0 ? ids.length : at + 1, 0, b.id); reorderPage(page, ids);
    }
    function commit(mutator) {
      var before = clone(cur);
      mutator();
      cur.order = seqOf(cur);
      if (cur.pages) { Object.keys(cur.pages).forEach(function (k) { if (!cur.pages[k].blocks.length) delete cur.pages[k]; }); if (!Object.keys(cur.pages).length) delete cur.pages; }
      if (same(before, cur)) return false;
      past.push(before); if (past.length > LIMIT) past.shift();
      future = [];
      return true;
    }
    function place(id, afterId) {
      var s = seqOf(cur).filter(function (x) { return x !== id; }), at = afterId ? s.indexOf(afterId) : -1;
      s.splice(at < 0 ? s.length : at + 1, 0, id); cur.order = s;
    }
    function section(id) { cur.sections = cur.sections || {}; cur.sections[id] = cur.sections[id] || {}; return cur.sections[id]; }
    function tidy(id) {
      var s = cur.sections && cur.sections[id]; if (!s) return;
      if (s.title) { if (!s.title.ar) delete s.title.ar; if (!s.title.en) delete s.title.en; if (!s.title.ar && !s.title.en) delete s.title; }
      if (!s.hidden && !s.title) delete cur.sections[id];
    }

    return {
      design: function () { return clone(cur); },
      sequence: function () { return page === 'home' ? seqOf(cur).slice() : displayOrder(page); },
      setPage: function (key) { page = key || 'home'; },
      page: function () { return page; },
      pageOf: function (id) { return pageOf(id); },
      kind: function (id) { return isBuiltin(id) ? 'section' : (block(id) ? block(id).type : null); },
      info: function (id) { var k = this.kind(id); return k ? { id: id, type: k, name: id } : null; },
      dirty: function () { return !same(Object.assign({}, cur, { order: seqOf(cur) }), Object.assign({}, base, { order: seqOf(base) })); },
      archivedItems: function () { return clone(archived); },
      canUndo: function () { return past.length > 0; },
      canRedo: function () { return future.length > 0; },

      move: function (id, step) {           // one step up (-1) or down (+1)
        return commit(function () {
          var pk = pageOf(id);
          if (pk) { var ids = displayOrder(pk), i0 = ids.indexOf(id), j0 = Math.max(0, Math.min(ids.length - 1, i0 + (step < 0 ? -1 : 1))); ids.splice(i0, 1); ids.splice(j0, 0, id); reorderPage(pk, ids); return; }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('عنصر غير موجود');
          var j = Math.max(0, Math.min(s.length - 1, i + (step < 0 ? -1 : 1))); s.splice(i, 1); s.splice(j, 0, id); cur.order = s;
        });
      },
      moveTo: function (id, index) {
        return commit(function () {
          var pk = pageOf(id);
          if (pk) { var ids = displayOrder(pk).filter(function (x) { return x !== id; }); ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id); reorderPage(pk, ids); return; }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('عنصر غير موجود');
          s.splice(i, 1); s.splice(Math.max(0, Math.min(s.length, index)), 0, id); cur.order = s;
        });
      },
      setText: function (id, lang, text) {
        lang = lang === 'en' ? 'en' : 'ar'; text = String(text == null ? '' : text);
        return commit(function () {
          if (isBuiltin(id)) { var e = section(id); e.title = Object.assign({}, e.title); if (text.trim()) e.title[lang] = text; else delete e.title[lang]; tidy(id); return; }
          var b = block(id); if (!b) throw Error('عنصر غير موجود');
          if (b.type === 'text') { b.text = Object.assign({}, b.text); if (text.trim()) b.text[lang] = text; else delete b.text[lang]; }
          else if (b.type === 'banner') { b.title = Object.assign({}, b.title); if (text.trim()) b.title[lang] = text; else delete b.title[lang]; }
          else throw Error('العنصر ده مالوش نص قابل للتعديل');
        });
      },
      format: function (id, f) {
        f = f || {};
        return commit(function () {
          var b = block(id); if (!b) throw Error('التنسيق متاح لبلوكات النص والبانر والصور بس');
          b.style = Object.assign({}, b.style);
          if (f.size) { if (SIZES.indexOf(f.size) === -1) throw Error('حجم غير مسموح'); b.style.size = f.size; }
          var HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
          ['color', 'background'].forEach(function (k) { if (f[k] === '') delete b.style[k]; else if (f[k] !== undefined) { if (!HEX.test(f[k])) throw Error('لون غير صالح'); b.style[k] = f[k]; } });
          if (f.align) { if (ALIGNS.indexOf(f.align) === -1) throw Error('محاذاة غير مسموحة'); b.style.align = f.align; }
        });
      },
      resize: function (id, step) {          // step: 'bigger' | 'smaller' or an explicit size name
        var b = block(id); if (!b) throw Error('تغيير الحجم متاح لبلوكات النص بس');
        var cur_ = (b.style && b.style.size) || 'md', i = SIZES.indexOf(cur_);
        var next = SIZES.indexOf(step) !== -1 ? step : SIZES[Math.max(0, Math.min(SIZES.length - 1, i + (step === 'smaller' ? -1 : 1)))];
        return this.format(id, { size: next });
      },
      createText: function (afterId, text) {
        var id = newId();
        commit(function () { addBlock({ id: id, type: 'text', style: { align: 'center', size: 'md' }, text: { ar: text || 'نص جديد' } }, afterId); });
        return id;
      },

      createBanner: function (afterId, f) {
        f = f || {}; var id = newId();
        commit(function () {
          var b = { id: id, type: 'banner', style: { align: 'center', size: 'lg' }, title: { ar: f.title || 'بانر جديد' } };
          if (f.image) b.image = f.image;
          addBlock(b, afterId);
        });
        return id;
      },
      createImage: function (afterId, src) {
        var id = newId();
        commit(function () {
          addBlock({ id: id, type: 'image', style: { align: 'center', size: 'md' }, src: src, alt: {} }, afterId);
        });
        return id;
      },
      setMedia: function (id, url) {
        return commit(function () {
          var b = block(id); if (!b) throw Error('اختاري بانر أو صورة الأول');
          if (b.type === 'banner') b.image = url; else if (b.type === 'image') b.src = url; else throw Error('الصور بتتحط على بانر أو صورة بس');
        });
      },
      setSubtitle: function (id, lang, text) {
        lang = lang === 'en' ? 'en' : 'ar'; text = String(text == null ? '' : text);
        return commit(function () {
          var b = block(id); if (!b || b.type !== 'banner') throw Error('العنوان الفرعي للبانر بس');
          b.subtitle = Object.assign({}, b.subtitle); if (text.trim()) b.subtitle[lang] = text; else delete b.subtitle[lang];
        });
      },
      setHref: function (id, href) {
        return commit(function () {
          var b = block(id); if (!b || b.type === 'text') throw Error('الرابط للبانر والصورة بس');
          href = String(href || '').trim();
          if (href && !/^(?:\/(?!\/)|#|https:\/\/)[^\s"'<>\\]*$/.test(href)) throw Error('الرابط لازم يبدأ بـ / أو # أو https://');
          if (href) b.href = href; else delete b.href;
        });
      },
      setSlot: function (id, slot) {
        return commit(function () { var b = block(id); if (!b || !pageOf(id)) throw Error('المكان (أعلى/أسفل) لبلوكات الصفحات الداخلية بس'); b.slot = slot === 'bottom' ? 'bottom' : 'top'; });
      },
      createSmart: function (afterId, ref) {
        if (!ED.isRef(ref)) throw Error('مرجع السيكشن غير صالح');
        var id = newId();
        commit(function () { addBlock({ id: id, type: 'smart', style: { align: 'center', size: 'md' }, ref: ref }, afterId); });
        return id;
      },
      defineSection: function (def) { pending[def.element_id] = clone(def); },
      pendingSections: function () {          // only definitions the saved design actually uses
        var used = {}, d = cur;
        (d.blocks || []).forEach(function (b) { if (b.type === 'smart') used[b.ref] = 1; });
        Object.keys(d.pages || {}).forEach(function (k) { d.pages[k].blocks.forEach(function (b) { if (b.type === 'smart') used[b.ref] = 1; }); });
        return Object.keys(pending).filter(function (r) { return used[r]; }).map(function (r) { return clone(pending[r]); });
      },
      clearPending: function () { pending = {}; },
      mediaOf: function (id) { var b = block(id); return b ? (b.image || b.src || '') : ''; },
      archive: function (id) {
        return commit(function () {
          if (isBuiltin(id)) { section(id).hidden = true; archived.push({ id: id, kind: 'section' }); return; }
          var b = block(id); if (!b) throw Error('عنصر غير موجود');
          var pk = pageOf(id);
          if (pk) { archived.push({ id: id, kind: 'block', block: clone(b), page: pk, index: displayOrder(pk).indexOf(id) }); cur.pages[pk].blocks = cur.pages[pk].blocks.filter(function (x) { return x.id !== id; }); return; }
          archived.push({ id: id, kind: 'block', block: clone(b), index: seqOf(cur).indexOf(id) });
          cur.blocks = cur.blocks.filter(function (x) { return x.id !== id; });
        });
      },
      restore: function (id) {
        return commit(function () {
          if (isBuiltin(id)) { var e = section(id); delete e.hidden; tidy(id); archived = archived.filter(function (a) { return a.id !== id; }); return; }
          var a = archived.filter(function (x) { return x.id === id && x.kind === 'block'; })[0];
          if (!a) throw Error('مفيش حاجة بالاسم ده في الأرشيف');
          if (a.page) { var l = pageList(a.page); l.push(a.block); var ids = displayOrder(a.page).filter(function (x) { return x !== id; }); ids.splice(Math.min(a.index, ids.length), 0, id); reorderPage(a.page, ids); archived = archived.filter(function (x) { return x !== a; }); return; }
          cur.blocks = (cur.blocks || []).concat([a.block]);
          var s = seqOf(cur).filter(function (x) { return x !== id; }); s.splice(Math.min(a.index, s.length), 0, id); cur.order = s;
          archived = archived.filter(function (x) { return x !== a; });
        });
      },
      undo: function () { if (!past.length) return false; future.push(clone(cur)); cur = past.pop(); return true; },
      redo: function () { if (!future.length) return false; past.push(clone(cur)); cur = future.pop(); return true; },
      markSaved: function (design) { base = ED.normalize(design || cur, { strict: false }).design; base.order = seqOf(base); }
    };
  }
  return { create: create, SIZES: SIZES, ALIGNS: ALIGNS };
});
