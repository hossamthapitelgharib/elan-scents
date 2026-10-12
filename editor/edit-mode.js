/* Élan Scents — visual edit mode (admin only, runs only inside the Élan Editor window).
   Everything here happens in this tab's memory. Nothing reaches customers or GitHub until the editor
   asks for the design (page.getState) and saves it through the server, which checks the admin again. */
(function () {
  'use strict';
  var layer = window.ElanDesignLayer, ED = window.ElanDesign, Bridge = window.ElanHostBridge;
  if (!layer || !ED || !Bridge || window.parent === window) return;

  var work = null, baseJson = '', baseRevision = null, hostApi = null, selectedId = null, dirty = false;
  var undoStack = [], redoStack = [], editing = null, gesture = null, pendingMedia = null;
  var SECTIONS_NAMES = { section: 1 };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'ar'; }
  function device() { return ED.deviceOf(window.innerWidth); }
  function rid() { var a = new Uint8Array(5); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }

  /* ---------- working design ---------- */
  function emptyDesign() { return ED.normalize({ version: ED.VERSION }).design; }
  function setDirty(v) { if (!!v === dirty) return; dirty = !!v; if (hostApi) hostApi.dirty(dirty); }
  function checkDirty() { setDirty(JSON.stringify(work) !== baseJson); }
  function entries() { return layer.elements(); }
  function entryById(id) { var l = entries(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function bucket(dev) { work.edits = work.edits || {}; return (work.edits[dev] = work.edits[dev] || {}); }
  function edit(dev, id) { var b = bucket(dev); return (b[id] = b[id] || {}); }
  function tidy() {
    if (!work.edits) return;
    Object.keys(work.edits).forEach(function (dev) {
      Object.keys(work.edits[dev]).forEach(function (id) {
        var e = work.edits[dev][id];
        if (e.style && !Object.keys(e.style).length) delete e.style;
        if (!Object.keys(e).length) delete work.edits[dev][id];
      });
      if (!Object.keys(work.edits[dev]).length) delete work.edits[dev];
    });
    if (!Object.keys(work.edits).length) delete work.edits;
  }

  function mutate(fn) {
    undoStack.push(JSON.stringify(work)); if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    fn(work); tidy();
    checkDirty();
    repaint();
  }
  function repaint() { (layer.set || layer.setDesign)(work, { editing: true }); reselect(); }

  function undo() { if (!undoStack.length) return false; redoStack.push(JSON.stringify(work)); work = JSON.parse(undoStack.pop()); checkDirty(); repaint(); return true; }
  function redo() { if (!redoStack.length) return false; undoStack.push(JSON.stringify(work)); work = JSON.parse(redoStack.pop()); checkDirty(); repaint(); return true; }

  /* The order of sections and extra blocks exactly as they appear now. */
  function fullOrder() {
    var main = document.getElementById('main'), seq = [];
    Array.prototype.slice.call(main.children).forEach(function (c) {
      if (c.hasAttribute('data-elan-custom')) seq.push(c.getAttribute('data-elan-id'));
      else if (c.tagName === 'SECTION' && c.id && ED.BUILTIN.indexOf(c.id) !== -1) seq.push(c.id);
    });
    return seq;
  }
  function sectionOf(id) {
    var m = /^sec:([a-z]+)/.exec(id || '');
    if (m) return m[1];
    var e = entryById(id), s = e && e.el.closest('section[id]');
    return s ? s.id : (/^x-/.test(id || '') ? id : null);
  }

  console.log('[edit-mode] TEMP partial push — full body pending');
})();
