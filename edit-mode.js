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
    '.eo-mv{position:absolute;top:-24px;left:-2px;background:#29251c;color:#fff;font-size:11px;padding:2px 8px;border-radius:5px 5px 0 0;cursor:grab;pointer-events:auto;display:none;touch-action:none;user-select:none}' +
    '.eo-drop{position:fixed;left:0;right:0;height:3px;background:#c8962a;display:none;pointer-events:none}' +
    '[contenteditable]{outline:2px dashed #c8962a;outline-offset:2px}' +
    '</style><div class="eo-box"><span class="eo-tag"></span><span class="eo-mv">⠿ اسحب لإعادة الترتيب</span></div><div class="eo-drop"></div><div class="eo-bar"></div><div class="eo-msg"></div>' +
    '<div class="eo-dlg"><div><b class="eo-dt"></b><input type="text" class="eo-di" dir="ltr"><p class="eo-dh" style="margin:0 0 8px;color:#7a6a52"></p><button class="eo-ok">تأكيد</button><button class="eo-no">إلغاء</button></div></div>';
  document.body.appendChild(root);

  var mv = root.querySelector('.eo-mv'), drop = root.querySelector('.eo-drop'), box = root.querySelector('.eo-box'), tag = root.querySelector('.eo-tag'), bar = root.querySelector('.eo-bar'), msgEl = root.querySelector('.eo-msg'), dlg = root.querySelector('.eo-dlg');
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
    mv.style.display = (e.kind === 'section' || e.kind === 'block') ? 'block' : 'none';
    var inside = r.top < 30;
    tag.style.top = mv.style.top = inside ? '2px' : '-24px';
  }
  function info(e) {
    if (!e) return null;
    var node = layer.textTarget(e) || e.el, cs = getComputedStyle(node), st = cur(e.id).style || {};
    var blk = (work.blocks || []).filter(function (b) { return b.id === e.id; })[0];
    var type = blk ? ({ text: 'text_block', banner: 'banner', image: 'image' })[blk.type] : (e.kind === 'section' ? 'section' : e.kind === 'card' ? 'card' : 'text');
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
    placeBox(); buildBar();
    if (hostApi) { var e = selectedId && entryById(selectedId); hostApi.selection(info(e)); }
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

  /* truncated for size - CONTINUE */
})();
