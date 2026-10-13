/* Élan Scents — visual edit mode (admin only, runs only inside the Élan Editor window).
   Everything here happens in this tab's memory. Nothing reaches customers or GitHub until the editor
   asks for the design (page.getState) and saves it through the server, which checks the admin again. */
(function () {
  'use strict';
  var layer = window.ElanDesignLayer, ED = window.ElanDesign, Bridge = window.ElanHostBridge;
  if (!layer || !ED || !Bridge || window.parent === window) return;

  var work = null, baseRevision = null, hostApi = null, selectedId = null, dirty = false;
  var undoStack = [], redoStack = [], editing = null, gesture = null, pendingMedia = null;
  var SECTIONS_NAMES = { section: 1 };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'ar'; }
  function device() { return ED.deviceOf(window.innerWidth); }
  function rid() { var a = new Uint8Array(5); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }

  /* ---------- working design ---------- */
  function emptyDesign() { return ED.normalize({ version: ED.VERSION }).design; }
  function setDirty(v) { dirty = !!v; if (hostApi) hostApi.dirty(dirty); }
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
    setDirty(true);
    repaint();
  }
  function repaint() { layer.setDesign(work); reselect(); }

  function undo() { if (!undoStack.length) return false; redoStack.push(JSON.stringify(work)); work = JSON.parse(undoStack.pop()); setDirty(true); repaint(); return true; }
  function redo() { if (!redoStack.length) return false; undoStack.push(JSON.stringify(work)); work = JSON.parse(redoStack.pop()); setDirty(true); repaint(); return true; }

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
    '.eo-box{position:fixed;border:2px solid #c8962a;background:rgba(200,150,42,.08);display:none}' +
    '.eo-tag{position:absolute;top:-24px;right:-2px;background:#c8962a;color:#fff;font-size:11px;padding:2px 7px;border-radius:5px 5px 0 0;white-space:nowrap}' +
    '.eo-h{position:absolute;width:12px;height:12px;background:#fff;border:2px solid #c8962a;border-radius:3px;pointer-events:auto;touch-action:none}' +
    '.eo-bar{position:fixed;top:8px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 16px);display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:7px 9px;background:#fffaf0;border:1px solid #c2a66a;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto;font-size:12px;color:#29251c}' +
    '.eo-bar button,.eo-bar select,.eo-bar input[type=number]{font:inherit;padding:4px 8px;border:1px solid #c2a66a;border-radius:6px;background:#fff;color:#29251c;cursor:pointer}' +
    '.eo-bar input[type=color]{width:30px;height:26px;padding:0;border:1px solid #c2a66a;border-radius:6px;background:#fff}' +
    '.eo-bar label{display:flex;gap:4px;align-items:center}.eo-bar input[type=number]{width:56px}' +
    '.eo-msg{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);background:#29251c;color:#fff;padding:8px 14px;border-radius:9px;font-size:13px;display:none;max-width:90vw;pointer-events:none}' +
    '.eo-dlg{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);pointer-events:auto}' +
    '.eo-dlg>div{background:#fffaf0;border:1px solid #c2a66a;border-radius:12px;padding:16px;width:min(420px,92vw);font-size:13px}' +
    '.eo-dlg input[type=text]{width:100%;padding:7px;border:1px solid #c2a66a;border-radius:7px;direction:ltr;margin:8px 0}' +
    '.eo-dlg button{font:inherit;padding:6px 12px;border:1px solid #c2a66a;border-radius:7px;background:#fff;cursor:pointer;margin-inline-end:6px}' +
    '[contenteditable]{outline:2px dashed #c8962a;outline-offset:2px}' +
    '</style><div class="eo-box"><span class="eo-tag"></span></div><div class="eo-bar"></div><div class="eo-msg"></div>' +
    '<div class="eo-dlg"><div><b class="eo-dt"></b><input type="text" class="eo-di" dir="ltr"><p class="eo-dh" style="margin:0 0 8px;color:#7a6a52"></p><button class="eo-ok">تأكيد</button><button class="eo-no">إلغاء</button></div></div>';
  document.body.appendChild(root);

  var box = root.querySelector('.eo-box'), tag = root.querySelector('.eo-tag'), bar = root.querySelector('.eo-bar'), msgEl = root.querySelector('.eo-msg'), dlg = root.querySelector('.eo-dlg');
  ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(function (h) {
    var d = document.createElement('i'); d.className = 'eo-h'; d.setAttribute('data-h', h);
    var cur = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }[h];
    d.style.cursor = cur + '-resize';
    d.style.top = h.indexOf('n') !== -1 ? '-7px' : h.indexOf('s') !== -1 ? 'calc(100% - 5px)' : 'calc(50% - 6px)';
    d.style.left = h.indexOf('w') !== -1 ? '-7px' : h.indexOf('e') !== -1 ? 'calc(100% - 5px)' : 'calc(50% - 6px)';
    box.appendChild(d);
  });

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
    if (!e || (e.el.style.display === 'none')) { box.style.display = 'none'; bar.style.display = 'none'; return; }
    var r = e.el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    tag.textContent = e.name;
  }
  function reselect() {
    if (selectedId && !entryById(selectedId)) selectedId = null;
    placeBox(); buildBar();
    if (hostApi) { var e = selectedId && entryById(selectedId); hostApi.selection(e ? { id: e.id, name: e.name, kind: e.kind } : null); }
  }
  function select(id) { selectedId = id; reselect(); }

  /* ---------- format bar ---------- */
  function cur(id) { return ED.editFor(work, device(), id) || {}; }
  function rgbToHex(c) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
  }
  function setStyle(id, key, val) {
    mutate(function (d) {
      var e = edit('all', id); e.style = e.style || {};
      if (val === null) delete e.style[key]; else e.style[key] = val;
    });
  }
  function btn(label, title, fn) { var b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; return b; }
  function lab(text, node) { var l = document.createElement('label'); l.appendChild(document.createTextNode(text)); l.appendChild(node); return l; }

  function buildBar() {
    bar.textContent = '';
    var e = selectedId && entryById(selectedId);
    if (!e) { bar.style.display = 'none'; return; }
    var cs = getComputedStyle(e.el), st = cur(e.id).style || {};
    var color = document.createElement('input'); color.type = 'color'; color.value = st.color || rgbToHex(cs.color);
    color.onchange = function () { setStyle(e.id, 'color', color.value); };
    var bg = document.createElement('input'); bg.type = 'color'; bg.value = st.background || rgbToHex(cs.backgroundColor);
    bg.onchange = function () { setStyle(e.id, 'background', bg.value); };
    var fs = document.createElement('input'); fs.type = 'number'; fs.min = 8; fs.max = 120; fs.value = st.fontSize || Math.round(parseFloat(cs.fontSize) || 16);
    fs.onchange = function () { setStyle(e.id, 'fontSize', Math.max(8, Math.min(120, Math.round(+fs.value || 16)))); };
    var wt = document.createElement('select');
    [[400, 'عادي'], [500, 'متوسط'], [600, 'سميك'], [700, 'عريض']].forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; wt.appendChild(op); });
    wt.value = st.weight || (parseInt(cs.fontWeight, 10) >= 700 ? 700 : parseInt(cs.fontWeight, 10) >= 600 ? 600 : parseInt(cs.fontWeight, 10) >= 500 ? 500 : 400);
    wt.onchange = function () { setStyle(e.id, 'weight', +wt.value); };
    var rad = document.createElement('input'); rad.type = 'number'; rad.min = 0; rad.max = 80; rad.value = st.radius !== undefined ? st.radius : Math.round(parseFloat(cs.borderTopLeftRadius) || 0);
    rad.onchange = function () { setStyle(e.id, 'radius', Math.max(0, Math.min(80, Math.round(+rad.value || 0)))); };
    var op = document.createElement('input'); op.type = 'number'; op.min = 10; op.max = 100; op.step = 10; op.value = Math.round((st.opacity !== undefined ? st.opacity : 1) * 100);
    op.onchange = function () { setStyle(e.id, 'opacity', Math.max(10, Math.min(100, +op.value || 100)) / 100); };

    bar.appendChild(lab('لون النص', color)); bar.appendChild(lab('الخلفية', bg)); bar.appendChild(lab('الحجم', fs));
    bar.appendChild(lab('السُّمك', wt)); bar.appendChild(lab('الزوايا', rad)); bar.appendChild(lab('الشفافية %', op));
    [['start', '⇤', 'محاذاة للبداية'], ['center', '↔', 'منتصف'], ['end', '⇥', 'محاذاة للنهاية']].forEach(function (a) { bar.appendChild(btn(a[1], a[2], function () { setStyle(e.id, 'align', a[0]); })); });
    if (/^(sec:[a-z]+|x-.+)$/.test(e.id)) {
      bar.appendChild(btn('▲', 'قدّم في الترتيب', function () { reorder(e.id, -1); }));
      bar.appendChild(btn('▼', 'أخّر في الترتيب', function () { reorder(e.id, 1); }));
    }
    bar.appendChild(btn('إخفاء على هذا الجهاز', 'إخفاء على ' + device(), function () { mutate(function () { edit(device(), e.id).hidden = true; }); selectedId = null; reselect(); }));
    bar.appendChild(btn('أرشفة', 'أرشفة العنصر', function () { archive(e.id); }));
    bar.appendChild(btn('إعادة ضبط', 'إلغاء كل تعديلات العنصر', function () { resetElement(e.id); }));
    var dv = document.createElement('span'); dv.textContent = 'الجهاز: ' + ({ desktop: 'لاب', tablet: 'تابلت', mobile: 'موبايل' })[device()]; dv.style.color = '#7a6a52'; bar.appendChild(dv);
    bar.style.display = 'flex';
  }

  function reorder(id, delta) {
    var key = /^sec:/.test(id) ? id.slice(4) : id, seq = fullOrder(), i = seq.indexOf(key), j = i + delta;
    if (i < 0 || j < 0 || j >= seq.length) return;
    mutate(function (d) { seq.splice(i, 1); seq.splice(j, 0, key); d.order = seq; });
  }
  function resetElement(id) { mutate(function (d) { if (d.edits) Object.keys(d.edits).forEach(function (dev) { delete d.edits[dev][id]; }); }); }
  function archive(id) { mutate(function () { edit('all', id).archived = true; }); selectedId = null; reselect(); say('اتحط في الأرشيف. تقدر ترجّعه بأمر الاستعادة.'); }

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
    else { e = pick(ev.clientX, ev.clientY); if (e) select(e.id); else { select(null); return; } }
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
  ['click', 'auxclick', 'submit', 'contextmenu', 'dragstart'].forEach(function (t) {
    window.addEventListener(t, function (ev) { if (inUi(ev.target)) return; if (editing && editing.node.contains(ev.target)) return; ev.preventDefault(); ev.stopPropagation(); }, true);
  });

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
    else if (selectedId && ev.key.indexOf('Arrow') === 0) {
      ev.preventDefault();
      var step = ev.shiftKey ? 10 : 1, id = selectedId, b = base(id);
      var dx = b.dx + (ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0);
      var dy = b.dy + (ev.key === 'ArrowDown' ? step : ev.key === 'ArrowUp' ? -step : 0);
      mutate(function () { var e = edit(device(), id); if (dx) e.dx = dx; else delete e.dx; if (dy) e.dy = dy; else delete e.dy; });
    }
  }, true);
  window.addEventListener('scroll', placeBox, true);
  window.addEventListener('resize', function () { placeBox(); buildBar(); });
  try { new MutationObserver(function () { requestAnimationFrame(reselect); }).observe(document.getElementById('main'), { childList: true }); } catch (_) { /* optional */ }

  /* ---------- creating blocks ---------- */
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
    var order = insertAfterSelected(id);
    mutate(function (d) { d.blocks.push(b); d.order = order; });
    select(id);
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
    if (!b || (b.type !== 'image' && b.type !== 'banner')) throw new Error('الصور بتتغيّر في بلوك صورة أو بانر بس.');
    var probe = clone(b); if (b.type === 'image') probe.src = src; else probe.image = src;
    if (!validBlock(probe)) throw new Error('رابط الصورة مش مسموح.');
    mutate(function (d) { var t = d.blocks.filter(function (x) { return x.id === id; })[0]; if (t.type === 'image') t.src = src; else t.image = src; });
  }

  /* ---------- commands from the editor ---------- */
  function archiveList() {
    var out = [], e = (work.edits && work.edits.all) || {};
    Object.keys(e).forEach(function (id) { if (e[id].archived) out.push({ id: id, name: (entryById(id) || { name: id }).name }); });
    return out;
  }
  function snapshot() { return { revision: baseRevision, design: clone(work), device: device(), dirty: dirty, archive: archiveList() }; }
  function need(id) { var e = id && entryById(id); if (!e) throw new Error('اختاري عنصر الأول.'); return e; }

  async function execute(action, p, meta) {
    p = p || {};
    switch (action) {
      case 'page.getState': return snapshot();
      case 'page.markSaved': baseRevision = p.revision; undoStack = []; redoStack = []; setDirty(false); if (hostApi) hostApi.revision(baseRevision); return snapshot();
      case 'element.select': select(need(p.elementId).id); return { selected: selectedId };
      case 'element.move': { var e1 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e1.id); t.dx = Math.round(+p.dx || 0); t.dy = Math.round(+p.dy || 0); }); return null; }
      case 'element.resize': { var e2 = need(p.elementId || selectedId); mutate(function () { var t = edit(device(), e2.id); if (p.w) t.w = Math.round(p.w); if (p.h) t.h = Math.round(p.h); }); return null; }
      case 'element.format': { var e3 = need(p.elementId || selectedId); Object.keys(p.style || {}).forEach(function (k) { setStyle(e3.id, k, p.style[k]); }); return null; }
      case 'element.setText': { var e4 = need(p.elementId || selectedId); mutate(function () { var t = edit('all', e4.id); t.text = t.text || {}; t.text[lang()] = String(p.text || '').slice(0, 600); }); return null; }
      case 'element.setMedia': { var e5 = need(p.elementId || selectedId); setMedia(e5.id, p.src || await mediaPrompt(e5.id)); return null; }
      case 'element.create': return createBlock(p.kind, p);
      case 'element.duplicate': {
        var e6 = need(p.elementId || selectedId), src = work.blocks.filter(function (b) { return b.id === e6.id; })[0];
        if (!src) throw new Error('التكرار متاح للبلوكات الإضافية بس.');
        var copy = clone(src); copy.id = 'x-' + rid(); var order = fullOrder(); order.splice(order.indexOf(src.id) + 1, 0, copy.id);
        mutate(function (d) { d.blocks.push(copy); d.order = order; }); select(copy.id); return { elementId: copy.id };
      }
      case 'element.archive': archive(need(p.elementId || selectedId).id); return null;
      case 'archive.restore': mutate(function (d) { if (d.edits) Object.keys(d.edits).forEach(function (dev) { if (d.edits[dev][p.elementId]) delete d.edits[dev][p.elementId].archived; }); }); return snapshot();
      case 'history.undo': return { ok: undo() };
      case 'history.redo': return { ok: redo() };
      case 'ui.openFormatPanel': if (p.elementId) select(need(p.elementId).id); if (!selectedId) throw new Error('اضغطي على عنصر في الصفحة الأول.'); buildBar(); return null;
      case 'ui.openMediaPanel': { var id7 = p.elementId || selectedId; if (!id7) throw new Error('اختاري بانر أو صورة الأول.'); setMedia(id7, await mediaPrompt(id7)); return null; }
      case 'ui.openCreatePanel':
        if (p.kind === 'banner' || p.kind === 'text_block') return createBlock(p.kind, {});
        if (p.kind === 'image') { var src8 = await mediaPrompt(); return createBlock('image', { src: src8 }); }
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
    undoStack = []; redoStack = []; dirty = false;
    repaint();
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
