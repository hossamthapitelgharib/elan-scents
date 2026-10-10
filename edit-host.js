/* Élan Scents — edit mode (runs only inside Élan Editor, same origin).
   Mouse editing on the real page: click to select, drag the handle to reorder, double-click text to type.
   Everything is a local draft until Save; Save is confirmed only after the server says the revision is live. */
(function () {
  'use strict';
  var ED = window.ElanDesign, EM = window.ElanEditModel, Bridge = window.ElanHostBridge, Layer = window.ElanDesignLayer;
  if (!ED || !EM || !Bridge || !Layer) { console.error('edit mode: missing pieces'); return; }

  var model = null, selected = null, bridge = null, serverRevision = null, authAt = 0, saving = false;
  var NAMES = { brands: 'الماركات', offers: 'العروض', new: 'وصل حديثًا', cats: 'الأقسام', master: 'الأعلى مبيعًا', occ: 'المناسبات', notes: 'النوتات', soon: 'قريبًا', stores: 'المتاجر' };
  var NOT_YET = 'ده لسه مش متوصل: محتاج ربط المكتبة وسابابيس في خطوة لاحقة.';

  // ---------- server ----------
  function token() { try { return window.parent.elanEditorSession && window.parent.elanEditorSession.token(); } catch (e) { return null; } }
  async function api(method, body, query) {
    var t = token(); if (!t) throw Error('انتهت جلسة الإديتور، سجلي الدخول تاني.');
    var r = await fetch('/api/editor' + (query || ''), { method: method, cache: 'no-store', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var data = {}; try { data = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, data: data };
  }
  async function loadPublished() {
    var r = await api('GET', null, '?action=state');
    if (r.status !== 200 || !r.data.ok) throw Error(r.status === 403 ? 'الحساب ده مش أدمن.' : 'تعذر قراءة آخر إصدار منشور.');
    serverRevision = r.data.revision; model = EM.create(r.data.design); authAt = Date.now();
    return r.data;
  }

  // ---------- drawing ----------
  var STYLE = [
    '[data-elan-edit]{outline:1px dashed rgba(200,150,42,.55);outline-offset:-1px;cursor:pointer;position:relative}',
    '[data-elan-edit].elan-sel{outline:2px solid #c8962a;box-shadow:0 0 0 4px rgba(200,150,42,.18)}',
    '.elan-handle{position:absolute;top:4px;inset-inline-start:4px;z-index:9999;background:#c8962a;color:#fff;border-radius:8px;padding:3px 10px;font:600 12px sans-serif;cursor:grab;touch-action:none;user-select:none}',
    '.elan-drop{position:fixed;left:0;right:0;height:3px;background:#c8962a;z-index:10000;pointer-events:none}',
    '.elan-panel{position:fixed;top:10px;inset-inline-end:10px;z-index:10001;background:#fff;border:1px solid #e5dbc6;border-radius:12px;padding:12px;width:230px;font:14px sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.18);direction:rtl}',
    '.elan-panel b{display:block;margin-bottom:8px}.elan-panel label{display:block;margin:6px 0 2px;font-size:12px}',
    '.elan-panel select,.elan-panel button{width:100%;padding:6px;margin-bottom:4px;font:inherit}',
    '[contenteditable="true"]{outline:2px solid #c8962a!important;background:#fffdf3;cursor:text}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st);

  function main() { return document.getElementById('main'); }
  function items() {
    var m = main(); if (!m) return [];
    return Array.prototype.slice.call(m.children).filter(function (c) { return idOf(c); });
  }
  function idOf(n) {
    if (!n || !n.getAttribute) return null;
    var cid = n.getAttribute('data-elan-id'); if (cid) return cid;
    return (n.tagName === 'SECTION' && n.id && ED.BUILTIN.indexOf(n.id) !== -1) ? n.id : null;
  }
  function nodeOf(id) { return items().filter(function (n) { return idOf(n) === id; })[0] || null; }
  function lang() { return document.documentElement.lang === 'en' ? 'en' : 'ar'; }

  function decorate() {
    items().forEach(function (n) {
      n.setAttribute('data-elan-edit', '1');
      var id = idOf(n); n.classList.toggle('elan-sel', id === selected);
      var old = n.querySelector(':scope > .elan-handle');
      if (old && (id !== selected)) old.remove();
      if (id === selected && !old) {
        var h = document.createElement('div'); h.className = 'elan-handle'; h.textContent = '⠿ اسحب · ' + (NAMES[id] || 'نص');
        h.addEventListener('pointerdown', function (e) { startDrag(e, id); });
        n.insertBefore(h, n.firstChild);
      }
    });
  }
  var redrawing = false;
  function redraw() { redrawing = true; Layer.set(model.design(), { editing: true }); redrawing = false; decorate(); notifyDirty(); }
  function ours(n) { return n.nodeType === 1 && (n.classList.contains('elan-handle') || n.classList.contains('elan-drop') || n.classList.contains('elan-panel')); }
  new MutationObserver(function (list) {
    if (redrawing) return;
    var foreign = list.some(function (m) { return Array.prototype.concat.call([], Array.prototype.slice.call(m.addedNodes), Array.prototype.slice.call(m.removedNodes)).some(function (n) { return !ours(n); }); });
    if (foreign) decorate();
  }).observe(document.documentElement, { childList: true, subtree: true });

  function notifyDirty() { if (bridge) bridge.dirty(model.dirty()); }
  function select(id) {
    selected = id; decorate();
    if (bridge) bridge.selection(id ? { id: id, name: NAMES[id] || id, type: model.kind(id) } : null);
  }

  // ---------- mouse: select, drag, type ----------
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.elan-panel,.elan-handle')) return;
    var a = e.target.closest && e.target.closest('a,button,[onclick]');
    var n = e.target.closest && e.target.closest('[data-elan-edit]');
    if (n) { e.preventDefault(); e.stopPropagation(); select(idOf(n)); }
    else if (a) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  function startDrag(e, id) {
    e.preventDefault(); e.stopPropagation();
    var line = document.createElement('div'); line.className = 'elan-drop'; document.body.appendChild(line);
    var target = 0;
    function others() { return items().filter(function (n) { return idOf(n) !== id; }); }
    function move(ev) {
      var list = others(); target = list.length; var y = ev.clientY, ly = null;
      for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (y < r.top + r.height / 2) { target = i; ly = r.top; break; } }
      if (ly === null && list.length) ly = list[list.length - 1].getBoundingClientRect().bottom;
      line.style.top = (ly || 0) + 'px';
    }
    function up() {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); line.remove();
      var seq = model.sequence().filter(function (x) { return x !== id; }), domIds = others().map(idOf);
      var before = domIds[target]; var idx = before ? seq.indexOf(before) : seq.length;
      if (model.moveTo(id, idx)) redraw();
    }
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); move(e);
  }

  document.addEventListener('dblclick', function (e) {
    var n = e.target.closest && e.target.closest('[data-elan-edit]'); if (!n) return;
    var id = idOf(n), kind = model.kind(id), field = null;
    if (kind === 'text') field = n.querySelector('p');
    else if (kind === 'banner') field = n.querySelector('h3');
    else if (kind === 'section') field = n.querySelector('h3');
    if (!field) return;
    e.preventDefault(); select(id);
    var original = field.textContent; field.contentEditable = 'true'; field.focus();
    var done = false;
    function finish(save) {
      if (done) return; done = true; field.removeAttribute('contenteditable');
      field.removeEventListener('blur', onBlur); field.removeEventListener('keydown', onKey);
      var text = field.textContent;
      try { if (save && text !== original) { model.setText(id, lang(), text); } } catch (err) { say(err.message); }
      redraw();
    }
    function onBlur() { finish(true); }
    function onKey(k) { if (k.key === 'Escape') { field.textContent = original; finish(false); } else if (k.key === 'Enter' && !k.shiftKey && kind !== 'text') { k.preventDefault(); finish(true); } }
    field.addEventListener('blur', onBlur); field.addEventListener('keydown', onKey);
  });
  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.isContentEditable) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (model.undo()) redraw(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); if (model.redo()) redraw(); }
  });

  // ---------- format panel ----------
  var panel = null;
  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  function say(t) { try { var x = document.getElementById('toast'); if (x) { x.textContent = t; x.classList.add('show'); setTimeout(function () { x.classList.remove('show'); }, 2500); } } catch (e) { /* ignore */ } }
  function openFormat(id) {
    closePanel(); if (!id || !model.kind(id)) throw Error('حددي عنصر الأول بالضغط عليه');
    var kind = model.kind(id); panel = document.createElement('div'); panel.className = 'elan-panel';
    function mk(tag, text, props) { var x = document.createElement(tag); if (text) x.textContent = text; Object.keys(props || {}).forEach(function (k) { x[k] = props[k]; }); return x; }
    panel.appendChild(mk('b', 'تنسيق: ' + (NAMES[id] || 'نص')));
    if (kind !== 'section') {
      var d = model.design(), b = (d.blocks || []).filter(function (x) { return x.id === id; })[0] || {}, sty = b.style || {};
      panel.appendChild(mk('label', 'الحجم'));
      var sz = mk('select'); [['sm', 'صغير'], ['md', 'متوسط'], ['lg', 'كبير'], ['xl', 'كبير جدًا']].forEach(function (o) { var op = mk('option', o[1], { value: o[0] }); sz.appendChild(op); }); sz.value = sty.size || 'md';
      sz.onchange = function () { try { model.format(id, { size: sz.value }); redraw(); } catch (e) { say(e.message); } };
      panel.appendChild(sz);
      panel.appendChild(mk('label', 'المحاذاة'));
      var al = mk('select'); [['start', 'بداية السطر'], ['center', 'وسط'], ['end', 'نهاية السطر']].forEach(function (o) { al.appendChild(mk('option', o[1], { value: o[0] })); }); al.value = sty.align || 'center';
      al.onchange = function () { try { model.format(id, { align: al.value }); redraw(); } catch (e) { say(e.message); } };
      panel.appendChild(al);
    } else {
      var hidden = !!(model.design().sections && model.design().sections[id] && model.design().sections[id].hidden);
      var tg = mk('button', hidden ? 'إظهار القسم للعملاء' : 'إخفاء القسم عن العملاء');
      tg.onclick = function () { (hidden ? model.restore(id) : model.archive(id)); redraw(); closePanel(); };
      panel.appendChild(tg);
    }
    var up = mk('button', '↑ تحريك لفوق'), dn = mk('button', '↓ تحريك لتحت'), cl = mk('button', 'إغلاق');
    up.onclick = function () { if (model.move(id, -1)) redraw(); }; dn.onclick = function () { if (model.move(id, 1)) redraw(); }; cl.onclick = closePanel;
    panel.appendChild(up); panel.appendChild(dn); panel.appendChild(cl); document.body.appendChild(panel);
  }

  // ---------- commands from the editor ----------
  function need(p) { var id = p.elementId || selected; if (!id || !model.kind(id)) throw Error('حددي عنصر الأول بالضغط عليه'); return id; }
  async function savePage(requestId) {
    if (saving) throw Error('الحفظ شغال بالفعل');
    saving = true;
    try {
      if (!model.dirty()) return { revision: serverRevision === null ? 'none' : serverRevision, published: true, unchanged: true };
      var norm = ED.normalize(model.design(), { strict: true });
      if (!norm.ok) throw Error('فيه تعديل مش مقبول: ' + norm.errors.slice(0, 2).join('، '));
      var r = await api('POST', { action: 'save', design: norm.design, expectedRevision: serverRevision, requestId: requestId }, '');
      if (r.status === 409) throw Error('التصميم اتعدل من مكان تاني. أعيدي فتح الصفحة، وتعديلاتك الحالية لسه عندك لحد ما تقفلي.');
      if (r.status !== 200 || !r.data.ok) throw Error('الحفظ ما نجحش (' + (r.data.error || r.status) + '). الموقع المنشور ما اتغيرش.');
      var rev = r.data.revision, branchNote = r.data.branch;
      for (var i = 0; i < 50; i++) {
        await new Promise(function (ok) { setTimeout(ok, 4000); });
        try { var s = await api('POST', { action: 'status', revision: rev }, ''); if (s.data && s.data.published) { serverRevision = rev; model.markSaved(norm.design); notifyDirty(); if (bridge) bridge.revision(rev); return { revision: rev, published: true }; } } catch (e) { /* server restarting: keep waiting */ }
      }
      serverRevision = rev; model.markSaved(norm.design); notifyDirty();
      throw Error('اتحفظ على فرع ' + branchNote + ' لكن الموقع المنشور لسه ما اتحدّثش. ما نعتبرهوش منشور.');
    } finally { saving = false; }
  }

  async function execute(action, p, ctx) {
    p = p || {};
    switch (action) {
      case 'page.getState': return { revision: serverRevision, design: model.design(), dirty: model.dirty(), selection: selected };
      case 'element.select': need(p); select(p.elementId); return { ok: true };
      case 'element.move': { var id = need(p), ch = typeof p.index === 'number' ? model.moveTo(id, p.index) : model.move(id, p.direction === 'up' || p.direction === -1 ? -1 : 1); if (ch) redraw(); return { moved: ch }; }
      case 'element.resize': { var rid = need(p); if (model.resize(rid, p.size || p.step || 'bigger')) redraw(); return { ok: true }; }
      case 'element.format': { var fid = need(p); if (model.format(fid, { size: p.size, align: p.align })) redraw(); return { ok: true }; }
      case 'element.setText': { var tid = need(p); if (model.setText(tid, p.lang || lang(), p.text)) redraw(); return { ok: true }; }
      case 'element.create': { if (p.kind && p.kind !== 'text_block' && p.kind !== 'text') throw Error(NOT_YET); var nid = model.createText(selected, p.text); redraw(); select(nid); return { elementId: nid }; }
      case 'element.duplicate': { var did = need(p), b = (model.design().blocks || []).filter(function (x) { return x.id === did; })[0]; if (!b || b.type !== 'text') throw Error('النسخ متاح لبلوكات النص بس'); var cid = model.createText(did, (b.text && (b.text.ar || b.text.en)) || ''); redraw(); select(cid); return { elementId: cid }; }
      case 'element.archive': { var aid = need(p); if (model.archive(aid)) redraw(); if (selected === aid && model.kind(aid) !== 'section') select(null); return { archived: true }; }
      case 'archive.restore': { if (model.restore(p.elementId)) redraw(); return { restored: true }; }
      case 'history.undo': if (model.undo()) redraw(); return { ok: true };
      case 'history.redo': if (model.redo()) redraw(); return { ok: true };
      case 'ui.openFormatPanel': openFormat(need(p)); return { ok: true };
      case 'ui.openCreatePanel': { if (p.kind !== 'text_block') throw Error(NOT_YET); var tn = model.createText(selected); redraw(); select(tn); return { elementId: tn }; }
      case 'element.setMedia': case 'library.open': case 'ui.openMediaPanel': throw Error(NOT_YET);
      case 'page.save': return savePage(ctx && ctx.requestId);
      default: throw Error('أمر غير مدعوم');
    }
  }

  // ---------- connect ----------
  async function authorize() {
    if (Date.now() - authAt < 15000) return true;
    var r = await api('GET', null, '?action=state'); if (r.status === 200 && r.data.ok) { authAt = Date.now(); return true; } return false;
  }
  bridge = Bridge.install({
    allowedEditorOrigins: [location.origin],
    authorize: authorize,
    getState: async function () { var d = await loadPublished(); redraw(); select(null); return { revision: d.revision === null ? 'none' : d.revision, design: d.design }; },
    execute: execute
  });
})();
