/* Élan editor — draft model. Pure logic: every edit happens on a local copy of the design,
   with undo/redo, and nothing touches the network until the owner saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./design-schema.js'));
  else root.ElanEditModel = factory(root.ElanDesign);
})(typeof self !== 'undefined' ? self : this, function (ED) {
  'use strict';

  var SIZES = ['sm', 'md', 'lg', 'xl'];
  var ALIGNS = ['start', 'center', 'end'];

  function clone(d) { return JSON.parse(JSON.stringify(d)); }
  function empty() {
    return { version: ED.VERSION, sections: {}, order: ED.BUILTIN.slice(), blocks: [], texts: {}, pages: {}, edits: {} };
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function create(initial) {
    var n0 = ED.normalize(initial || {}, { strict: false });
    var cur = n0.ok ? n0.design : empty();
    if (!cur.pages) cur.pages = {};
    if (!cur.order || !cur.order.length) cur.order = ED.BUILTIN.slice();
    var base = clone(cur);
    var past = [], future = [], archived = [], page = 'home', pending = {};

    function seqOf(d) {
      var blockIds = (d.blocks || []).map(function (b) { return b.id; });
      var all = ED.BUILTIN.concat(blockIds), out = [];
      (d.order || []).forEach(function (id) { if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id); });
      all.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
      return out;
    }
    function isBuiltin(id) { return ED.BUILTIN.indexOf(id) !== -1; }
    function block(id) {
      var b = (cur.blocks || []).filter(function (x) { return x.id === id; })[0];
      if (b) return b;
      for (var k in cur.pages || {}) {
        b = cur.pages[k].blocks.filter(function (x) { return x.id === id; })[0];
        if (b) return b;
      }
      return null;
    }
    function pageOf(id) {
      if (isBuiltin(id) || (cur.blocks || []).some(function (b) { return b.id === id; })) return null;
      for (var k in cur.pages || {}) {
        if (cur.pages[k].blocks.some(function (b) { return b.id === id; })) return k;
      }
      return null;
    }
    function pageList(pk) {
      if (!cur.pages[pk]) cur.pages[pk] = { blocks: [] };
      return cur.pages[pk].blocks;
    }
    function displayOrder(pk) {
      return pageList(pk).map(function (b) { return b.id; });
    }
    function reorderPage(pk, ids) {
      var map = {};
      pageList(pk).forEach(function (b) { map[b.id] = b; });
      cur.pages[pk].blocks = ids.map(function (id) { return map[id]; }).filter(Boolean);
    }
    function section(id) {
      cur.sections[id] = cur.sections[id] || {};
      return cur.sections[id];
    }
    function tidy(id) {
      var s = cur.sections[id];
      if (!s) return;
      if (s.title) {
        if (!s.title.ar) delete s.title.ar;
        if (!s.title.en) delete s.title.en;
        if (!s.title.ar && !s.title.en) delete s.title;
      }
      if (!s.hidden && !s.title) delete cur.sections[id];
    }
    function rid() {
      var a = new Uint8Array(8);
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
      else for (var i = 0; i < 8; i++) a[i] = Math.floor(Math.random() * 256);
      return 'x-' + Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('').slice(0, 8);
    }
    function commit(fn) {
      past.push(clone(cur));
      if (past.length > 40) past.shift();
      future = [];
      fn();
      return true;
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
          if (pk) {
            var ids = displayOrder(pk), i0 = ids.indexOf(id);
            var j0 = Math.max(0, Math.min(ids.length - 1, i0 + (step < 0 ? -1 : 1)));
            ids.splice(i0, 1); ids.splice(j0, 0, id); reorderPage(pk, ids); return;
          }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('\u0639\u0646\u0635\u0631 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f');
          var j = Math.max(0, Math.min(s.length - 1, i + (step < 0 ? -1 : 1)));
          s.splice(i, 1); s.splice(j, 0, id); cur.order = s;
        });
      },
      moveTo: function (id, index) {
        return commit(function () {
          var pk = pageOf(id);
          if (pk) {
            var ids = displayOrder(pk), i0 = ids.indexOf(id);
            ids.splice(i0, 1);
            ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id);
            reorderPage(pk, ids); return;
          }
          var s = seqOf(cur), i = s.indexOf(id); if (i < 0) throw Error('\u0639\u0646\u0635\u0631 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f');
          s.splice(i, 1); s.splice(Math.max(0, Math.min(s.length, index)), 0, id); cur.order = s;
        });
      },

      setText: function (id, lang, value) {
        return commit(function () {
          if (isBuiltin(id)) {
            var e = section(id);
            e.title = e.title || {};
            if (value) e.title[lang] = value; else delete e.title[lang];
            tidy(id); return;
          }
          var b = block(id); if (!b || b.type !== 'text') throw Error('not text');
          b.text = b.text || {};
          if (value) b.text[lang] = value; else delete b.text[lang];
        });
      },
      format: function (id, style) {
        if (isBuiltin(id)) throw Error('cannot format section');
        var b = block(id); if (!b) throw Error('missing');
        if (style.size && SIZES.indexOf(style.size) === -1) throw Error('bad size');
        if (style.align && ALIGNS.indexOf(style.align) === -1) throw Error('bad align');
        return commit(function () {
          b.style = Object.assign({}, b.style || {}, style);
        });
      },
      resize: function (id, dir) {
        var b = block(id); if (!b) return false;
        var curSize = (b.style && b.style.size) || 'md';
        var i = SIZES.indexOf(curSize);
        if (dir === 'bigger' && i < SIZES.length - 1) return this.format(id, { size: SIZES[i + 1] });
        if (dir === 'smaller' && i > 0) return this.format(id, { size: SIZES[i - 1] });
        return false;
      },

      createText: function (after, ar) {
        var id = rid();
        commit(function () {
          var b = { id: id, type: 'text', style: { align: 'center', size: 'md' }, text: { ar: ar || '\u0646\u0635 \u062c\u062f\u064a\u062f' }, slot: 'top' };
          if (page === 'home') {
            cur.blocks.push(b);
            var s = seqOf(cur);
            if (after && s.indexOf(after) !== -1) s.splice(s.indexOf(after) + 1, 0, id); else s.push(id);
            cur.order = s;
          } else {
            var list = pageList(page);
            if (after) {
              var i = list.findIndex(function (x) { return x.id === after; });
              if (i >= 0) list.splice(i + 1, 0, b); else list.push(b);
            } else list.push(b);
          }
        });
        return id;
      },
      createBanner: function (after, opts) {
        opts = opts || {};
        var id = rid();
        commit(function () {
          var b = { id: id, type: 'banner', style: { align: 'center', size: 'md' }, title: { ar: opts.title || '\u0628\u0627\u0646\u0631' }, slot: 'top' };
          if (page === 'home') { cur.blocks.push(b); cur.order = seqOf(cur).concat([id]); }
          else pageList(page).push(b);
        });
        return id;
      },
      createImage: function (after, src) {
        var id = rid();
        commit(function () {
          var b = { id: id, type: 'image', style: { align: 'center', size: 'md' }, src: src, alt: {}, slot: 'top' };
          if (page === 'home') { cur.blocks.push(b); cur.order = seqOf(cur).concat([id]); }
          else pageList(page).push(b);
        });
        return id;
      },
      createSmart: function (after, ref) {
        if (!ED.isRef(ref)) throw Error('BAD REF');
        var id = rid();
        commit(function () {
          var b = { id: id, type: 'smart', style: { align: 'center', size: 'md' }, ref: ref, slot: 'top' };
          if (page === 'home') { cur.blocks.push(b); cur.order = seqOf(cur).concat([id]); }
          else pageList(page).push(b);
        });
        return id;
      },

      setMedia: function (id, url) {
        return commit(function () {
          var b = block(id); if (!b) throw Error('missing');
          if (b.type === 'banner') b.image = url;
          else if (b.type === 'image') b.src = url;
          else throw Error('not media');
        });
      },
      setSubtitle: function (id, lang, value) {
        return commit(function () {
          var b = block(id); if (!b || b.type !== 'banner') throw Error('not banner');
          b.subtitle = b.subtitle || {};
          if (value) b.subtitle[lang] = value; else delete b.subtitle[lang];
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
            cur.blocks = cur.blocks.filter(function (x) { return x.id !== id; });
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
          if (a.page) {
            var l = pageList(a.page); l.push(a.block);
          } else {
            cur.blocks.push(a.block);
            var s = seqOf(cur);
            if (s.indexOf(id) === -1) s.push(id);
            cur.order = s;
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

      /* Mark current design as the clean baseline after a successful save. */
      markClean: function (design) {
        base = ED.normalize(design || cur, { strict: false }).design;
        base.order = seqOf(base);
        cur = clone(base);
        past = []; future = [];
      }
    };
  }

  return { create: create, SIZES: SIZES, ALIGNS: ALIGNS };
});
