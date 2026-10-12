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
  /* The home page keeps its edits and blocks at the top of the design; every inner page keeps its own under pages[key]. */
  function pageKeyNow() { try { return layer.pageKey() || 'home'; } catch (_) { return 'home'; } }
  function onHome() { return pageKeyNow() === 'home'; }
  function holder(create) {
    var key = pageKeyNow();
    if (key === 'home') return work;
    if (!work.pages) { if (!create) return null; work.pages = {}; }
    if (!work.pages[key]) { if (!create) return null; work.pages[key] = { blocks: [] }; }
    return work.pages[key];
  }
  function blocksHere() { var h = holder(false); return (h && h.blocks) || []; }
  function bucket(dev) { var h = holder(true); h.edits = h.edits || {}; return (h.edits[dev] = h.edits[dev] || {}); }
  function edit(dev, id) { var b = bucket(dev); return (b[id] = b[id] || {}); }
  function tidyEdits(h) {
    if (!h || !h.edits) return;
    Object.keys(h.edits).forEach(function (dev) {
      Object.keys(h.edits[dev]).forEach(function (id) {
        var e = h.edits[dev][id];
        if (e.style && !Object.keys(e.style).length) delete e.style;
        if (!Object.keys(e).length) delete h.edits[dev][id];
      });
      if (!Object.keys(h.edits[dev]).length) delete h.edits[dev];
    });
    if (!Object.keys(h.edits).length) delete h.edits;
  }
  function tidy() {
    tidyEdits(work);
    if (work.pages) {
      Object.keys(work.pages).forEach(function (k) { tidyEdits(work.pages[k]); if (!(work.pages[k].blocks || []).length && !work.pages[k].edits) delete work.pages[k]; });
      if (!Object.keys(work.pages).length) delete work.pages;
    }
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
    '[contenteditable]{outline:2px dashed #c8962a;outline-offset:2px}' +
    '</style><div class="eo-box"><i class="eo-h" data-h="se"></i></div><div class="eo-msg"></div>' +
    '<div class="eo-dlg"><div><b class="eo-dt"></b><input type="text" class="eo-di" dir="ltr"><p class="eo-dh" style="margin:0 0 8px;color:#7a6a52"></p><button class="eo-ok">تأكيد</button><button class="eo-no">إلغاء</button></div></div>';
  document.body.appendChild(root);

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
  }
  function rgbToHex(c) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
  }
  function cur(id) { var h = holder(false); return (h && ED.editFor(h, device(), id)) || {}; }
  /* What the editor needs to know about an element: the original editor's type names plus its current look. */
  var TYPE_OF = { section: 'section', title: 'text', 'hero-text': 'text', hero: 'section', 'hero-counters': 'text', card: 'card', block: 'block' };
  function info(e) {
    if (!e) return null;
    var node = layer.textTarget(e) || e.el, cs = getComputedStyle(node), st = cur(e.id).style || {};
    var blk = blocksHere().filter(function (b) { return b.id === e.id; })[0];
    var type = blk ? ({ text: 'text_block', banner: 'banner', image: 'image' })[blk.type] : (TYPE_OF[e.kind] || 'text');
    return {
      id: e.id, name: e.name, kind: e.kind, type: type, canText: !!layer.textTarget(e), isBlock: !!blk,
      style: {
        fontFamily: st.fontFamily || (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
        fontSize: st.fontSize || Math.round(parseFloat(cs.fontSize) || 16),
        color: st.color || rgbToHex(cs.color), background: st.background || rgbToHex(getComputedStyle(e.el).backgroundColor),
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
  function resetElement(id) { mutate(function () { var h = holder(false); if (h && h.edits) Object.keys(h.edits).forEach(function (dev) { delete h.edits[dev][id]; }); }); }
  function archive(id) { mutate(function () { edit('all', id).archived = true; }); selectedId = null; reselect(); say('اتحط في الأرشيف. تقدر ترجّعه من الأرشيف.'); }


  /* One-shot move: chosen from the menu for ONE element; ends the moment the mouse is released. */
  var moveArmed = null;
  function armMove(id) {
    moveArmed = id; select(id);
    box.style.outlineStyle = 'dashed'; box.style.cursor = 'move';
    say('اضغطي بالماوس على العنصر واسحبيه، وسيبيه في المكان اللي تحبيه.');
  }
  function disarmMove() { moveArmed = null; box.style.outlineStyle = 'solid'; box.style.cursor = ''; }

  /* ---------- picking, drag, resize, text ---------- */
  function inUi(t) { return t && t.nodeType === 1 && root.contains(t); }
  function pick(x, y) {
    var map = new Map(); entries().forEach(function (e) { map.set(e.el, e); });
    var stack = document.elementsFromPoint(x, y), best = null;
    for (var i = 0; i < stack.length; i++) { var e = map.get(stack[i]); if (e) { best = e; break; } }
    return best;
  }

  function base(id) { var e = cur(id); return { dx: e.dx || 0, dy: e.dy || 0 }; }

  window.addEventListener('pointerdown', function (ev) {
    if (inUi(ev.target) && !ev.target.classList.contains('eo-h')) return;
    if (editing) { if (editing.node.contains(ev.target)) return; commitText(); }
    var handle = ev.target.classList && ev.target.classList.contains('eo-h') ? ev.target.getAttribute('data-h') : null;
    ev.preventDefault(); ev.stopPropagation();
    if (ev.button !== undefined && ev.button !== 0) return;
    var e;
    if (handle) e = entryById(selectedId);
    else {
      var armedEntry = moveArmed && entryById(moveArmed);
      if (armedEntry && armedEntry.el.contains(ev.target)) e = armedEntry;
      else { disarmMove(); e = pick(ev.clientX, ev.clientY); if (e) select(e.id); else { select(null); return; } if (e) return; }
    }
    if (!e) return;
    var r = e.el.getBoundingClientRect(), b = base(e.id);
    gesture = { id: e.id, el: e.el, mode: handle ? 'resize' : 'move', handle: handle, sx: ev.clientX, sy: ev.clientY, r: r, b: b, moved: false, dx: b.dx, dy: b.dy, w: null, h: null, startOffset: e.el.style.transform };
    try { (handle ? ev.target : document.documentElement).setPointerCapture && ev.target.setPointerCapture(ev.pointerId); } catch (_) { /* optional */ }
  }, true);

  window.addEventListener('pointermove', function (ev) {
    if (!gesture) return;
    var g = gesture, ddx = ev.clientX - g.sx, ddy = ev.clientY - g.sy;
    if (!g.moved && Math.abs(ddx) + Math.abs(ddy) < 3) return;
    g.moved = true; ev.preventDefault();
    g.el.style.position = g.el.style.position || 'relative'; g.el.style.zIndex = '3';
    if (g.mode === 'move') {
      g.dx = Math.round(g.b.dx + ddx); g.dy = Math.round(g.b.dy + ddy);
      g.el.style.transform = 'translate(' + g.dx + 'px,' + g.dy + 'px)';
    } else {
      var h = g.handle, w = g.r.width, hh = g.r.height;
      if (h.indexOf('e') !== -1) w = g.r.width + ddx; if (h.indexOf('w') !== -1) w = g.r.width - ddx;
      if (h.indexOf('s') !== -1) hh = g.r.height + ddy; if (h.indexOf('n') !== -1) hh = g.r.height - ddy;
      w = Math.max(16, Math.round(w)); hh = Math.max(16, Math.round(hh));
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
    if (!gesture) return;
    var g = gesture; gesture = null;
    if (g.mode === 'move') disarmMove();
    if (!g.moved) return;
    ev.preventDefault();
    mutate(function () {
      var e = edit(device(), g.id);
      if (g.dx) e.dx = g.dx; else delete e.dx;
      if (g.dy) e.dy = g.dy; else delete e.dy;
      if (g.w) e.w = g.w;
      if (g.h) e.h = g.h;
    });
  }, true);

  // Nothing on the page may act while editing: no links, no cart, no forms.
  var homeClick = false;
  var ENTER_RE = /^(brand|store|col|sec)\|/;
  function allowClick(t) {
    if (!t || !t.closest) return false;
    var c = t.closest('[data-go]');
    if (c && ENTER_RE.test(c.getAttribute('data-go') || '')) return true; // a plain click on a brand / store / category / occasion / note card opens its page
    return !!t.closest('nav.bc a');                                          // and the breadcrumb takes you back
  }
  ['click', 'auxclick', 'submit', 'dragstart'].forEach(function (t) {
    window.addEventListener(t, function (ev) {
      if (inUi(ev.target)) return;
      if (editing && editing.node.contains(ev.target)) return;
      if (ev.type === 'click' && (homeClick || (ev.button === 0 && !moveArmed && allowClick(ev.target)))) return;
      ev.preventDefault(); ev.stopPropagation();
    }, true);
  });


  /* Right-click: the editor shows the original context menu; this side only reports what is under the pointer. */
  window.addEventListener('contextmenu', function (ev) {
    if (inUi(ev.target)) return;
    ev.preventDefault(); ev.stopPropagation();
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
    var text = ed.node.textContent.replace(/\s+/g, ' ').trim();
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
    else if (ev.key === 'Escape' && moveArmed) { disarmMove(); }
  }, true);
  window.addEventListener('scroll', placeBox, true);
  window.addEventListener('resize', function () { placeBox(); });
  var PAGE_NAMES = { cats: 'فئة', occ: 'مناسبة', notes: 'نوتة' }, SEC_LABEL = { brands: 'الماركات', stores: 'المتاجر', cats: 'الأقسام', occ: 'المناسبات', notes: 'النوتات', all: 'كل العطور', offers: 'العروض', new: 'وصل حديثًا', master: 'الأعلى مبيعًا', soon: 'قريبًا' };
  function pageLabel() {
    var k = pageKeyNow(), m;
    if (k === 'home') return 'الصفحة الرئيسية';
    if ((m = /^brand:(.+)$/.exec(k))) return 'صفحة براند ' + m[1];
    if ((m = /^store:(.+)$/.exec(k))) return 'صفحة متجر ' + m[1];
    if ((m = /^sec:(.+)$/.exec(k))) return 'صفحة ' + (SEC_LABEL[m[1]] || m[1]);
    if ((m = /^col:([a-z]+):/.exec(k))) { var h = document.querySelector('#view h3'); return 'صفحة ' + (PAGE_NAMES[m[1]] || 'تجميعة') + (h ? ' ' + h.textContent.trim().slice(0, 30) : ''); }
    return 'صفحة داخلية';
  }
  var lastPage = null;
  function announcePage() {
    var k = pageKeyNow();
    if (k === lastPage) return;
    lastPage = k; selectedId = null; placeBox();
    if (hostApi) { hostApi.selection(null); hostApi.page({ key: k, label: pageLabel() }); }
  }
  function onDomChange() { requestAnimationFrame(function () { announcePage(); reselect(); }); }
  try {
    var mo = new MutationObserver(onDomChange);
    mo.observe(document.getElementById('main'), { childList: true });
    var vw = document.getElementById('view'); if (vw) mo.observe(vw, { childList: true });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (_) { /* optional */ }

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
  function createBlock(kind, opts) {
    opts = opts || {};
    var id = 'x-' + rid(), b;
    if (kind === 'banner') b = { id: id, type: 'banner', title: { ar: opts.title || 'عنوان جديد' }, subtitle: { ar: opts.subtitle || 'سطر تعريفي قصير' }, style: { align: 'center', size: 'md' } };
    else if (kind === 'text_block' || kind === 'text') b = { id: id, type: 'text', text: { ar: opts.text || 'نص جديد' }, style: { align: 'center', size: 'md' } };
    else if (kind === 'image') b = { id: id, type: 'image', src: opts.src, alt: {}, style: { align: 'center', size: 'md' } };
    else throw new Error('نوع غير مدعوم هنا');
    if (opts.image) b.image = opts.image;
    if (!validBlock(b)) throw new Error('بيانات البلوك غير صالحة (راجعي رابط الصورة).');
    if (onHome()) {
      var order = insertAfterSelected(id);
      mutate(function (d) { d.blocks.push(b); d.order = order; });
    } else {
      b.slot = 'top';
      mutate(function () { holder(true).blocks.push(b); });
    }
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
    var b = blocksHere().filter(function (x) { return x.id === id; })[0];
    if (!b || (b.type !== 'image' && b.type !== 'banner')) throw new Error('الصور بتتغيّر في بلوك صورة أو بانر بس.');
    var probe = clone(b); if (b.type === 'image') probe.src = src; else probe.image = src;
    if (!validBlock(probe)) throw new Error('رابط الصورة مش مسموح.');
    mutate(function () { var t = blocksHere().filter(function (x) { return x.id === id; })[0]; if (t.type === 'image') t.src = src; else t.image = src; });
  }


  /* ---------- tools: the editor's menu is built from this list, so a new capability = one new register() call ---------- */
  var TOOLS = [];
  function registerTool(t) { TOOLS = TOOLS.filter(function (x) { return x.id !== t.id; }).concat([t]); }
  function toolList(i) {
    return TOOLS.map(function (t) { return { id: t.id, label: t.label, ui: t.ui || null, enabled: t.when ? !!t.when(i) : true }; });
  }
  var NEEDS_DB = 'بيتربط بسابابيس في المرحلة الجاية.';
  function later(label) { return function () { throw new Error(label + ' ' + NEEDS_DB); }; }
  function has(i) { return !!i; }
  function hasText(i) { return !!(i && i.canText); }
  registerTool({ id: 'format', label: 'تنسيق النص: الخط • اللون • الحجم • 3D', ui: 'format', when: has });
  registerTool({ id: 'move', label: 'تحريك العنصر', when: has, run: function (c) { armMove(c.id); return null; } });
  [['create_section', 'إنشاء سيكشن'], ['create_brand', 'إنشاء كارت براند'], ['create_store', 'إنشاء كارت متجر'], ['create_perfume', 'إنشاء كارت عطر'], ['create_occasion', 'إنشاء مناسبة'], ['create_note', 'إنشاء نوتة عطر']].forEach(function (x) { registerTool({ id: x[0], label: x[1], run: later(x[1]) }); });
  registerTool({ id: 'create_text_block', label: 'إنشاء كتلة نصية', run: function (c) { return createBlock('text_block', { at: c.at }); } });
  registerTool({ id: 'create_banner', label: 'إنشاء بانر صورة أو فيديو', run: function (c) { return createBlock('banner', { at: c.at }); } });
  registerTool({ id: 'create_text', label: 'إنشاء نص', run: function (c) { return createBlock('text_block', { at: c.at }); } });
  registerTool({ id: 'media', label: 'رفع صورة أو فيديو داخل العناصر أو الهيرو', when: function (i) { return !!i && ['card', 'banner', 'image', 'section'].indexOf(i.type) !== -1; }, run: function (c) { return mediaPrompt().then(function (src) { setMedia(c.id, src); return null; }); } });
  registerTool({ id: 'media_delete', label: 'حذف ميديا الكارت أو الهيرو إلى الأرشيف', when: function () { return false; }, run: later('حذف الميديا') });
  registerTool({ id: 'edit_text', label: 'تعديل النص بالكيبورد', when: hasText, run: function (c) { startText(c.id); return null; } });
  registerTool({ id: 'copy', label: 'نسخ العنصر', when: has, run: function (c) { return execute('element.duplicate', { elementId: c.id }, {}); } });
  registerTool({ id: 'archive', label: 'حذف العنصر إلى الأرشيف', when: has, run: function (c) { archive(c.id); return null; } });
  registerTool({ id: 'library_save', label: 'حفظ العنصر في المكتبة', when: has, run: later('المكتبة') });
  registerTool({ id: 'library_download', label: 'تنزيل العنصر للمكتبة كملف', when: has, run: later('المكتبة') });
  window.ElanEditTools = { register: registerTool, list: function () { return TOOLS.slice(); } };

  /* ---------- commands from the editor ---------- */
  function archiveList() {
    var out = [], h0 = holder(false), e = (h0 && h0.edits && h0.edits.all) || {};
    Object.keys(e).forEach(function (id) { if (e[id].archived) out.push({ id: id, name: (entryById(id) || { name: id }).name }); });
    return out;
  }
  function snapshot() { return { revision: baseRevision, design: clone(work), device: device(), dirty: dirty, archive: archiveList(), page: { key: pageKeyNow(), label: pageLabel() }, selected: info(selectedId && entryById(selectedId)) }; }
  function need(id) { var e = id && entryById(id); if (!e) throw new Error('اختاري عنصر الأول.'); return e; }

  async function execute(action, p, meta) {
    p = p || {};
    switch (action) {
      case 'page.getState': return snapshot();
      case 'page.home': {
        var bc = document.querySelector('#view nav.bc a');
        if (bc) { homeClick = true; bc.click(); homeClick = false; } else location.reload();
        return null;
      }
      case 'page.markSaved': baseRevision = p.revision; undoStack = []; redoStack = []; baseJson = JSON.stringify(work); dirty = true; setDirty(false); if (hostApi) hostApi.revision(baseRevision); return snapshot();
      case 'element.select': select(need(p.elementId).id); return { selected: selectedId };
      case 'element.move': { var e1 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e1.id); t.dx = Math.round(+p.dx || 0); t.dy = Math.round(+p.dy || 0); }); return null; }
      case 'element.resize': { var e2 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e2.id); if (p.w) t.w = Math.round(p.w); if (p.h) t.h = Math.round(p.h); }); return null; }
      case 'element.format': { var e3 = need(p.elementId || selectedId), sty = p.style || {}; mutate(function (d) { var t = edit('all', e3.id); t.style = t.style || {}; Object.keys(sty).forEach(function (k) { if (sty[k] === null) delete t.style[k]; else t.style[k] = sty[k]; }); }); return null; }
      case 'element.setText': { var e4 = need(p.elementId || selectedId); mutate(function () { var t = edit('all', e4.id); t.text = t.text || {}; t.text[lang()] = String(p.text || '').slice(0, 600); }); return null; }
      case 'element.setMedia': { var e5 = need(p.elementId || selectedId); setMedia(e5.id, p.src || await mediaPrompt(e5.id)); return null; }
      case 'element.create': return createBlock(p.kind, p);
      case 'element.duplicate': {
        var e6 = need(p.elementId || selectedId), src = blocksHere().filter(function (b) { return b.id === e6.id; })[0];
        if (!src) throw new Error('التكرار متاح للبلوكات الإضافية بس.');
        var copy = clone(src); copy.id = 'x-' + rid();
        var r0 = e6.el.getBoundingClientRect();
        if (onHome()) {
          var order = fullOrder(); order.splice(order.indexOf(src.id) + 1, 0, copy.id);
          mutate(function (d) { d.blocks.push(copy); d.order = order; var from = d.edits && ((d.edits.all || {})[src.id]); if (from) d.edits.all[copy.id] = JSON.parse(JSON.stringify(from)); });
        } else {
          mutate(function () { var h = holder(true); h.blocks.push(copy); var from = h.edits && ((h.edits.all || {})[src.id]); if (from) h.edits.all[copy.id] = JSON.parse(JSON.stringify(from)); });
        }
        select(copy.id); placeAt(copy.id, { x: r0.left + 20, y: r0.top + 20 }); return { elementId: copy.id };
      }
      case 'tool.run': {
        var tool = TOOLS.filter(function (x) { return x.id === p.id; })[0];
        if (!tool) throw new Error('أداة غير معروفة');
        var ei = p.elementId ? entryById(p.elementId) : null, inf = info(ei);
        if (tool.when && !tool.when(inf)) throw new Error('الأداة دي مش متاحة للعنصر ده.');
        var out = await tool.run({ id: p.elementId || null, info: inf, at: p.at || null });
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
      case 'archive.restore': mutate(function () { var h = holder(false); if (h && h.edits) Object.keys(h.edits).forEach(function (dev) { if (h.edits[dev][p.elementId]) delete h.edits[dev][p.elementId].archived; }); }); return snapshot();
      case 'history.undo': return { ok: undo() };
      case 'history.redo': return { ok: redo() };
      case 'ui.openFormatPanel': if (p.elementId) select(need(p.elementId).id); if (!selectedId) throw new Error('اضغطي على عنصر في الصفحة الأول.'); return null;
      case 'ui.openMediaPanel': { var id7 = p.elementId || selectedId; if (!id7) throw new Error('اختاري بانر أو صورة الأول.'); setMedia(id7, await mediaPrompt(id7)); return null; }
      case 'ui.openCreatePanel':
        if (p.kind === 'banner' || p.kind === 'text_block' || p.kind === 'text') return createBlock(p.kind === 'text' ? 'text_block' : p.kind, { at: p.at });
        if (p.kind === 'image') { var src8 = await mediaPrompt(); return createBlock('image', { src: src8, at: p.at }); }
        throw new Error('إنشاء ' + p.kind + ' بيتربط بسابابيس في المرحلة الجاية. المتاح دلوقتي: بانر ونص وصورة.');
      case 'library.open': throw new Error('المكتبة بتتربط بسابابيس في المرحلة الجاية.');
      case 'page.save': throw new Error('الحفظ بيتم من الإديتور نفسه بعد التحقق من الإدارة.');
      default: throw new Error('أمر غير مدعوم');
    }
  }

  async function loadBase() {
    var r = await fetch('/api/editor?action=state', { credentials: 'same-origin', cache: 'no-store' });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error('state');
    baseRevision = j.revision === null || j.revision === undefined ? 'initial' : j.revision;
    work = ED.normalize(j.design || { version: ED.VERSION }, { strict: false }).design;
    undoStack = []; redoStack = []; dirty = false; baseJson = JSON.stringify(work);
    repaint(); lastPage = null; setTimeout(announcePage, 0);
    return { revision: baseRevision, design: clone(work) };
  }

  hostApi = Bridge.install({
    allowedEditorOrigins: [location.origin],
    authorize: async function () {
      try { var r = await fetch('/api/editor-session', { credentials: 'same-origin', cache: 'no-store' }); return r.ok; } catch (_) { return false; }
    },
    getState: async function () { if (!work) await loadBase(); return snapshot(); },
    execute: execute
  });
  work = null;
  window.ElanEditMode = { state: snapshot, execute: function (a, p) { return execute(a, p || {}, {}); }, _debug: function () { return work; } };
})();
