/* Élan editor — draft model. Pure logic: every edit happens on a local copy of the design,
   with undo/redo, and nothing touches the network until the owner saves. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./design-schema.js') || require('../design-schema.js'));
  else root.ElanEditModel = factory(root.ElanDesign);
}(typeof self !== 'undefined' ? self : this, function (ED) {
  'use strict';
  if (!ED) throw new Error('ElanDesign required');

  var SIZES = { sm: 1, md: 1, lg: 1 };
  var ALIGNS = { start: 1, center: 1, end: 1 };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function rid() {
    var a = new Uint8Array(5);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (var i = 0; i < 5; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join('');
  }

  function create(seed) {
    var work = ED.normalize(seed || {}).design;
    var base = JSON.stringify(work);
    var undoStack = [], redoStack = [];

    function design() { return work; }
    function dirty() { return JSON.stringify(work) !== base; }
    function snapshot() { undoStack.push(JSON.stringify(work)); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
    function commit() { base = JSON.stringify(work); undoStack = []; redoStack = []; }
    function undo() {
      if (!undoStack.length) return false;
      redoStack.push(JSON.stringify(work));
      work = JSON.parse(undoStack.pop());
      return true;
    }
    function redo() {
      if (!redoStack.length) return false;
      undoStack.push(JSON.stringify(work));
      work = JSON.parse(redoStack.pop());
      return true;
    }

    function section(id) {
      work.sections = work.sections || {};
      return (work.sections[id] = work.sections[id] || {});
    }
    function kind(id) {
      if (work.sections && work.sections[id]) return 'section';
      if (work.blocks && work.blocks[id]) return work.blocks[id].kind || 'block';
      return null;
    }

    function archive(id) {
      snapshot();
      if (work.sections && work.sections[id]) {
        work.sections[id].hidden = true;
        return true;
      }
      if (work.blocks && work.blocks[id]) {
        work.blocks[id].archived = true;
        return true;
      }
      return false;
    }
    function restore(id) {
      snapshot();
      if (work.sections && work.sections[id]) {
        delete work.sections[id].hidden;
        if (!Object.keys(work.sections[id]).length) delete work.sections[id];
        return true;
      }
      if (work.blocks && work.blocks[id]) {
        delete work.blocks[id].archived;
        return true;
      }
      return false;
    }

    function createText(opts) {
      snapshot();
      var id = 'x-' + rid();
      work.blocks = work.blocks || {};
      work.blocks[id] = { kind: 'text', text: (opts && opts.text) || '', size: 'md', align: 'start' };
      return id;
    }

    function format(id, patch) {
      if (!patch || typeof patch !== 'object') throw new Error('bad format');
      var k = kind(id);
      if (!k) throw new Error('unknown id');
      if (patch.size && !SIZES[patch.size]) throw new Error('size not allowed');
      if (patch.align && !ALIGNS[patch.align]) throw new Error('align not allowed');
      snapshot();
      if (k === 'section') {
        var s = section(id);
        Object.keys(patch).forEach(function (key) { s[key] = patch[key]; });
      } else {
        var b = work.blocks[id];
        Object.keys(patch).forEach(function (key) { b[key] = patch[key]; });
      }
      return true;
    }

    return {
      design: design, dirty: dirty, commit: commit, undo: undo, redo: redo,
      kind: kind, archive: archive, restore: restore, createText: createText, format: format,
      _debug: function () { return work; }
    };
  }

  return { create: create, SIZES: SIZES, ALIGNS: ALIGNS };
}));
