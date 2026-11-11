/* Élan Editor — the creation panels (section, brand, store, perfume card, occasion, note), shown in the editor window.
   They are the panels of the original editor file, same markup, same sizes (the section panel is a 760-790px dialog, the name panels 380px),
   so they are drawn in this window and not inside the 390px phone frame where they used to be squeezed.
   - Filters, perfume results and size lists come from /api/editor-data (the real catalogue, admin only).
   - Brand / store / occasion / note: the name is matched to the existing record or creates it (no duplicates).
   - A section or perfume card is stored in editor_sections / editor_section_items first; then the block that references it is
     created INSIDE the platform page through the bridge's own `element.create`, so undo, save and publish stay unchanged.
   The menu tools carry ui "create" (edit-mode.js); the host menu calls window.elanLiveCreate(tool, at). Colours are white on purpose
   (the storefront is white; see tests/editor-white-surfaces.test.js), everything else is the original. */
(function (root) {
  'use strict';

  /* ---------- pure helpers (also exercised by tests/editor-panels.test.js) ---------- */
  function localCairo(iso) {
    if (!iso) return '';
    var parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).forEach(function (p) { if (p.type !== 'literal') parts[p.type] = p.value; });
    return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute;
  }
  /* "2026-10-20T09:00" typed as Cairo time -> the UTC instant it means (handles the daylight-saving offset). */
  function cairoUTC(text) {
    if (!text) return null;
    var wanted = Date.parse(text + 'Z'), guess = wanted;
    if (!isFinite(wanted)) throw new Error('موعد غير صحيح');
    for (var n = 0; n < 4; n++) {
      var shown = Date.parse(localCairo(new Date(guess).toISOString()) + 'Z');
      guess += wanted - shown;
    }
    return new Date(guess).toISOString();
  }

  /* [control, label, options list, provider key, saved filter key] */
  var FILTERS = [
    ['brand', 'البراند', 'brands', 'brand_id', 'brand'],
    ['store', 'المتجر', 'stores', 'store_id', 'store'],
    ['category', 'الفئة', 'categories', 'category_id', 'cat'],
    ['occasion', 'المناسبة', 'occasions', 'occasion_id', 'occ'],
    ['note', 'النوتة العطرية', 'notes', 'note_id', 'note'],
    ['size', 'الحجم', 'sizes', 'size_ml', 'size_ml']
  ];

  /* values: chosen option value per control plus min/max; labels: the shown name of each chosen option.
     provider = what the catalogue lookup receives (record ids); saved = what the storefront section stores (names). */
  function buildFilters(values, labels) {
    var provider = {}, saved = {};
    FILTERS.forEach(function (f) {
      var value = values[f[0]];
      if (value === undefined || value === null || value === '') return;
      if (f[0] === 'size') { var ml = Number(value); provider.size_ml = ml; saved.size_ml = ml; return; }
      provider[f[3]] = String(value);
      saved[f[4]] = String((labels && labels[f[0]]) || '');
    });
    ['min', 'max'].forEach(function (key) {
      var value = values[key];
      if (value === undefined || value === null || value === '') return;
      var number = Number(value);
      if (!isFinite(number) || number < 0) throw new Error('راجع حدود السعر.');
      provider['price_' + key] = number; saved[key] = number;
    });
    if (provider.price_min !== undefined && provider.price_max !== undefined && provider.price_min > provider.price_max) throw new Error('راجع حدود السعر.');
    return { provider: provider, saved: saved };
  }

  /* t: { enabled, mode: 'dates' | 'duration', start, end, count, unit: 'hours' | 'days' } -> the server's timer object. */
  function timerPayload(t) {
    if (!t || !t.enabled) return { mode: 'none' };
    if (t.mode === 'duration') {
      var count = Number(t.count);
      if (!isFinite(count) || count < 1 || Math.floor(count) !== count) throw new Error('حدد مدة أكبر من صفر.');
      var hours = t.unit === 'days' ? count * 24 : count;
      if (hours > 2147483647) throw new Error('المدة طويلة أكثر من اللازم.');
      return { mode: 'duration', duration_hours: hours };
    }
    var starts = cairoUTC(t.start), ends = cairoUTC(t.end);
    if (!starts || !ends || Date.parse(ends) <= Date.parse(starts)) throw new Error('حدد مواعيد صحيحة.');
    return { mode: 'window', starts_at: starts, ends_at: ends };
  }

  /* model: { name, purpose, mode: 'manual' | 'automatic', filters: {provider, saved}, picks: [{productSizeId}], timer } */
  function sectionBody(model) {
    var manual = model.mode === 'manual';
    return {
      name: model.name,
      purpose: model.purpose,
      selection_mode: manual ? 'manual' : 'auto',
      filters: model.filters.saved,
      product_size_ids: manual ? model.picks.map(function (p) { return p.productSizeId; }) : [],
      timer: model.timer
    };
  }

  var KINDS = { section: 1, brand: 1, store: 1, perfume: 1, occasion: 1, note: 1 };
  var NAME_KINDS = {
    brand: { key: 'brand', title: 'إنشاء كارت براند', dim: 'أبعاد كارت البراند', label: 'اسم البراند', required: 'اكتب اسم البراند', done: 'تم إنشاء كارت البراند.' },
    store: { key: 'store', title: 'إنشاء كارت متجر', dim: 'أبعاد كارت المتجر', label: 'اسم المتجر', required: 'اكتب اسم المتجر', done: 'تم إنشاء كارت المتجر.' },
    occasion: { key: 'occ', title: 'إنشاء كارت مناسبة', dim: 'أبعاد كارت المناسبة', label: 'اسم المناسبة', required: 'اكتب الاسم', done: 'تم إنشاء كارت المناسبة.' },
    note: { key: 'note', title: 'إنشاء كارت نوتة عطرية', dim: 'أبعاد كارت النوتة', label: 'اسم النوتة العطرية', required: 'اكتب الاسم', done: 'تم إنشاء كارت النوتة.' }
  };
  var EMPTY_PICKS = 'أضف عطرًا من القائمة أولًا، أو اختر فلاتر لها نتائج في الوضع التلقائي.';

  var helpers = { localCairo: localCairo, cairoUTC: cairoUTC, buildFilters: buildFilters, timerPayload: timerPayload, sectionBody: sectionBody, FILTERS: FILTERS };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;

  if (!root || !root.document) return;
  var doc = root.document;

  /* ---------- server calls ---------- */
  var ERRORS = {
    section_name_required: 'اكتب اسم السيكشن.',
    invalid_section_timer: 'مواعيد المؤقت غير صحيحة.',
    invalid_section_filter: 'أحد الفلاتر غير صالح.',
    invalid_perfume_filter: 'راجع قيم الفلاتر.',
    invalid_section_purpose: 'اكتب الغرض من السيكشن.',
    manual_section_items_required: 'اختر عطرًا واحدًا على الأقل.',
    section_item_not_available: 'أحد العطور المختارة لم يعد متاحًا.',
    catalog_name_required: 'اكتب اسمًا صحيحًا.',
    catalog_identity_conflict: 'هذا الاسم يتعارض مع سجل موجود.',
    data_provider_failed: 'تعذر قراءة بيانات الكتالوج.',
    unauthorized: 'انتهت الجلسة. أعد فتح المحرر.',
    forbidden: 'هذا الحساب غير مصرح له.'
  };
  function data(action, payload) {
    return root.fetch('/api/editor-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(Object.assign({ action: action }, payload || {})) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.ok) throw new Error(ERRORS[j.error] || 'تعذر الاتصال بالكتالوج.');
          return j;
        });
      });
  }
  function rid() { var a = new Uint8Array(5); root.crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }

  /* Create the central section first, then the block that references it, inside the platform page through the bridge. */
  function commit(kind, section, at, size) {
    var live = root.elanLiveEditorBridge;
    if (!live || typeof live.request !== 'function' || !live.getState().connected) return Promise.reject(new Error('وضع التحرير غير جاهز.'));
    var elementId = 'x-' + rid();
    section.element_id = elementId;
    return data('section.create', { section: section }).then(function (j) {
      if (!j.ref || j.ref !== elementId) throw new Error('لم يتم تأكيد إنشاء القسم المركزي.');
      return live.request('element.create', { kind: 'smart', ref: j.ref, semanticKind: kind, at: at || null, size: size || undefined });
    });
  }

  /* ---------- panel styling: the original editor's section panel rules, in the order the original loads them ---------- */
  var STYLE = [
    '.sectionPanelClean{width:760px;max-width:95vw;background:#fffdf8;color:#28251e;padding:22px}',
    '.sectionPanelClean h3{margin:0 0 18px;color:#866329}',
    '.sectionPanelClean .sectionGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.sectionPanelClean .filterGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
    '.sectionPanelClean label{margin:0;display:flex;flex-direction:column;gap:6px;font-size:13px}',
    '.sectionPanelClean input,.sectionPanelClean select{width:100%;min-width:0;background:white;min-height:38px}',
    '.sectionPanelClean fieldset{margin:15px 0;padding:14px;border:1px solid #e0d0af;border-radius:12px}',
    '.sectionPanelClean legend{font-weight:bold;color:#8c6830;padding:0 7px}',
    '.sectionPanelClean .selectionList{display:grid;gap:7px;margin-top:12px}',
    '.sectionPanelClean .chosenPerfume{display:flex;align-items:center;gap:10px;border:1px solid #e4d7be;background:white;border-radius:8px;padding:9px;font-size:13px}',
    '.sectionPanelClean .chosenPerfume span{flex:1}',
    '.sectionPanelClean .notice{font-size:12px;color:#716344;line-height:1.7;padding:9px 0;background:none}',
    '.sectionPanelClean .actions{display:flex;gap:10px;margin-top:16px}.sectionPanelClean .actions button{flex:1}',
    '.sectionPanelClean .primary{background:#28241e;color:#efdeb8}',
    '.sectionPanelClean .toggle{display:flex;flex-direction:row;align-items:center;gap:8px}.sectionPanelClean .toggle input{width:auto;min-height:0}',
    '@media(max-width:560px){.sectionPanelClean .filterGrid{grid-template-columns:1fr 1fr}.sectionPanelClean{padding:14px}.sectionPanelClean .sectionGrid{grid-template-columns:1fr}}',
    '.sectionPanelClean [hidden]{display:none!important}',
    '.sectionPanelClean{width:1000px!important}.sectionPanelClean .manualLayout{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:14px}.sectionPanelClean .manualResults{border:1px solid #d7c29c;border-radius:12px;padding:12px;background:#fffaf0;max-height:420px;overflow:auto}.sectionPanelClean .manualResults h4{margin-top:0}.sectionPanelClean .manualResults label{display:flex;flex-direction:row;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid #e7ddc8}.sectionPanelClean .manualResults input{width:auto;min-height:0}.sectionPanelClean .modeHelp{font-size:12px;line-height:1.8;color:#756443;margin:8px 0}@media(max-width:700px){.sectionPanelClean .manualLayout{grid-template-columns:1fr}}',
    '.sectionPanelClean{width:min(790px,94vw)!important;max-height:92dvh!important;padding:20px!important;background:#fffdf9;color:#302b23;border:1px solid #c8ae79;border-radius:18px;box-shadow:0 24px 80px #0003;overflow:auto}',
    '.sectionPanelClean::backdrop{background:rgba(21,19,15,.45)}',
    '.sectionPanelClean h3{font-size:19px;font-weight:700;line-height:1.4;color:#86642e;margin:0 0 15px!important;padding-bottom:12px;border-bottom:1px solid #e9dec8}',
    '.sectionPanelClean label{font-size:12px;line-height:1.5;font-weight:500;gap:5px;min-width:0}',
    '.sectionPanelClean input,.sectionPanelClean select{width:100%;min-width:0;font:12px Tahoma,Arial;min-height:35px!important;height:35px;padding:7px 9px;border:1px solid #dccfb6;border-radius:7px;background:#fff;box-shadow:none;color:#302b23}',
    '.sectionPanelClean input:focus,.sectionPanelClean select:focus{outline:2px solid #cfb57966;outline-offset:1px;border-color:#ae8d4e}',
    '.sectionPanelClean input:disabled,.sectionPanelClean select:disabled{background:#f1eee7;color:#938977}',
    '.sectionPanelClean button{font:12px Tahoma,Arial;padding:8px 12px;border-radius:8px;min-height:34px}',
    '.sectionPanelClean fieldset{margin:12px 0;padding:12px;border:1px solid #e2d6bd;border-radius:12px;background:#faf7f0;min-width:0}',
    '.sectionPanelClean legend{font-size:13px;font-weight:700;color:#86642e;padding:0 7px}',
    '.sectionPanelClean .sectionGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.sectionPanelClean .filterGrid{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px}',
    '.sectionPanelClean .manualLayout{grid-template-columns:minmax(0,1fr) 225px;gap:12px;align-items:start}',
    '.sectionPanelClean .manualResults{padding:10px;max-height:255px!important;min-height:110px;border:1px solid #ddcba7;background:#fffdf8;border-radius:10px;overflow:auto}',
    '.sectionPanelClean .manualResults h4{font-size:13px;color:#76582a;margin:0 0 9px;padding-bottom:7px;border-bottom:1px solid #ece2cf}',
    '.sectionPanelClean .manualResults label{font-size:12px;padding:7px 0;gap:6px}',
    '.sectionPanelClean .manualResults p{font-size:12px;line-height:1.8;color:#827459;margin:6px 0}',
    '.sectionPanelClean .manualResults input[type=checkbox],.sectionPanelClean .toggle input{width:16px;height:16px;min-height:16px!important;padding:0;flex-shrink:0}',
    '.sectionPanelClean .selectionList{gap:6px;margin-top:9px;max-height:110px;overflow:auto}',
    '.sectionPanelClean .chosenPerfume{font-size:12px;padding:7px 9px;background:#fff;border-color:#e2d7c3}',
    '.sectionPanelClean .notice,.sectionPanelClean .modeHelp{font-size:11px;line-height:1.7;color:#827358;padding:5px 0;margin:5px 0}',
    '.sectionPanelClean .toggle{font-size:12px;margin-bottom:9px;gap:8px}',
    '.sectionPanelClean .actions{margin-top:14px;padding-top:12px;border-top:1px solid #e9dec8;gap:10px}',
    '.sectionPanelClean .actions button{min-height:39px;font-size:13px}',
    '.sectionPanelClean .primary{background:#30291f;color:#f1dfb7;border-color:#30291f}',
    '.sectionPanelClean [hidden]{display:none!important}',
    '@media(max-width:650px){.sectionPanelClean{width:94vw!important;padding:14px!important}.sectionPanelClean .manualLayout{grid-template-columns:1fr!important}.sectionPanelClean .filterGrid{grid-template-columns:repeat(2,minmax(0,1fr))!important}.sectionPanelClean .manualResults{max-height:190px!important}}',
    '.sectionPanelClean .manualResults{min-height:300px!important;max-height:420px!important}@media(max-width:650px){.sectionPanelClean .manualResults{min-height:220px!important;max-height:330px!important}}'
  ].join('\n');

  /* ---------- tiny DOM helper ---------- */
  function h(tag, attrs, kids) {
    var node = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.style.cssText = value;
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value != null) node.setAttribute(key, value);
    });
    (kids || []).forEach(function (kid) { if (kid != null) node.appendChild(typeof kid === 'string' ? doc.createTextNode(kid) : kid); });
    return node;
  }
  function option(value, text) { return h('option', { value: value, text: text }); }
  function fieldset(title) { return h('fieldset', {}, [h('legend', { text: title })]); }

  function toast(text) { if (typeof root.markBridge === 'function') root.markBridge(text); }

  var active = null;
  function closePanel() {
    if (!active) return;
    var dlg = active; active = null;
    try { if (dlg.open) dlg.close(); } catch (_) { /* already closed */ }
    if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
  }
  function mount(dlg) {
    closePanel();
    if (!doc.getElementById('elan-lc-style')) { var style = h('style', { id: 'elan-lc-style' }); style.textContent = STYLE; doc.head.appendChild(style); }
    dlg.addEventListener('close', function () { if (active === dlg) { active = null; if (dlg.parentNode) dlg.parentNode.removeChild(dlg); } });
    doc.body.appendChild(dlg);
    active = dlg;
    dlg.showModal();
  }
  function failure(host, before, text) {
    var box = host.querySelector('[data-error]');
    if (!text) { if (box) box.remove(); return; }
    if (!box) { box = h('div', { role: 'alert', 'data-error': 'true', style: 'margin-top:10px;font-size:12px;line-height:1.7;color:#a3281f' }); host.insertBefore(box, before); }
    box.textContent = text;
  }

  /* ---------- name-only panels: brand, store, occasion, note (the original's 380px panel) ---------- */
  function openName(kind, at, ratios) {
    var spec = NAME_KINDS[kind];
    var field = ratios && root.elanRatioField ? root.elanRatioField(ratios, spec.dim) : null;      // «أبعاد كارت البراند»: automatic, or one of the common shapes
    var dlg = h('dialog', { style: 'width:380px;max-width:92vw;padding:22px;background:#fffdf8;border:1px solid #c6aa70;border-radius:14px' });
    var title = h('h3', { text: spec.title, style: 'margin:0 0 18px;color:#87652d' });
    var input = h('input', { type: 'text', autocomplete: 'off', maxlength: '120', style: 'display:block;width:100%;margin-top:8px;padding:10px;background:white' });
    var label = h('label', {}, [spec.label, input]);
    var create = h('button', { text: 'إنشاء', style: 'flex:1;background:#29251e;color:#f0dfb9' });
    var cancel = h('button', { text: 'إلغاء', style: 'flex:1' });
    var actions = h('div', { style: 'display:flex;gap:10px;margin-top:18px' }, [create, cancel]);
    dlg.append(title, label); if (field) dlg.appendChild(field.node); dlg.appendChild(actions);
    function fail(text) { failure(dlg, actions, text); }
    input.addEventListener('input', function () { input.setCustomValidity(''); fail(''); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); create.click(); } });
    cancel.onclick = closePanel;
    create.onclick = function () {
      var value = input.value.trim();
      if (!value) { input.focus(); input.setCustomValidity(spec.required); input.reportValidity(); return; }
      create.disabled = cancel.disabled = true; create.textContent = 'جارٍ الإنشاء…'; fail('');
      data('catalog.create', { kind: kind, name: value }).then(function (catalog) {
        if (!catalog.record || !catalog.record.id || !catalog.record.name) throw new Error('لم يتم تأكيد مطابقة أو إنشاء سجل الكتالوج.');
        var filters = {}; filters[spec.key] = String(catalog.record.name);
        return commit(kind, { name: String(catalog.record.name), purpose: kind, selection_mode: 'auto', filters: filters, product_size_ids: [], timer: { mode: 'none' } }, at, field && field.get());
      }).then(function () { closePanel(); toast(spec.done + ' اضغط حفظ لنشرها.'); })
        .catch(function (e) { fail((e && e.message) || 'تعذر الإنشاء.'); create.disabled = cancel.disabled = false; create.textContent = 'إنشاء'; });
    };
    mount(dlg); input.focus();
  }

  /* ---------- section and perfume-card panel (the original's .sectionPanelClean dialog) ---------- */
  function openSection(kind, at, ratios) {
    var perfume = kind === 'perfume';
    var field = ratios && root.elanRatioField ? root.elanRatioField(ratios, perfume ? 'أبعاد كروت العطور' : 'أبعاد السيكشن') : null;      // automatic, or one of the common shapes
    var picks = [], results = [], serial = 0;

    var nameInput = h('input', { type: 'text', autocomplete: 'off', maxlength: '120' });
    var purposeInput = h('input', { type: 'text', autocomplete: 'off', maxlength: '80' });
    var basics = h('div', { class: 'sectionGrid' }, [h('label', {}, ['اسم السيكشن', nameInput]), h('label', {}, ['الغرض من السيكشن', purposeInput])]);
    if (perfume) basics.style.display = 'none';

    var content = fieldset('اختيار العطور');
    var mode = h('select', { 'aria-label': 'طريقة الاختيار' }, [option('manual', 'اختيار عطور محددة'), option('automatic', 'تلقائي حسب الفلاتر')]);
    var help = h('div', { class: 'modeHelp' });
    var controls = {};
    var grid = h('div', { class: 'filterGrid' });
    FILTERS.forEach(function (f) {
      var select = h('select', { title: 'قائمة الأسماء تأتي من سابابيس عند الربط' }, [option('', 'الكل')]); select.disabled = true; controls[f[0]] = select;
      grid.appendChild(h('label', {}, [f[1], select]));
    });
    var minInput = h('input', { type: 'number', min: '0', step: 'any' }), maxInput = h('input', { type: 'number', min: '0', step: 'any' });
    grid.appendChild(h('label', {}, ['السعر من', minInput])); grid.appendChild(h('label', {}, ['السعر إلى', maxInput]));
    var message = h('div', { class: 'notice', 'aria-live': 'polite' });
    var chosen = h('div', { class: 'selectionList' });
    var main = h('div', {}, [grid, message, chosen]);
    var sidebar = h('div', { class: 'manualResults' });
    var layout = h('div', { class: 'manualLayout' }, [main, sidebar]);
    var autoButton = h('button', { class: 'primary', type: 'button', text: 'إضافة العناصر' });
    var feedback = h('span', { style: 'font-size:12px;color:#79643f;display:none' });
    function tell(text) { feedback.textContent = text; feedback.style.display = text ? '' : 'none'; }
    var bar = h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap' }, [autoButton, feedback]);
    content.appendChild(h('label', {}, [mode])); content.appendChild(help); content.appendChild(layout); content.appendChild(bar);

    var timerBox = fieldset('توقيت السيكشن');
    var enabled = h('input', { type: 'checkbox' });
    var timing = h('select', {}, [option('dates', 'بداية ونهاية محددتان'), option('duration', 'مدة من أول حفظ للسيكشن')]);
    var timingLabel = h('label', {}, ['طريقة التوقيت', timing]);
    var startInput = h('input', { type: 'datetime-local' }), endInput = h('input', { type: 'datetime-local' });
    var dateGrid = h('div', { class: 'sectionGrid' }, [h('label', {}, ['البداية، توقيت مصر', startInput]), h('label', {}, ['النهاية، توقيت مصر', endInput])]);
    var countInput = h('input', { type: 'number', min: '1', step: '1', value: '1' });
    var unit = h('select', {}, [option('hours', 'ساعات'), option('days', 'أيام')]);
    var durationGrid = h('div', { class: 'sectionGrid' }, [h('label', {}, ['المدة', countInput]), h('label', {}, ['الوحدة', unit])]);
    timerBox.appendChild(h('label', { class: 'toggle' }, [enabled, 'تشغيل التوقيت'])); timerBox.appendChild(timingLabel); timerBox.appendChild(dateGrid); timerBox.appendChild(durationGrid);

    var save = h('button', { class: 'primary', text: perfume ? 'حفظ كروت العطور' : 'حفظ السيكشن' });
    var cancel = h('button', { text: 'إلغاء' });
    var actions = h('div', { class: 'actions' }, [save, cancel]);
    var dlg = h('dialog', { class: 'sectionPanelClean', style: 'width:760px;max-height:90vh' }, [
      h('h3', { text: perfume ? 'إنشاء كارت عطر' : 'إنشاء سيكشن' }), basics, content, timerBox].concat(field ? [field.node] : [], [actions]));

    function fail(text) { failure(dlg, actions, text); }
    function currentFilters() {
      var values = { min: minInput.value, max: maxInput.value }, labels = {};
      FILTERS.forEach(function (f) {
        var select = controls[f[0]], picked = select.options[select.selectedIndex];
        values[f[0]] = select.value; labels[f[0]] = picked ? picked.textContent : '';
      });
      return buildFilters(values, labels);
    }
    function paintChosen() {
      chosen.textContent = '';
      picks.forEach(function (p, index) {
        var remove = h('button', { type: 'button', text: 'إزالة' });
        remove.onclick = function () { picks.splice(index, 1); paintChosen(); paintResults(); };
        chosen.appendChild(h('div', { class: 'chosenPerfume' }, [h('span', { text: p.name + (p.sizeLabel ? ' — ' + p.sizeLabel : '') }), remove]));
      });
    }
    /* One row per perfume with its own add button (the original turns its checkbox rows into these). */
    function paintResults() {
      sidebar.textContent = '';
      sidebar.appendChild(h('h4', { text: 'العطور الناتجة عن الفلترة' }));
      if (!results.length) { sidebar.appendChild(h('p', { text: 'لا توجد نتائج جاهزة، أو جارٍ تحميلها.' })); return; }
      results.slice(0, 500).forEach(function (p) {
        var added = picks.some(function (x) { return x.productSizeId === p.product_size_id; });
        var name = p.name + (p.size_label ? ' — ' + p.size_label : '');
        var button = h('button', { type: 'button', 'data-single-add': 'true', style: 'white-space:nowrap;padding:7px 10px;background:' + (added ? '#e3efe2' : '#fffaf0'), text: added ? '✓ تمت الإضافة' : 'إضافة' });
        button.disabled = added;
        button.onclick = function (ev) {
          ev.preventDefault();
          if (!picks.some(function (x) { return x.productSizeId === p.product_size_id; })) picks.push({ productId: p.product_id, productSizeId: p.product_size_id, name: p.name, sizeLabel: p.size_label || null });
          paintChosen(); paintResults();
        };
        sidebar.appendChild(h('label', { 'data-per-perfume': 'true', 'data-perfume-name': name, style: 'display:flex' }, [h('span', { text: name, style: 'flex:1' }), button]));
      });
    }
    function validRows(rows) {
      return Array.isArray(rows) && !rows.some(function (p) { return !p.product_id || !p.product_size_id || !p.name; });
    }
    function refresh() {
      var seq = ++serial; results = []; paintResults();
      var f;
      try { f = currentFilters(); } catch (e) { message.textContent = e.message; return Promise.resolve(); }
      message.textContent = 'جارٍ قراءة نتائج الفلترة…';
      return data('perfumes', { filters: f.provider }).then(function (j) {
        if (seq !== serial) return;
        if (!validRows(j.rows)) throw new Error('bad rows');
        results = j.rows; message.textContent = 'عدد النتائج المتاحة: ' + results.length; paintResults();
      }).catch(function () {
        if (seq !== serial) return;
        results = []; message.textContent = 'تعذر قراءة النتائج؛ لم تُضف بيانات بديلة.'; paintResults();
      });
    }
    function loadOptions() {
      message.textContent = 'جارٍ تحميل قوائم سابابيس…';
      return data('options').then(function (j) {
        FILTERS.forEach(function (f) {
          var list = j.options && j.options[f[2]];
          if (!Array.isArray(list)) throw new Error('قائمة ناقصة');
          var select = controls[f[0]];
          select.textContent = ''; select.appendChild(option('', 'كل ' + f[1]));
          list.forEach(function (record) {
            var id = f[0] === 'size' ? record.size_ml : record.id;
            if (id === undefined || id === null || !record.name) return;
            select.appendChild(option(String(id), record.name));
          });
          select.disabled = false; select.onchange = refresh;
        });
        return refresh();
      }).catch(function () { message.textContent = 'تعذر تحميل قوائم سابابيس. لن يتم تعويضها بقيم وهمية.'; });
    }
    function applyMode() {
      var manual = mode.value === 'manual';
      sidebar.hidden = !manual; chosen.hidden = !manual; autoButton.hidden = manual; help.hidden = manual;      // the bar itself stays, as in the original (it has no height while its button is hidden)
      help.textContent = manual ? '' : 'كل العطور المطابقة للفلاتر تدخل في السيكشن تلقائيًا بعد الربط، بدون تحديد عطر فردي أو حد مختارات.';
      tell('');
      layout.style.gridTemplateColumns = manual ? 'minmax(0,1fr) 225px' : '1fr';
    }
    function applyTimer() {
      timingLabel.hidden = !enabled.checked;
      dateGrid.hidden = !enabled.checked || timing.value !== 'dates';
      durationGrid.hidden = !enabled.checked || timing.value !== 'duration';
    }
    mode.onchange = function () { fail(''); applyMode(); };
    minInput.onchange = maxInput.onchange = refresh;
    enabled.onchange = timing.onchange = applyTimer;
    applyMode(); applyTimer(); paintResults();

    /* "إضافة العناصر": count what the current filters match right now; the saved section keeps following them. */
    autoButton.onclick = function () {
      var f;
      try { f = currentFilters(); } catch (e) { tell(e.message); return; }
      autoButton.disabled = true; tell('جارٍ إضافة نتائج الفلترة…');
      data('perfumes', { filters: f.provider }).then(function (j) {
        if (!validRows(j.rows)) throw new Error('bad rows');
        tell('أضيفت ' + j.rows.length + ' نتيجة إلى إعداد السيكشن. اضغط ' + save.textContent + ' لاعتمادها.');
      }).catch(function () { tell('تعذر تحميل العناصر؛ لم تُعتمد نتائج بديلة.'); })
        .then(function () { autoButton.disabled = false; });
    };
    cancel.onclick = closePanel;
    /* Enter in the name or purpose box confirms, as it does in the small name panels; what is still missing is told in the panel's own words */
    [nameInput, purposeInput].forEach(function (box) { box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !save.disabled) { ev.preventDefault(); save.click(); } }); });
    save.onclick = function () {
      fail('');
      var model, body;
      try {
        if (!perfume && (!nameInput.value.trim() || !purposeInput.value.trim())) throw new Error('اكتب الاسم والغرض.');
        var automatic = mode.value === 'automatic';
        if (!automatic && !picks.length) throw new Error(perfume ? EMPTY_PICKS : 'اختر عطرًا واحدًا على الأقل من قائمة النتائج.');
        var filters = currentFilters();
        var timer = timerPayload({ enabled: enabled.checked, mode: timing.value, start: startInput.value, end: endInput.value, count: countInput.value, unit: unit.value });
        model = {
          name: perfume ? (!automatic && picks.length === 1 ? picks[0].name : 'عطور مختارة') : nameInput.value.trim(),
          purpose: perfume ? 'perfume' : purposeInput.value.trim(),
          mode: mode.value, filters: filters, picks: picks, timer: timer
        };
        body = sectionBody(model);
      } catch (e) { fail(e.message); return; }
      save.disabled = cancel.disabled = true; save.textContent = 'جارٍ الإنشاء…';
      var check = perfume && mode.value === 'automatic'
        ? data('perfumes', { filters: model.filters.provider }).then(function (j) { if (!validRows(j.rows) || !j.rows.length) throw new Error(EMPTY_PICKS); })
        : Promise.resolve();
      check.then(function () { return commit(kind, body, at, field && field.get()); })
        .then(function () { closePanel(); toast((perfume ? 'تم إنشاء كروت العطور.' : 'تم إنشاء السيكشن.') + ' اضغط حفظ لنشره.'); })
        .catch(function (e) {
          fail((e && e.message) || 'تعذر الإنشاء.');
          save.disabled = cancel.disabled = false; save.textContent = perfume ? 'حفظ كروت العطور' : 'حفظ السيكشن';
        });
    };

    mount(dlg);
    /* the section panel puts the cursor in its name box; the perfume card has no name box, and the original shows no focused field there */
    if (!perfume) nameInput.focus(); else if (root.document.activeElement && root.document.activeElement.blur) root.document.activeElement.blur();
    loadOptions();
  }

  function open(kind, at, ratios) {
    if (!KINDS[kind]) throw new Error('نوع إنشاء غير مدعوم: ' + kind);
    if (NAME_KINDS[kind]) openName(kind, at, ratios); else openSection(kind, at, ratios);
  }

  /* The host menu calls this for the tools whose ui is "create" (ids create_section, create_brand, ...). */
  root.elanLiveCreate = function (tool, at) {
    var match = /^create_(section|brand|store|perfume|occasion|note)$/.exec(tool && tool.id || '');
    if (!match) throw new Error('أداة إنشاء غير معروفة.');
    open(match[1], at, tool && tool.sizes);
  };
  root.elanLiveCreatePanels = { open: open, close: closePanel, helpers: helpers };
})(typeof window !== 'undefined' ? window : null);
