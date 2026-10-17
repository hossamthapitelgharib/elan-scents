/* Élan Scents — visual edit mode (admin only, runs only inside the Élan Editor window).
   Everything here happens in this tab's memory. Nothing reaches customers or GitHub until the editor
   asks for the design (page.getState) and saves it through the server, which checks the admin again. */
(function () {
  'use strict';
  var layer = window.ElanDesignLayer, ED = window.ElanDesign, Bridge = window.ElanHostBridge, Geometry = window.ElanEditorGeometry;
  if (!layer || !ED || !Bridge || !Geometry || window.parent === window) return;

  var work = null, baseJson = '', baseRevision = null, hostApi = null, selectedId = null, dirty = false, bridgeTicket = '';
  var undoStack = [], redoStack = [], editing = null, gesture = null, pendingMedia = null, touchPress = null, suppressContextUntil = 0;
  var SECTIONS_NAMES = { section: 1 };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'ar'; }
  function device() { return ED.deviceOf(window.innerWidth); }
  function rid() { var a = new Uint8Array(5); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }
  function editorFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    if (bridgeTicket) options.headers['X-Elan-Editor-Ticket'] = bridgeTicket;
    options.credentials = 'same-origin'; options.cache = 'no-store';
    return fetch(url, options);
  }

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

  /* ---------- overlay ---------- */
  var root = document.createElement('div');
  root.id = 'elan-eo-root';
  root.innerHTML = '<style>' +
    '#elan-eo-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:"IBM Plex Sans Arabic",system-ui,sans-serif;direction:rtl}' +
    '#elan-eo-root *{box-sizing:border-box}' +
    '.eo-box{position:fixed;outline:2px solid #c8962a;background:rgba(200,150,42,.06);display:none}' +
    '.eo-h{position:absolute;width:13px;height:13px;right:-6px;bottom:-6px;background:#c8962a;border-radius:3px;cursor:nwse-resize;pointer-events:auto;touch-action:none}' +
    '.eo-msg{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#29251c;color:#fff;padding:8px 14px;border-radius:9px;font-size:13px;display:none;max-width:90vw;pointer-events:none}' +
    '.eo-dlg{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);pointer-events:auto}' +
    '.eo-dlg>div{background:#fffaf0;border:1px solid #c2a66a;border-radius:12px;padding:16px;width:min(420px,92vw);font-size:13px}' +
    '.eo-dlg input[type=text]{width:100%;padding:7px;border:1px solid #c2a66a;border-radius:7px;direction:ltr;margin:8px 0}' +
    '.eo-dlg button{font:inherit;padding:6px 12px;border:1px solid #c2a66a;border-radius:7px;background:#fff;cursor:pointer;margin-inline-end:6px}' +
    '.eo-tag{position:absolute;top:-24px;right:-2px;background:#c8962a;color:#fff;font-size:11px;padding:2px 8px;border-radius:5px 5px 0 0;white-space:nowrap;pointer-events:none}' +
    '.eo-open{position:absolute;bottom:-26px;right:-2px;background:#29251c;color:#fff;font-size:12px;padding:3px 10px;border-radius:0 0 6px 6px;white-space:nowrap;cursor:pointer;pointer-events:auto;display:none;user-select:none}.eo-open:hover{background:#c8962a}' +
    '[contenteditable]{outline:2px dashed #c8962a;outline-offset:2px}' +
    '</style><div class="eo-box"><span class="eo-tag"></span><span class="eo-open">فتح الصفحة ⤢</span><i class="eo-h" data-h="se"></i></div><div class="eo-msg"></div>' +
    '<div class="eo-dlg"><div><b class="eo-dt"></b><input type="text" class="eo-di" dir="ltr"><p class="eo-dh" style="margin:0 0 8px;color:#7a6a52"></p><button class="eo-ok">تأكيد</button><button class="eo-no">إلغاء</button></div></div>';
  document.body.appendChild(root);

  var tagEl = root.querySelector('.eo-tag'), openEl = root.querySelector('.eo-open');
  var box = root.querySelector('.eo-box'), msgEl = root.querySelector('.eo-msg'), dlg = root.querySelector('.eo-dlg');

  var msgTimer = null;
  function say(text) { msgEl.textContent = text; msgEl.style.display = 'block'; clearTimeout(msgTimer); msgTimer = setTimeout(function () { msgEl.style.display = 'none'; }, 3500); }

  function ask(title, hint, value) {
    return new Promise(function (resolve) {
      root.querySelector('.eo-dt').textContent = title;
      root.querySelector('.eo-dh').textContent = hint || '';
      var input = root.querySelector('.eo-di'); input.value = value || '';
      dlg.style.display = 'flex'; input.focus();
      function done(v) { dlg.style.display = 'none'; root.querySelector('.eo-ok').onclick = root.querySelector('.eo-no').onclick = null; resolve(v); }
      root.querySelector('.eo-ok').onclick = function () { done(input.value.trim()); };
      root.querySelector('.eo-no').onclick = function () { done(null); };
    });
  }

  function placeBox() {
    var e = selectedId && entryById(selectedId);
    if (!e || (e.el.style.display === 'none')) { box.style.display = 'none'; return; }
    var r = e.el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    tagEl.textContent = e.name || e.id;
    tagEl.style.top = r.top < 30 ? '2px' : '-24px';
    var dyn = !!dynamicTarget(e);
    openEl.style.display = dyn ? 'block' : 'none';
    openEl.style.bottom = r.bottom > innerHeight - 34 ? '2px' : '-26px';
  }
  function rgbToHex(c) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
  }
  function cur(id) { return ED.editFor(work, device(), id) || {}; }
  /* What the editor needs to know about an element: the original editor's type names plus its current look. */
  var TYPE_OF = { section: 'section', title: 'text', 'hero-text': 'text', hero: 'section', 'hero-counters': 'text', card: 'card', block: 'block', 'text-area': 'text', group: 'section', 'image-el': 'image' };
  function info(e) {
    if (!e) return null;
    var node = layer.textTarget(e) || e.el, cs = getComputedStyle(node), current = cur(e.id), st = current.style || {};
    var blk = work.blocks.filter(function (b) { return b.id === e.id; })[0];
    var type = blk ? ({ text: 'text_block', banner: 'banner', image: 'image' })[blk.type] : (TYPE_OF[e.kind] || 'text');
    var media = st.media || (current.media && current.media.src) || (blk && (blk.src || blk.image)) || '';
    return {
      id: e.id, name: e.name, kind: e.kind, type: type, text: String(node.textContent || '').trim().slice(0, 120), media: media, canText: !!layer.textTarget(e), isBlock: !!blk, dynamic: !!dynamicTarget(e),
      style: {
        fontFamily: st.fontFamily || (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
        fontSize: st.fontSize || Math.round(parseFloat(cs.fontSize) || 16),
        color: st.color || rgbToHex(cs.color), background: st.background || (function (c) { return !c || c === 'transparent' || /,\s*0\)$/.test(c) ? '' : rgbToHex(c); })(getComputedStyle(e.el).backgroundColor),
        align: st.align || ({ start: 'right', end: 'left', center: 'center', left: 'left', right: 'right' })[cs.textAlign] || 'right',
        effect: st.effect || 'none'
      }
    };
  }
  function reselect() {
    if (selectedId && !entryById(selectedId)) selectedId = null;
    placeBox();
    if (hostApi) hostApi.selection(info(selectedId && entryById(selectedId)));
  }
  function select(id) { selectedId = id; reselect(); }

  function setStyle(id, key, val) {
    mutate(function (d) {
      var e = edit('all', id); e.style = e.style || {};
      if (val === null) delete e.style[key]; else e.style[key] = val;
    });
  }
  function reorder(id, delta) {
    var key = /^sec:/.test(id) ? id.slice(4) : id, seq = fullOrder(), i = seq.indexOf(key), j = i + delta;
    if (i < 0 || j < 0 || j >= seq.length) return;
    mutate(function (d) { seq.splice(i, 1); seq.splice(j, 0, key); d.order = seq; });
  }
  function resetElement(id) { mutate(function (d) { if (d.edits) Object.keys(d.edits).forEach(function (dev) { delete d.edits[dev][id]; }); }); }
  function archive(id) { mutate(function () { edit('all', id).archived = true; }); selectedId = null; reselect(); say('اتحط في الأرشيف. تقدر ترجّعه من الأرشيف.'); }

  /* ---------- picking, drag, resize, text ---------- */
  function inUi(t) { return t && t.nodeType === 1 && root.contains(t); }
  function pick(x, y) {
    var map = new Map(); entries().forEach(function (e) { map.set(e.el, e); });
    var stack = document.elementsFromPoint(x, y), best = null;
    for (var i = 0; i < stack.length; i++) { var e = map.get(stack[i]); if (e) { best = e; break; } }
    return best;
  }

  function base(id) { var e = cur(id); return { dx: e.dx || 0, dy: e.dy || 0 }; }

  /* The open chip explicitly enters a dynamic page; a normal left click remains a selection/drag gesture. */
  function dynamicTarget(e) { return e && layer.goTargetOf ? layer.goTargetOf(e.el) : null; }
  function pageName() { var h = document.querySelector('#view h3'); return (h && h.textContent.trim()) || ''; }
  function inner() { return document.body.classList.contains('inner'); }
  /* Where the owner was before entering each page, so coming back lands on the same spot with the same element selected. */
  var trail = [];
  function depthNow() { try { return inner() ? (typeof P !== 'undefined' && P.length ? P.length : 2) : 1; } catch (_) { return 1; } }
  function restoreFrom(point) { setTimeout(function () { try { scrollTo(0, point.y); } catch (_) { /* optional */ } if (point.id && entryById(point.id)) select(point.id); else reselect(); }, 60); }
  function returnedTo(depth) {
    var at = -1; for (var i = trail.length - 1; i >= 0; i--) if (trail[i].depth === depth) { at = i; break; }
    if (at < 0) return null;
    var point = trail[at]; trail = trail.slice(0, at); return point;
  }
  function goHome() { selectedId = null; var first = returnedTo(1); trail = []; document.body.classList.remove('inner'); scrollTo(0, 0); reselect(); if (first) restoreFrom(first); }
  function goBack() {
    selectedId = null;
    try { if (typeof P !== 'undefined' && P.length > 2) { P = P.slice(0, -1); openP(); } else { document.body.classList.remove('inner'); scrollTo(0, 0); } } catch (_) { goHome(); return; }
    var point = returnedTo(depthNow());
    reselect(); if (point) restoreFrom(point);
  }
  function enterPage(e) {
    var g = dynamicTarget(e); if (!g || typeof window.go !== 'function') return false;
    if (editing) commitText();
    trail.push({ y: Math.round(scrollY), id: e.id, depth: depthNow() }); selectedId = null;
    window.go(g);
    setTimeout(function () { reselect(); say('دخلتي صفحة جديدة' + (pageName() ? ': ' + pageName() : '') + '. كليك يمين فيها للأدوات، ومن القايمة ترجعي.'); }, 60);
    return true;
  }

  openEl.addEventListener('pointerdown', function (ev) { ev.preventDefault(); ev.stopPropagation(); if (selectedId) enterPage(entryById(selectedId)); });
  window.addEventListener('pointerdown', function (ev) {
    if (inUi(ev.target) && !ev.target.classList.contains('eo-h')) return;
    if (editing) { if (editing.node.contains(ev.target)) return; commitText(); }
    var handle = ev.target.classList && ev.target.classList.contains('eo-h') ? ev.target.getAttribute('data-h') : null;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.pointerType === 'touch') {
      if (touchPress) clearTimeout(touchPress.timer);
      touchPress = { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId, timer: setTimeout(function () {
        if (!touchPress || touchPress.pointerId !== ev.pointerId) return;
        suppressContextUntil = Date.now() + 900; gesture = null;
        var target = pick(touchPress.x, touchPress.y);
        select(target ? target.id : null);
        if (hostApi) hostApi.context({ x: touchPress.x, y: touchPress.y, element: info(target), tools: toolList(info(target)) });
      }, 550) };
    }
    var e, mode = 'move';
    if (handle) { e = entryById(selectedId); mode = 'resize'; }
    else {
      e = pick(ev.clientX, ev.clientY);
      if (e) select(e.id); else { select(null); return; }
    }
    if (!e) return;
    var r = e.el.getBoundingClientRect(), b = base(e.id);
    gesture = { id: e.id, el: e.el, mode: mode, handle: handle, sx: ev.clientX, sy: ev.clientY, r: r, b: b, moved: false, dx: b.dx, dy: b.dy, w: null, h: null, startOffset: e.el.style.transform };
    try { (handle ? ev.target : document.documentElement).setPointerCapture && ev.target.setPointerCapture(ev.pointerId); } catch (_) { /* optional */ }
  }, true);

  window.addEventListener('pointermove', function (ev) {
    if (touchPress && touchPress.pointerId === ev.pointerId && Math.hypot(ev.clientX - touchPress.x, ev.clientY - touchPress.y) > 8) {
      clearTimeout(touchPress.timer); touchPress = null;
    }
    if (!gesture) return;
    var g = gesture, ddx = ev.clientX - g.sx, ddy = ev.clientY - g.sy;
    if (!g.moved && Math.abs(ddx) + Math.abs(ddy) < 3) return;
    g.moved = true; ev.preventDefault();
    g.el.style.position = g.el.style.position || 'relative'; g.el.style.zIndex = '3';
    if (g.mode === 'move') {
      var next = Geometry.move(g.r, g.b, { x: ddx, y: ddy });
      g.dx = next.dx; g.dy = next.dy;
      g.el.style.transform = 'translate(' + g.dx + 'px,' + g.dy + 'px)';
    } else {
      var h = g.handle, w = g.r.width, hh = g.r.height;
      if (h.indexOf('e') !== -1) w = g.r.width + ddx; if (h.indexOf('w') !== -1) w = g.r.width - ddx;
      if (h.indexOf('s') !== -1) hh = g.r.height + ddy; if (h.indexOf('n') !== -1) hh = g.r.height - ddy;
      var size = Geometry.resize(g.r.width, g.r.height, w - g.r.width, hh - g.r.height);
      w = size.w; hh = size.h;
      if (h.length === 2 || h === 'e' || h === 'w') { g.el.style.width = w + 'px'; g.el.style.maxWidth = 'none'; g.el.style.flex = '0 0 auto'; g.w = w; }
      if (h.length === 2 || h === 'n' || h === 's') { g.el.style.height = hh + 'px'; g.h = hh; }
      // keep the opposite edge where it was, whatever the page direction is
      var nr = g.el.getBoundingClientRect(), ox = 0, oy = 0;
      if (h.indexOf('e') !== -1) ox = g.r.left - nr.left; else if (h.indexOf('w') !== -1) ox = g.r.right - nr.right;
      if (h.indexOf('s') !== -1) oy = g.r.top - nr.top; else if (h.indexOf('n') !== -1) oy = g.r.bottom - nr.bottom;
      g.dx = Math.round(g.b.dx + ox); g.dy = Math.round(g.b.dy + oy);
      g.el.style.transform = 'translate(' + g.dx + 'px,' + g.dy + 'px)';
    }
    placeBox();
  }, true);

  window.addEventListener('pointerup', function (ev) {
    if (touchPress && touchPress.pointerId === ev.pointerId) { clearTimeout(touchPress.timer); touchPress = null; }
    if (!gesture) return;
    var g = gesture; gesture = null;
    if (!g.moved) return;                      // A plain click selects; only a drag commits offsets.
    ev.preventDefault();
    mutate(function () {
      var e = edit(device(), g.id);
      if (g.dx) e.dx = g.dx; else delete e.dx;
      if (g.dy) e.dy = g.dy; else delete e.dy;
      if (g.w) e.w = g.w;
      if (g.h) e.h = g.h;
    });
  }, true);

  window.addEventListener('pointercancel', function (ev) {
    if (touchPress && touchPress.pointerId === ev.pointerId) { clearTimeout(touchPress.timer); touchPress = null; }
    gesture = null;
  }, true);

  // Nothing on the page may act while editing: no links, no cart, no forms.
  ['click', 'auxclick', 'submit', 'dragstart'].forEach(function (t) {
    window.addEventListener(t, function (ev) { if (inUi(ev.target)) return; if (editing && editing.node.contains(ev.target)) return; ev.preventDefault(); ev.stopPropagation(); }, true);
  });


  /* Right-click: the editor shows the original context menu; this side only reports what is under the pointer. */
  window.addEventListener('contextmenu', function (ev) {
    if (inUi(ev.target)) return;
    ev.preventDefault(); ev.stopPropagation();
    if (Date.now() < suppressContextUntil) return;
    if (editing) commitText();
    var e = pick(ev.clientX, ev.clientY);
    select(e ? e.id : null);
    if (hostApi) hostApi.context({ x: ev.clientX, y: ev.clientY, element: info(e), tools: toolList(info(e)) });
  }, true);

  function startText(id) {
    var e = entryById(id), node = e && layer.textTarget(e);
    if (!node) { say('العنصر ده مفيهوش نص يتعدّل مباشرة.'); return; }
    commitText();
    editing = { id: id, node: node, before: node.textContent };
    node.setAttribute('contenteditable', 'plaintext-only');
    if (node.contentEditable !== 'plaintext-only') node.setAttribute('contenteditable', 'true');
    node.focus();
    var rg = document.createRange(); rg.selectNodeContents(node); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
  }
  function commitText() {
    if (!editing) return;
    var ed = editing; editing = null;
    ed.node.removeAttribute('contenteditable');
    var text = ed.node.textContent.replace(/\r\n?/g, '\n').trim();
    if (!text || text === ed.before) { ed.node.textContent = ed.before; return; }
    mutate(function () {
      var e = edit('all', ed.id); e.text = e.text || {};
      e.text[lang()] = text.slice(0, 600);
    });
  }
  window.addEventListener('dblclick', function (ev) {
    if (inUi(ev.target)) return;
    var e = pick(ev.clientX, ev.clientY); if (!e) return;
    ev.preventDefault(); ev.stopPropagation(); select(e.id); startText(e.id);
  }, true);
  window.addEventListener('keydown', function (ev) {
    if (editing) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commitText(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); editing.node.textContent = editing.before; editing.node.removeAttribute('contenteditable'); editing = null; }
      return;
    }
    if (inUi(ev.target)) return;
    var mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
    else if (mod && (ev.key.toLowerCase() === 'y' || (ev.shiftKey && ev.key.toLowerCase() === 'z'))) { ev.preventDefault(); redo(); }
    else if (selectedId && ev.key === 'Delete') { ev.preventDefault(); archive(selectedId); }
  }, true);
  window.addEventListener('scroll', placeBox, true);
  window.addEventListener('resize', function () { placeBox(); });
  try { new MutationObserver(function () { requestAnimationFrame(reselect); }).observe(document.getElementById('main'), { childList: true }); } catch (_) { /* optional */ }

  /* ---------- creating blocks ---------- */
  /* Put an element so its top-left corner sits at a point of the window, for the current screen size. */
  function placeAt(id, at) {
    var e = entryById(id); if (!e) return;
    var r = e.el.getBoundingClientRect(), b = base(id);
    var dx = Math.round(b.dx + (at.x - r.left)), dy = Math.round(b.dy + (at.y - r.top));
    mutate(function () { var t = edit(device(), id); if (dx) t.dx = dx; else delete t.dx; if (dy) t.dy = dy; else delete t.dy; });
    try { e.el.scrollIntoView({ block: 'nearest' }); } catch (_) { /* optional */ }
  }

  function validBlock(b) { var n = ED.normalize({ version: ED.VERSION, blocks: [b] }, { strict: true }); return n.ok && n.design.blocks.length === 1; }

  function insertAfterSelected(blockId) {
    var seq = fullOrder(), anchor = sectionOf(selectedId), i = seq.indexOf(anchor);
    seq.splice(i === -1 ? 0 : i + 1, 0, blockId);
    return seq;
  }
  async function editorData(action, payload) {
    var r = await editorFetch('/api/editor-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error(j.error || 'تعذر تحميل بيانات الكتالوج.');
    return j;
  }
  function chooseCatalogOption(title, rows, labelOf) {
    rows = Array.isArray(rows) ? rows.filter(function (x) { return x && x.name; }).slice(0, 40) : [];
    if (!rows.length) throw new Error('لا توجد عناصر نشطة من هذا النوع في الكتالوج.');
    var list = rows.map(function (x, i) { return (i + 1) + '. ' + (labelOf ? labelOf(x) : x.name); }).join('\n');
    var choice = prompt(title + '\n\n' + list + (rows.length === 40 ? '\n\nتُعرض أول 40 نتيجة فقط؛ استخدمي بحثًا أضيق إذا لم يظهر المطلوب.' : '') + '\n\nاكتبي رقم الاختيار');
    if (choice === null || !String(choice).trim()) throw new Error('اتلغى');
    var index = Number(choice);
    if (!Number.isInteger(index) || index < 1 || index > rows.length) throw new Error('رقم الاختيار غير صحيح.');
    return rows[index - 1];
  }
  async function createSmart(kind, c) {
    var filters = {}, selectionMode = 'auto', productSizeIds = [], defaultName = 'قسم عطور جديد';
    var filterKinds = {
      brand: { key: 'brand', list: 'brands', label: 'اختاري براندًا نشطًا من الكتالوج' },
      store: { key: 'store', list: 'stores', label: 'اختاري متجرًا نشطًا من الكتالوج' },
      occasion: { key: 'occ', list: 'occasions', label: 'اختاري مناسبة موجودة في الكتالوج' },
      note: { key: 'note', list: 'notes', label: 'اختاري نوتة عطر موجودة في الكتالوج' }
    };
    if (filterKinds[kind]) {
      var options = await editorData('options');
      var spec = filterKinds[kind];
      var selected = chooseCatalogOption(spec.label, options.options && options.options[spec.list]);
      filters[spec.key] = String(selected.name);
      defaultName = String(selected.name);
    } else if (kind === 'perfume') {
      var search = prompt('اكتبي جزءًا من اسم عطر منشور للبحث في الكتالوج');
      if (search === null || !String(search).trim()) throw new Error('اتلغى');
      var found = await editorData('perfumes', { filters: { search: String(search).trim() } });
      var product = chooseCatalogOption('اختاري العطر والحجم المطلوبين', found.rows, function (x) { return x.name + (x.size_label ? ' — ' + x.size_label : ''); });
      if (!product.product_size_id) throw new Error('معرّف حجم المنتج غير متاح.');
      selectionMode = 'manual';
      productSizeIds = [product.product_size_id];
      defaultName = String(product.name || 'عطر محفوظ');
    } else if (kind !== 'section') {
      throw new Error('نوع إنشاء غير مدعوم.');
    }
    var name = String(prompt('اسم القسم الذي سيظهر في المتجر', defaultName) || '').trim();
    if (!name) throw new Error('اكتبي اسمًا للقسم قبل الإنشاء.');
    var elementId = 'x-' + rid();
    if (!validBlock({ id: 'x-' + rid(), type: 'smart', ref: elementId, style: { align: 'center', size: 'md' } })) throw new Error('تعذر تجهيز البلوك الجديد.');
    var j = await editorData('section.create', { section: { element_id: elementId, name: name, purpose: kind, selection_mode: selectionMode, filters: filters, product_size_ids: productSizeIds } });
    if (!j.ref || j.ref !== elementId) throw new Error('لم يتم تأكيد إنشاء القسم المركزي.');
    return createBlock('smart', { ref: j.ref, semanticKind: kind, at: c && c.at });
  }

  function createBlock(kind, opts) {
    opts = opts || {};
    var id = 'x-' + rid(), b;
    if (kind === 'banner') b = { id: id, type: 'banner', title: { ar: opts.title || 'عنوان جديد' }, subtitle: { ar: opts.subtitle || 'سطر تعريفي قصير' }, style: { align: 'center', size: 'md' } };
    else if (kind === 'text_block' || kind === 'text') b = { id: id, type: 'text', text: { ar: opts.text || 'نص جديد' }, style: { align: 'center', size: 'md' } };
    else if (kind === 'image') b = { id: id, type: 'image', src: opts.src, alt: {}, style: { align: 'center', size: 'md' } };
    else if (kind === 'smart') b = { id: id, type: 'smart', ref: opts.ref, style: { align: 'center', size: 'md' }, kind: opts.semanticKind || 'section' };
    else throw new Error('نوع غير مدعوم هنا');
    if (opts.image) b.image = opts.image;
    if (!validBlock(b)) throw new Error('بيانات البلوك غير صالحة (راجعي رابط الصورة).');
    var order = insertAfterSelected(id);
    mutate(function (d) { d.blocks.push(b); d.order = order; });
    select(id);
    if (opts.at) placeAt(id, opts.at);
    return { elementId: id };
  }

  function mediaPrompt(forId) {
    return ask('رابط الصورة', 'لازم يبدأ بـ /assets/ أو برابط مكتبة سابابيس (site-media).', '/assets/').then(function (v) {
      if (!v) throw new Error('اتلغى');
      return v;
    });
  }

  function setMedia(id, src) {
    var b = work.blocks.filter(function (x) { return x.id === id; })[0];
    if (!b) {
      var en = entryById(id);
      if (en && !(en.kind !== 'hero' && en.kind !== 'card' && en.kind !== 'section' && en.kind !== 'image-el')) {
        var kind = /\.(mp4|webm)(\?|$)/i.test(src) ? 'video' : 'image';
        if (kind === 'video' && (en.kind === 'card' || en.kind === 'image-el')) throw new Error('الكارت بيقبل صورة بس.');
        var probe2 = { version: ED.VERSION, edits: { all: {} } }; probe2.edits.all[id] = { media: { src: src, kind: kind } };
        if (!ED.normalize(probe2, { strict: true }).ok) throw new Error('رابط الميديا مش مسموح.');
        mutate(function () { edit('all', id).media = { src: src, kind: kind }; });
        return;
      }
    }
    if (b) {
      var probe = clone(b);
      if (b.type === 'image') probe.src = src;
      else if (b.type === 'banner') probe.image = src;
      else { probe.style = probe.style || {}; probe.style.media = src; }
      if (!validBlock(probe)) throw new Error('رابط الصورة مش مسموح.');
      mutate(function (d) {
        var t = d.blocks.filter(function (x) { return x.id === id; })[0];
        if (t.type === 'image') t.src = src;
        else if (t.type === 'banner') t.image = src;
        else { t.style = t.style || {}; t.style.media = src; }
      });
      return;
    }
    if (!entryById(id)) throw new Error('العنصر غير موجود.');
    mutate(function () { var e = edit('all', id); e.style = e.style || {}; e.style.media = src; });
  }

  function libraryElement(c) {
    var b = work.blocks.filter(function (x) { return x.id === c.id; })[0];
    return clone(b || c.info || { id: c.id, type: 'element' });
  }
  async function saveToLibrary(c) {
    var read = await editorFetch('/api/editor-data?action=library');
    var current = await read.json().catch(function () { return {}; });
    if (!read.ok || !current.ok || !current.library) throw new Error('تعذر قراءة المكتبة المركزية.');
    var element = libraryElement(c), item = { name: element.name || element.id || 'عنصر', kind: element.kind || element.type || 'element', category: element.kind || element.type || 'general', payload: element };
    var saved = Array.isArray(current.library.savedElements) ? current.library.savedElements.slice() : [];
    saved.push(item);
    var write = await editorFetch('/api/editor-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'library.save', expectedRevision: current.library.revision, library: { archive: current.library.archive || [], savedElements: saved } }) });
    var result = await write.json().catch(function () { return {}; });
    if (!write.ok || !result.ok) throw new Error(result.error || 'تعذر حفظ العنصر في المكتبة.');
    return { saved: true };
  }
  function downloadFromLibrary(c) {
    var element = libraryElement(c), blob = new Blob([JSON.stringify({ format: 'elan-element-v1', element: element }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'elan-element.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    return { downloaded: true };
  }
  function insertLibraryPayload(payload, restoreId) {
    var candidate = payload && payload.format === 'elan-element-v1' ? payload.element : payload;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || ['text', 'banner', 'image', 'smart'].indexOf(candidate.type) === -1) throw new Error('العنصر المحفوظ ليس بلوكًا قابلًا للإدراج.');
    var normalized = ED.normalize({ version: ED.VERSION, blocks: [candidate] }, { strict: true });
    if (!normalized.ok || !normalized.design.blocks || normalized.design.blocks.length !== 1) throw new Error('تعريف العنصر المحفوظ غير صالح لهذا التصميم.');
    var block = clone(normalized.design.blocks[0]);
    var id = restoreId || ('x-' + rid());
    if (restoreId && block.id !== restoreId) throw new Error('معرّف العنصر المؤرشف لا يطابق تعريفه.');
    if (work.blocks.some(function (existing) { return existing.id === id; })) throw new Error('العنصر موجود بالفعل في الصفحة.');
    block.id = id;
    if (!validBlock(block)) throw new Error('العنصر المحفوظ لا يجتاز مخطط التصميم.');
    var order = insertAfterSelected(id);
    mutate(function (design) { design.blocks.push(block); design.order = order; });
    select(id);
    return { elementId: id };
  }
  function deleteMedia(c) {
    var block = work.blocks.filter(function (b) { return b.id === c.id; })[0];
    if (!c.info || !c.info.media) { archive(c.id); return { archived: true }; }
    if (block && (block.type === 'image' || block.type === 'video')) { archive(c.id); return { archived: true }; }
    if (block && block.type === 'banner' && block.image) {
      var candidate = clone(block); delete candidate.image;
      if (!validBlock(candidate)) { archive(c.id); return { archived: true }; }
      mutate(function (d) { var target = d.blocks.filter(function (b) { return b.id === c.id; })[0]; if (target) delete target.image; });
      return { mediaRemoved: true };
    }
    mutate(function (d) {
      Object.keys(d.edits || {}).forEach(function (dev) {
        var entry = d.edits[dev] && d.edits[dev][c.id];
        if (!entry) return;
        delete entry.media;
        if (entry.style) { delete entry.style.media; delete entry.style.fit; }
      });
    });
    return { mediaRemoved: true };
  }


  /* ---------- tools: the editor's menu is built from this list, so a new capability = one new register() call ---------- */
  var TOOLS = [];
  function registerTool(t) { TOOLS = TOOLS.filter(function (x) { return x.id !== t.id; }).concat([t]); }
  function toolList(i) {
    return TOOLS.map(function (t) { return { id: t.id, label: t.label, ui: t.ui || null, enabled: t.when ? !!t.when(i) : true }; });
  }
  function has(i) { return !!i; }
  function hasText(i) { return !!(i && i.canText); }
  registerTool({ id: 'format', label: 'تنسيق النص: الخط • اللون • الحجم • 3D', ui: 'format', when: has });
  registerTool({ id: 'open', label: 'فتح العنصر (الدخول لصفحته)', when: function (i) { return !!(i && i.dynamic); }, run: function (c) { enterPage(entryById(c.id)); return null; } });
  registerTool({ id: 'go_back', label: 'رجوع للصفحة السابقة', when: inner, run: function () { goBack(); return null; } });
  registerTool({ id: 'go_home', label: 'رجوع للصفحة الرئيسية', when: inner, run: function () { goHome(); return null; } });
  [['create_section', 'إنشاء سيكشن'], ['create_brand', 'إنشاء كارت براند'], ['create_store', 'إنشاء كارت متجر'], ['create_perfume', 'إنشاء كارت عطر'], ['create_occasion', 'إنشاء مناسبة'], ['create_note', 'إنشاء نوتة عطر']].forEach(function (x) { registerTool({ id: x[0], label: x[1], run: function (c) { return createSmart(x[0].replace('create_', ''), c); } }); });
  registerTool({ id: 'create_text_block', label: 'إنشاء كتلة نصية', run: function (c) { return createBlock('text_block', { at: c.at }); } });
  registerTool({ id: 'create_banner', label: 'إنشاء بانر صورة أو فيديو', ui: 'media_new', run: function (c) { return createBlock('banner', { at: c.at, image: c.src }); } });
  registerTool({ id: 'create_image', label: 'إنشاء صورة', ui: 'media_new', run: function (c) { if (!c.src) throw new Error('اختاري صورة الأول.'); return createBlock('image', { at: c.at, src: c.src }); } });
  registerTool({ id: 'create_text', label: 'إنشاء نص', run: function (c) { return createBlock('text_block', { at: c.at }); } });
  registerTool({ id: 'media', label: 'رفع صورة أو فيديو داخل العناصر أو الهيرو', ui: 'media', when: function (i) { return !!i && ['text', 'text_block'].indexOf(i.type) === -1; }, run: function (c) { return mediaPrompt().then(function (src) { setMedia(c.id, src); return null; }); } });
  registerTool({ id: 'media_delete', label: 'حذف ميديا العنصر إلى الأرشيف', when: function (i) { return !!i && !!i.media; }, run: deleteMedia });
  registerTool({ id: 'edit_text', label: 'تعديل النص بالكيبورد', when: hasText, run: function (c) { startText(c.id); return null; } });
  registerTool({ id: 'copy', label: 'نسخ العنصر', when: has, run: function (c) { return execute('element.duplicate', { elementId: c.id }, {}); } });
  registerTool({ id: 'archive', label: 'حذف العنصر إلى الأرشيف', when: has, run: function (c) { archive(c.id); return null; } });
  registerTool({ id: 'library_save', label: 'حفظ العنصر في المكتبة', when: has, run: saveToLibrary });
  registerTool({ id: 'library_download', label: 'تنزيل العنصر للمكتبة كملف', when: has, run: downloadFromLibrary });
  window.ElanEditTools = { register: registerTool, list: function () { return TOOLS.slice(); } };

  /* ---------- commands from the editor ---------- */
  function archiveList() {
    var out = [], e = (work.edits && work.edits.all) || {};
    Object.keys(e).forEach(function (id) { if (e[id].archived) out.push({ id: id, name: (entryById(id) || { name: id }).name }); });
    return out;
  }
  function snapshot() { return { revision: baseRevision, design: clone(work), device: device(), dirty: dirty, archive: archiveList(), selected: info(selectedId && entryById(selectedId)) }; }
  function need(id) { var e = id && entryById(id); if (!e) throw new Error('اختاري عنصر الأول.'); return e; }

  async function execute(action, p, meta) {
    p = p || {};
    switch (action) {
      case 'page.getState': return snapshot();
      case 'page.markSaved': baseRevision = p.revision; undoStack = []; redoStack = []; baseJson = JSON.stringify(work); dirty = true; setDirty(false); if (hostApi) hostApi.revision(baseRevision); return snapshot();
      case 'element.select': select(need(p.elementId).id); return { selected: selectedId };
      case 'element.move': { var e1 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e1.id); t.dx = Math.round(+p.dx || 0); t.dy = Math.round(+p.dy || 0); }); return null; }
      case 'element.resize': { var e2 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e2.id); if (p.w) t.w = Math.round(p.w); if (p.h) t.h = Math.round(p.h); }); return null; }
      case 'element.format': { var e3 = need(p.elementId || selectedId), sty = p.style || {}; mutate(function (d) { var t = edit('all', e3.id); t.style = t.style || {}; Object.keys(sty).forEach(function (k) { if (sty[k] === null) delete t.style[k]; else t.style[k] = sty[k]; }); }); return null; }
      case 'element.setText': { var e4 = need(p.elementId || selectedId); mutate(function () { var t = edit('all', e4.id); t.text = t.text || {}; t.text[lang()] = String(p.text || '').slice(0, 600); }); return null; }
      case 'element.setMedia': { var e5 = need(p.elementId || selectedId); setMedia(e5.id, p.src || await mediaPrompt(e5.id)); return null; }
      case 'element.create': return createBlock(p.kind, p);
      case 'element.duplicate': {
        var e6 = need(p.elementId || selectedId), src = work.blocks.filter(function (b) { return b.id === e6.id; })[0];
        if (!src) throw new Error('التكرار متاح للبلوكات الإضافية بس.');
        var copy = clone(src); copy.id = 'x-' + rid(); var order = fullOrder(), b0 = base(src.id); order.splice(order.indexOf(src.id) + 1, 0, copy.id);
        var r0 = e6.el.getBoundingClientRect();
        mutate(function (d) { d.blocks.push(copy); d.order = order; var from = d.edits && ((d.edits.all || {})[src.id]); if (from) d.edits.all[copy.id] = JSON.parse(JSON.stringify(from)); });
        select(copy.id); placeAt(copy.id, { x: r0.left + 20, y: r0.top + 20 }); return { elementId: copy.id };
      }
      case 'tool.run': {
        var tool = TOOLS.filter(function (x) { return x.id === p.id; })[0];
        if (!tool) throw new Error('أداة غير معروفة');
        var ei = p.elementId ? entryById(p.elementId) : null, inf = info(ei);
        if (tool.when && !tool.when(inf)) throw new Error('الأداة دي مش متاحة للعنصر ده.');
        var out = await tool.run({ id: p.elementId || null, info: inf, at: p.at || null, src: typeof p.src === 'string' ? p.src : null });
        return out === undefined ? null : out;
      }
      case 'element.nudge': {
        var en = need(p.elementId || selectedId), nb = base(en.id);
        var ndx = nb.dx + Math.round(+p.dx || 0), ndy = nb.dy + Math.round(+p.dy || 0);
        mutate(function () { var t = edit(device(), en.id); if (ndx) t.dx = ndx; else delete t.dx; if (ndy) t.dy = ndy; else delete t.dy; });
        return null;
      }
      case 'element.edit': { var e9 = need(p.elementId || selectedId); startText(e9.id); return null; }
      case 'element.archive': archive(need(p.elementId || selectedId).id); return null;
      case 'archive.restore': {
        var archiveId = String(p.elementId || ''), edits = work.edits || {};
        if (!archiveId) throw new Error('معرّف العنصر المؤرشف مطلوب.');
        var archivedHere = Object.keys(edits).some(function (dev) { return edits[dev] && edits[dev][archiveId] && edits[dev][archiveId].archived; });
        if (archivedHere) mutate(function (d) { Object.keys(d.edits || {}).forEach(function (dev) { if (d.edits[dev][archiveId]) delete d.edits[dev][archiveId].archived; }); });
        else insertLibraryPayload(p.payload, archiveId);
        select(archiveId); return snapshot();
      }
      case 'library.insert': return insertLibraryPayload(p.payload, null);
      case 'history.undo': return { ok: undo() };
      case 'history.redo': return { ok: redo() };
      case 'ui.openFormatPanel': if (p.elementId) select(need(p.elementId).id); if (!selectedId) throw new Error('اضغطي على عنصر في الصفحة الأول.'); return null;
      case 'ui.openMediaPanel': { var id7 = p.elementId || selectedId; if (!id7) throw new Error('اختاري بانر أو صورة الأول.'); setMedia(id7, await mediaPrompt(id7)); return null; }
      case 'ui.openCreatePanel':
        if (p.kind === 'banner' || p.kind === 'text_block' || p.kind === 'text') return createBlock(p.kind === 'text' ? 'text_block' : p.kind, { at: p.at });
        if (p.kind === 'image') { var src8 = await mediaPrompt(); return createBlock('image', { src: src8, at: p.at }); }
        if (['section', 'brand', 'store', 'perfume', 'occasion', 'note'].indexOf(p.kind) !== -1) return createSmart(p.kind, { at: p.at });
        throw new Error('نوع إنشاء غير مدعوم: ' + p.kind);
      case 'library.open': return { openLibrary: true };
      case 'page.save': throw new Error('الحفظ بيتم من الإديتور نفسه بعد التحقق من الإدارة.');
      default: throw new Error('أمر غير مدعوم');
    }
  }

  async function loadBase() {
    var r = await editorFetch('/api/editor?action=state');
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) {
      var why = r.status === 503 ? 'إعدادات الإديتور ناقصة على السيرفر' + (j.missing && j.missing.length ? ': ' + j.missing.join('، ') : '') + '.'
        : r.status === 401 || r.status === 403 ? 'الحساب ده مش مصرح له (محتاج أدمن المنصة). سجلي الدخول تاني.'
        : 'تعذر قراءة آخر إصدار منشور (' + r.status + ').';
      var e = new Error('state'); e.userMessage = why; throw e;
    }
    baseRevision = j.revision === null || j.revision === undefined ? 'initial' : j.revision;
    work = ED.normalize(j.design || { version: ED.VERSION }, { strict: false }).design;
    undoStack = []; redoStack = []; dirty = false; baseJson = JSON.stringify(work);
    repaint();
    return { revision: baseRevision, design: clone(work) };
  }

  function editorParentOrigin() {
    var raw = new URLSearchParams(location.search).get('elan_editor_origin');
    if (!raw || raw.length > 300) return location.origin;
    try {
      var u = new URL(raw);
      var localHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
      var productionEditor = 'https://elan-editor-production-dc4e.up.railway.app';
      if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || u.origin !== raw) return location.origin;
      if (u.origin === productionEditor || (localHttp && u.origin === raw)) return u.origin;
      return location.origin;
    } catch (_) { return location.origin; }
  }

  hostApi = Bridge.install({
    allowedEditorOrigins: [editorParentOrigin()],
    authorize: async function (context) {
      bridgeTicket = context && typeof context.ticket === 'string' ? context.ticket : bridgeTicket;
      if (!bridgeTicket) return false;
      try { var r = await editorFetch('/api/editor-session'); return r.ok; } catch (_) { return false; }
    },
    onTicket: function (ticket) { bridgeTicket = ticket; },
    getState: async function () { if (!work) await loadBase(); return snapshot(); },
    execute: execute
  });
  work = null;
  window.ElanEditMode = { state: snapshot, execute: function (a, p) { return execute(a, p || {}, {}); }, _debug: function () { return work; } };
})();
