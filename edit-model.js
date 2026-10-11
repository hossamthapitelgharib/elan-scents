/* Élan editor — draft model. Pure logic: every edit happens on a local copy of the design,
   with undo/redo, and nothing touches the network until the owner saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var reg = null;
    try { reg = require('./editor/element-registry.js'); } catch (e1) { try { reg = require('./element-registry.js'); } catch (e2) {} }
    module.exports = factory(require('./design-schema.js'), reg);
  } else root.ElanEditModel = factory(root.ElanDesign, root.ElanElements);
})(typeof self !== 'undefined' ? self : this, function (ED, REG) {
  'use strict';
  var SIZES = ['sm', 'md', 'lg', 'xl'];
  var ALIGNS = ['start', 'center', 'end'];
  var LIMIT = 100;
  REG = REG || null;

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
    function displayOrder(key) {
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

      move: function (id, step) {
        return commit(function () {
          var pk = pageOf(id);
          if (pk) { var ids = displayOrder(pk), i0 = ids.indexOf(id), j0 = Math.max(0, Math.min(ids.length - 1, i0 + (step < 0 ? -1 : 1))); ids.splice(i0, 1); ids.splice(j0, 0, id); reorderPage(pk, ids); return; }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('\u0639\u0646\u0635\u0631 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f');
          var j = Math.max(0, Math.min(s.length - 1, i + (step < 0 ? -1 : 1))); s.splice(i, 1); s.splice(j, 0, id); cur.order = s;
        });
      },
      moveTo: function (id, index) {
        return commit(function () {
          var pk = pageOf(id);
          if (pk) { var ids = displayOrder(pk).filter(function (x) { return x !== id; }); ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id); reorderPage(pk, ids); return; }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('\u0639\u0646\u0635\u0631 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f');
          s.splice(i, 1); s.splice(Math.max(0, Math.min(s.length, index)), 0, id); cur.order = s;
        });
      },
      setText: function (id, lang, text) {
        lang = lang === 'en' ? 'en' : 'ar'; text = String(text == null ? '' : text);
        return commit(function () {
          if (isBuiltin(id)) { var e = section(id); e.title = Object.assign({}, e.title); if (text.trim()) e.title[lang] = text; else delete e.title[lang]; tidy(id); return; }
          var b = block(id); if (!b) throw Error('\u0639\u0646\u0635\u0631 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f');
          if (b.type === 'text') { b.text = Object.assign({}, b.text); if (text.trim()) b.text[lang] = text; else delete b.text[lang]; }
          else if (b.type === 'banner') { b.title = Object.assign({}, b.title); if (text.trim()) b.title[lang] = text; else delete b.title[lang]; }
          else throw Error('bad');
        });
      },
      format: function (id, f) {
        f = f || {};
        return commit(function () {
          var b = block(id); if (!b) throw Error('format blocks only');
          b.style = Object.assign({}, b.style);
          if (f.size) { if (SIZES.indexOf(f.size) === -1) throw Error('bad size'); b.style.size = f.size; }
          var HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
          ['color', 'background'].forEach(function (k) { if (f[k] === '') delete b.style[k]; else if (f[k] !== undefined) { if (!HEX.test(f[k])) throw Error('bad color'); b.style[k] = f[k]; } });
          if (f.align) { if (ALIGNS.indexOf(f.align) === -1) throw Error('bad align'); b.style.align = f.align; }
        });
      },
      resize: function (id, step) {
        var b = block(id); if (!b) throw Error('resize text only');
        var cur_ = (b.style && b.style.size) || 'md', i = SIZES.indexOf(cur_);
        var next = SIZES.indexOf(step) !== -1 ? step : SIZES[Math.max(0, Math.min(SIZES.length - 1, i + (step === 'smaller' ? -1 : 1)))];
        return this.format(id, { size: next });
      },
      createText: function (afterId, text) {
        var id = newId();
        commit(function () { addBlock({ id: id, type: 'text', kind: 'text_block', style: { align: 'center', size: 'md' }, text: { ar: text || '\u0646\u0635 \u062c\u062f\u064a\u062f' } }, afterId); });
        return id;
      },
      createBanner: function (afterId, f) {
        f = f || {}; var id = newId();
        commit(function () {
          var b = { id: id, type: 'banner', kind: 'banner', style: { align: 'center', size: 'lg' }, title: { ar: f.title || '\u0628\u0627\u0646\u0631 \u062c\u062f\u064a\u062f' } };
          if (f.image) b.image = f.image;
          addBlock(b, afterId);
        });
        return id;
      },
      createImage: function (afterId, src) {
        var id = newId();
        commit(function () { addBlock({ id: id, type: 'image', style: { align: 'center', size: 'md' }, src: src, alt: {} }, afterId); });
        return id;
      },
      setMedia: function (id, url) {
        return commit(function () {
          var b = block(id); if (!b) throw Error('pick banner or image');
          if (b.type === 'banner') b.image = url; else if (b.type === 'image') b.src = url; else throw Error('media on banner/image only');
        });
      },
      setSubtitle: function (id, lang, text) {
        lang = lang === 'en' ? 'en' : 'ar'; text = String(text == null ? '' : text);
        return commit(function () {
          var b = block(id); if (!b || b.type !== 'banner') throw Error('subtitle for banner');
          b.subtitle = Object.assign({}, b.subtitle); if (text.trim()) b.subtitle[lang] = text; else delete b.subtitle[lang];
        });
      },
      setHref: function (id, href) {
        if (href && !/^(?:\/(?!\/)|#|https:\/\/)/.test(href)) throw Error('bad href');
        return commit(function () {
          var b = block(id); if (!b) throw Error('missing');
          if (href) b.href = href; else delete b.href;
        });
      },
      setSlot: function (id, slot) {
        if (isBuiltin(id)) throw Error('sections have no slot');
        return commit(function () {
          var b = block(id); if (!b) throw Error('missing');
          b.slot = slot === 'bottom' ? 'bottom' : 'top';
        });
      },
      createSmart: function (afterId, ref) {
        if (!ED.isRef(ref)) throw Error('BAD REF');
        var id = newId();
        commit(function () { addBlock({ id: id, type: 'smart', style: { align: 'center', size: 'md' }, ref: ref }, afterId); });
        return id;
      },
      createFromKind: function (kind, afterId, opts) {
        opts = opts || {};
        var id = newId();
        if (REG && REG.isKind(kind)) {
          var built = REG.buildBlock(kind, Object.assign({}, opts, { id: id }));
          var block = { id: id, type: built.type, style: built.style || { align: 'center', size: 'md' } };
          if (built.kind) block.kind = built.kind;
          if (built.type === 'text') block.text = built.text || { ar: 'نص جديد' };
          else if (built.type === 'banner') {
            block.title = built.title || { ar: 'عنوان جديد' };
            if (built.subtitle) block.subtitle = built.subtitle;
            if (built.image) block.image = built.image;
            if (built.href) block.href = built.href;
          } else if (built.type === 'image') {
            block.src = built.src;
            block.alt = built.alt || {};
            if (built.href) block.href = built.href;
          } else if (built.type === 'smart') {
            block.ref = built.ref;
          }
          commit(function () { addBlock(block, afterId); });
          return id;
        }
        if (kind === 'text' || kind === 'text_block') return this.createText(afterId, opts.text);
        if (kind === 'banner') return this.createBanner(afterId, opts);
        if (kind === 'image' || kind === 'video') return this.createImage(afterId, opts.src || '/assets/cards/masterpieces.webp');
        if (kind === 'section') {
          var ref = opts.ref || ('sec_' + String(Date.now()).slice(-6));
          return this.createSmart(afterId, ref);
        }
        var id2 = newId();
        var titleMap = { brand: 'اسم البراند', store: 'اسم المتجر', perfume: 'اسم العطر', occasion: 'اسم المناسبة', note: 'اسم النوتة العطرية', card: 'كارت جديد' };
        commit(function () {
          addBlock({
            id: id2,
            type: 'banner',
            kind: kind,
            style: { align: 'center', size: 'md' },
            title: { ar: opts.title || titleMap[kind] || 'عنوان جديد' }
          }, afterId);
        });
        return id2;
      },
      registry: function () { return REG; },
      archive: function (id) {
        return commit(function () {
          if (isBuiltin(id)) { section(id).hidden = true; archived.push({ id: id, kind: 'section' }); return; }
          var b = block(id); if (!b) throw Error('missing');
          var pk = pageOf(id);
          if (pk) {
            archived.push({ id: id, kind: 'block', block: clone(b), page: pk, index: displayOrder(pk).indexOf(id) });
            cur.pages[pk].blocks = cur.pages[pk].blocks.filter(function (x) { return x.id !== id; });
          } else {
            archived.push({ id: id, kind: 'block', block: clone(b), index: seqOf(cur).indexOf(id) });
            cur.blocks = (cur.blocks || []).filter(function (x) { return x.id !== id; });
            cur.order = seqOf(cur).filter(function (x) { return x !== id; });
          }
          if (b.type === 'smart' && pending[b.ref]) delete pending[b.ref];
        });
      },
      restore: function (id) {
        return commit(function () {
          if (isBuiltin(id)) {
            var e = section(id); delete e.hidden; tidy(id);
            archived = archived.filter(function (x) { return !(x.id === id && x.kind === 'section'); });
            return;
          }
          var a = archived.filter(function (x) { return x.id === id && x.kind === 'block'; })[0];
          if (!a) throw Error('not archived');
          if (a.page) { pageList(a.page).push(a.block); }
          else {
            cur.blocks = (cur.blocks || []).concat([a.block]);
            var s = seqOf(cur); if (s.indexOf(id) === -1) s.push(id); cur.order = s;
          }
          archived = archived.filter(function (x) { return x !== a; });
        });
      },
      undo: function () {
        if (!past.length) return false;
        future.push(clone(cur)); cur = past.pop(); return true;
      },
      redo: function () {
        if (!future.length) return false;
        past.push(clone(cur)); cur = future.pop(); return true;
      },
      defineSection: function (def) {
        if (!def || !def.element_id) throw Error('bad section');
        pending[def.element_id] = def;
      },
      pendingSections: function () {
        return Object.keys(pending).map(function (k) { return pending[k]; });
      },
      markSaved: function (design) {
        base = ED.normalize(design || cur, { strict: false }).design;
        base.order = seqOf(base);
      }
    };
  }
  return { create: create, SIZES: SIZES, ALIGNS: ALIGNS };
});
