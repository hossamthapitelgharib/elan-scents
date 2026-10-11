/* Élan editor — draft model. Pure logic: every edit happens on a local copy of the design,
   with undo/redo, and nothing touches the network until the owner saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./design-schema.js'));
  else root.ElanEditModel = factory(root.ElanDesign);
})(typeof self !== 'undefined' ? self : this, function (ED) {
  'use strict';

  function clone(d) { return JSON.parse(JSON.stringify(d)); }
  function empty() {
    return { version: ED.VERSION, sections: {}, order: [], blocks: [], texts: {}, pages: {}, edits: {} };
  }

  function create(initial) {
    var n = ED.normalize(initial || {}, { strict: false });
    var design = n.ok ? n.design : empty();
    if (!design.pages) design.pages = {};
    if (!design.edits) design.edits = {};
    var history = [], future = [], dirty = false;
    var page = 'home';
    var pendingSections = [];

    function snap() {
      history.push(clone({ design: design, page: page, pendingSections: pendingSections }));
      if (history.length > 40) history.shift();
      future = [];
      dirty = true;
    }

    function seq() {
      if (page === 'home') {
        var blockIds = (design.blocks || []).map(function (b) { return b.id; });
        var all = ED.BUILTIN.concat(blockIds), out = [];
        (design.order || []).forEach(function (id) { if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id); });
        all.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
        return out;
      }
      var pg = design.pages[page];
      return pg ? pg.blocks.slice() : [];
    }

    function kind(id) {
      if (ED.BUILTIN.indexOf(id) !== -1) return 'section';
      var b = (design.blocks || []).filter(function (x) { return x.id === id; })[0];
      if (b) return b.type;
      for (var k in design.pages || {}) {
        var bb = design.pages[k].blocks.filter(function (x) { return x.id === id; })[0];
        if (bb) return bb.type;
      }
      return null;
    }

    function pageOf(id) {
      if (ED.BUILTIN.indexOf(id) !== -1 || (design.blocks || []).some(function (b) { return b.id === id; })) return 'home';
      for (var k in design.pages || {}) {
        if (design.pages[k].blocks.some(function (b) { return b.id === id; })) return k;
      }
      return null;
    }

    function move(id, dir) {
      if (page === 'home') {
        var s = seq(), i = s.indexOf(id), j = i + dir;
        if (i < 0 || j < 0 || j >= s.length) return false;
        snap(); s.splice(i, 1); s.splice(j, 0, id); design.order = s; return true;
      }
      var pg = design.pages[page]; if (!pg) return false;
      var list = pg.blocks, i2 = list.findIndex(function (b) { return b.id === id; }), j2 = i2 + dir;
      if (i2 < 0 || j2 < 0 || j2 >= list.length) return false;
      snap(); var item = list.splice(i2, 1)[0]; list.splice(j2, 0, item); return true;
    }

    function rid() {
      return 'x-' + Math.random().toString(36).slice(2, 10);
    }

    function createText(after, ar) {
      snap();
      var b = { id: rid(), type: 'text', style: { align: 'center', size: 'md' }, text: { ar: ar || 'نص جديد' }, slot: 'top' };
      if (page === 'home') {
        design.blocks.push(b);
        var s = seq(); if (after && s.indexOf(after) !== -1) s.splice(s.indexOf(after) + 1, 0, b.id); else s.push(b.id);
        design.order = s;
      } else {
        design.pages[page] = design.pages[page] || { blocks: [] };
        var list = design.pages[page].blocks;
        if (after) { var i = list.findIndex(function (x) { return x.id === after; }); if (i >= 0) list.splice(i + 1, 0, b); else list.push(b); }
        else list.push(b);
      }
      return b.id;
    }

    function createBanner(after, opts) {
      snap();
      opts = opts || {};
      var b = { id: rid(), type: 'banner', style: { align: 'center', size: 'md' }, title: { ar: opts.title || 'بانر' }, slot: 'top' };
      if (page === 'home') { design.blocks.push(b); design.order = seq().concat([b.id]); }
      else { design.pages[page] = design.pages[page] || { blocks: [] }; design.pages[page].blocks.push(b); }
      return b.id;
    }

    function createImage(after, src) {
      snap();
      var b = { id: rid(), type: 'image', style: { align: 'center', size: 'md' }, src: src, alt: {}, slot: 'top' };
      if (page === 'home') { design.blocks.push(b); design.order = seq().concat([b.id]); }
      else { design.pages[page] = design.pages[page] || { blocks: [] }; design.pages[page].blocks.push(b); }
      return b.id;
    }

    function createSmart(after, ref) {
      if (!ED.isRef(ref)) throw new Error('invalid smart ref');
      snap();
      var b = { id: rid(), type: 'smart', style: { align: 'center', size: 'md' }, ref: ref, slot: 'top' };
      if (page === 'home') { design.blocks.push(b); design.order = seq().concat([b.id]); }
      else { design.pages[page] = design.pages[page] || { blocks: [] }; design.pages[page].blocks.push(b); }
      return b.id;
    }

    function findBlock(id) {
      var b = (design.blocks || []).filter(function (x) { return x.id === id; })[0];
      if (b) return b;
      for (var k in design.pages || {}) {
        b = design.pages[k].blocks.filter(function (x) { return x.id === id; })[0];
        if (b) return b;
      }
      return null;
    }

    function setText(id, lang, value) {
      if (ED.BUILTIN.indexOf(id) !== -1) {
        snap();
        design.sections[id] = design.sections[id] || {};
        design.sections[id].title = design.sections[id].title || {};
        if (value) design.sections[id].title[lang] = value; else delete design.sections[id].title[lang];
        return;
      }
      var b = findBlock(id); if (!b || b.type !== 'text') return;
      snap(); b.text = b.text || {}; if (value) b.text[lang] = value; else delete b.text[lang];
    }

    function format(id, style) {
      var b = findBlock(id);
      if (!b) throw new Error('cannot format section');
      snap(); b.style = Object.assign({}, b.style || {}, style);
      // validate via schema on save
      var test = clone(design);
      var n = ED.normalize(test, { strict: true });
      if (!n.ok) { /* revert is handled by not keeping bad - but we already snapped */ }
    }

    function resize(id, dir) {
      var b = findBlock(id); if (!b) return;
      var sizes = ['sm', 'md', 'lg', 'xl'];
      var cur = (b.style && b.style.size) || 'md';
      var i = sizes.indexOf(cur);
      if (dir === 'bigger' && i < sizes.length - 1) format(id, { size: sizes[i + 1] });
      if (dir === 'smaller' && i > 0) format(id, { size: sizes[i - 1] });
    }

    function setMedia(id, url) {
      var b = findBlock(id); if (!b) return;
      snap();
      if (b.type === 'banner') b.image = url;
      else if (b.type === 'image') b.src = url;
    }

    function setSubtitle(id, lang, value) {
      var b = findBlock(id); if (!b || b.type !== 'banner') return;
      snap(); b.subtitle = b.subtitle || {}; if (value) b.subtitle[lang] = value; else delete b.subtitle[lang];
    }

    function setHref(id, href) {
      var b = findBlock(id); if (!b) return;
      if (href && !/^(?:\/(?!\/)|#|https:\/\/)/.test(href)) throw new Error('bad href');
      snap(); if (href) b.href = href; else delete b.href;
    }

    function setSlot(id, slot) {
      if (ED.BUILTIN.indexOf(id) !== -1) throw new Error('sections have no slot');
      var b = findBlock(id); if (!b) return;
      snap(); b.slot = slot === 'bottom' ? 'bottom' : 'top';
    }

    function archive(id) {
      snap();
      if (ED.BUILTIN.indexOf(id) !== -1) {
        design.sections[id] = design.sections[id] || {};
        design.sections[id].hidden = true;
        return;
      }
      design.blocks = (design.blocks || []).filter(function (b) { return b.id !== id; });
      design.order = (design.order || []).filter(function (x) { return x !== id; });
      for (var k in design.pages || {}) {
        design.pages[k].blocks = design.pages[k].blocks.filter(function (b) { return b.id !== id; });
      }
      pendingSections = pendingSections.filter(function (s) {
        var b = findBlock(id);
        return true;
      });
      // remove pending section if archived smart
      pendingSections = pendingSections.filter(function (s) {
        // keep all for simplicity if block gone
        return design.blocks.concat.apply([], Object.keys(design.pages || {}).map(function (k) { return design.pages[k].blocks; })).some(function (b) { return b.type === 'smart' && b.ref === s.element_id; }) || (design.blocks || []).some(function (b) { return b.type === 'smart' && b.ref === s.element_id; });
      });
    }

    function restore(id) {
      if (ED.BUILTIN.indexOf(id) !== -1) {
        snap();
        if (design.sections[id]) delete design.sections[id].hidden;
        if (design.sections[id] && !design.sections[id].title && !design.sections[id].hidden) delete design.sections[id];
        return true;
      }
      // restore from history is via undo; simple restore for archived blocks not fully tracked
      return false;
    }

    function undo() {
      if (!history.length) return false;
      future.push(clone({ design: design, page: page, pendingSections: pendingSections }));
      var prev = history.pop();
      design = prev.design; page = prev.page; pendingSections = prev.pendingSections;
      dirty = history.length > 0;
      return true;
    }

    function redo() {
      if (!future.length) return false;
      history.push(clone({ design: design, page: page, pendingSections: pendingSections }));
      var next = future.pop();
      design = next.design; page = next.page; pendingSections = next.pendingSections;
      dirty = true;
      return true;
    }

    function setPage(key) {
      if (key !== 'home' && !ED.isPageKey(key) && key !== 'home') {
        if (key === 'home') { page = 'home'; return; }
      }
      page = key === 'home' ? 'home' : key;
      if (page !== 'home' && !design.pages[page]) design.pages[page] = { blocks: [] };
    }

    function defineSection(def) {
      snap();
      pendingSections = pendingSections.filter(function (s) { return s.element_id !== def.element_id; });
      pendingSections.push(def);
    }

    return {
      design: function () { return clone(design); },
      dirty: function () { return dirty; },
      sequence: function () { return page === 'home' ? seq() : (design.pages[page] ? design.pages[page].blocks.map(function (b) { return b; }) : []); },
      kind: kind,
      pageOf: pageOf,
      move: move,
      createText: createText,
      createBanner: createBanner,
      createImage: createImage,
      createSmart: createSmart,
      setText: setText,
      format: format,
      resize: resize,
      setMedia: setMedia,
      setSubtitle: setSubtitle,
      setHref: setHref,
      setSlot: setSlot,
      archive: archive,
      restore: restore,
      undo: undo,
      redo: redo,
      setPage: setPage,
      defineSection: defineSection,
      pendingSections: function () { return pendingSections.slice(); }
    };
  }

  return { create: create };
});
