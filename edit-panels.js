/* Élan Scents — the approved creation panels of the visual editor (admin only).
   Loaded by edit-boot.js ONLY inside the Élan Editor window, before edit-mode.js. Customers never receive it.

   What it does: replaces the plain browser dialogs of the six creation tools (section, brand, store,
   perfume card, occasion, note) with the approved panels, and keeps every other tool untouched.
   - Filters, perfume results and size lists come from /api/editor-data (the real catalogue, admin only).
   - Brand / store / occasion / note: the name is matched to the existing record or creates it (no duplicates).
   - A section or perfume card is stored in editor_sections / editor_section_items and the block that
     references it is created through edit mode's own `element.create`, so undo, save and publish stay unchanged.
   Hooks used (all existing): ElanHostBridge.install options, ElanEditTools.list(), ElanEditMode.execute(). */
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
    brand: { key: 'brand', title: 'إنشاء كارت براند', label: 'اسم البراند', required: 'اكتب اسم البراند', done: 'تم إنشاء كارت البراند.' },
    store: { key: 'store', title: 'إنشاء كارت متجر', label: 'اسم المتجر', required: 'اكتب اسم المتجر', done: 'تم إنشاء كارت المتجر.' },
    occasion: { key: 'occ', title: 'إنشاء كارت مناسبة', label: 'اسم المناسبة', required: 'اكتب الاسم', done: 'تم إنشاء كارت المناسبة.' },
    note: { key: 'note', title: 'إنشاء كارت نوتة عطرية', label: 'اسم النوتة العطرية', required: 'اكتب الاسم', done: 'تم إنشاء كارت النوتة.' }
  };
  var EMPTY_PICKS = 'أضف عطرًا من القائمة أولًا، أو اختر فلاتر لها نتائج في الوضع التلقائي.';

  var helpers = { localCairo: localCairo, cairoUTC: cairoUTC, buildFilters: buildFilters, timerPayload: timerPayload, sectionBody: sectionBody, FILTERS: FILTERS };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;

  var Bridge = root && root.ElanHostBridge;
  if (!root || !root.document || !Bridge || typeof Bridge.install !== 'function' || root.parent === root) return;

  /* ---------- server calls ---------- */
  var ticket = '';
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
    var headers = { 'Content-Type': 'application/json' };
    if (ticket) headers['X-Elan-Editor-Ticket'] = ticket;
    return root.fetch('/api/editor-data', { method: 'POST', headers: headers, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(Object.assign({ action: action }, payload || {})) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.ok) throw new Error(ERRORS[j.error] || 'تعذر الاتصال بالكتالوج.');
          return j;
        });
      });
  }
  function rid() { var a = new Uint8Array(5); root.crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }

  /* Create the central section first, then the block that references it, through edit mode itself. */
  function commit(kind, section, at) {
    var elementId = 'x-' + rid(), ED = root.ElanDesign;
    if (ED) {
      var probe = ED.normalize({ version: ED.VERSION, blocks: [{ id: 'x-' + rid(), type: 'smart', ref: elementId, style: { align: 'center', size: 'md' }, kind: kind }] }, { strict: true });
      if (!probe.ok || probe.design.blocks.length !== 1) return Promise.reject(new Error('تعذر تجهيز البلوك الجديد.'));
    }
    section.element_id = elementId;
    return data('section.create', { section: section }).then(function (j) {
      if (!j.ref || j.ref !== elementId) throw new Error('لم يتم تأكيد إنشاء القسم المركزي.');
      if (!root.ElanEditMode) throw new Error('وضع التحرير غير جاهز.');
      return root.ElanEditMode.execute('element.create', { kind: 'smart', ref: j.ref, semanticKind: kind, at: at || null });
    });
  }

  /* ---------- panel styling (the approved look) ---------- */
  var STYLE = [
    '.ep-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:10px;background:rgba(21,19,15,.45);pointer-events:auto;direction:rtl}',
    '.ep-panel{box-sizing:border-box;max-width:94vw;max-height:92vh;max-height:92dvh;overflow:auto;background:#fffdf9;color:#302b23;border:1px solid #c8ae79;border-radius:18px;box-shadow:0 24px 80px #0003;font:13px Tahoma,Arial,sans-serif}',
    '.ep-panel [hidden]{display:none!important}',
    '.ep-panel h3{margin:0 0 15px;padding-bottom:12px;border-bottom:1px solid #e9dec8;font-size:19px;font-weight:700;line-height:1.4;color:#86642e}',
    '.ep-panel label{display:flex;flex-direction:column;gap:5px;min-width:0;margin:0;font-size:12px;line-height:1.5;font-weight:500}',
    '.ep-panel input,.ep-panel select{box-sizing:border-box;width:100%;min-width:0;height:35px;min-height:35px;padding:7px 9px;border:1px solid #dccfb6;border-radius:7px;background:#fff;color:#302b23;font:12px Tahoma,Arial,sans-serif}',
    '.ep-panel input:focus,.ep-panel select:focus{outline:2px solid #cfb57966;outline-offset:1px;border-color:#ae8d4e}',
    '.ep-panel input:disabled,.ep-panel select:disabled{background:#f1eee7;color:#938977}',
    '.ep-panel button{font:12px Tahoma,Arial,sans-serif;min-height:34px;padding:8px 12px;border:1px solid #c6aa70;border-radius:8px;background:#fffaf0;color:#29251e;cursor:pointer}',
    '.ep-panel button:disabled{opacity:.6;cursor:default}',
    '.ep-panel .primary{background:#30291f;color:#f1dfb7;border-color:#30291f}',
    '.ep-section{width:min(790px,94vw);padding:20px}',
    '.ep-section fieldset{min-width:0;margin:12px 0;padding:12px;border:1px solid #e2d6bd;border-radius:12px;background:#faf7f0}',
    '.ep-section legend{padding:0 7px;font-size:13px;font-weight:700;color:#86642e}',
    '.ep-section .sectionGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.ep-section .filterGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}',
    '.ep-section .manualLayout{display:grid;grid-template-columns:minmax(0,1fr) 225px;gap:12px;align-items:start}',
    '.ep-section .manualResults{min-height:300px;max-height:420px;padding:10px;border:1px solid #ddcba7;border-radius:10px;background:#fffdf8;overflow:auto}',
    '.ep-section .manualResults h4{margin:0 0 9px;padding-bottom:7px;border-bottom:1px solid #ece2cf;font-size:13px;color:#76582a}',
    '.ep-section .manualResults p{margin:6px 0;font-size:12px;line-height:1.8;color:#827459}',
    '.ep-section .resultRow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #e7ddc8;font-size:12px}',
    '.ep-section .resultRow span{flex:1}.ep-section .resultRow button{white-space:nowrap;padding:7px 10px}',
    '.ep-section .selectionList{display:grid;gap:6px;max-height:110px;margin-top:9px;overflow:auto}',
    '.ep-section .chosenPerfume{display:flex;align-items:center;gap:10px;padding:7px 9px;border:1px solid #e2d7c3;border-radius:8px;background:#fff;font-size:12px}',
    '.ep-section .chosenPerfume span{flex:1}',
    '.ep-section .notice,.ep-section .modeHelp{margin:5px 0;padding:5px 0;font-size:11px;line-height:1.7;color:#827358}',
    '.ep-section .toggle{flex-direction:row;align-items:center;gap:8px;margin-bottom:9px;font-size:12px}',
    '.ep-section .toggle input{width:16px;height:16px;min-height:16px;padding:0}',
    '.ep-section .autoBar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:12px}.ep-section .autoBar span{font-size:12px;color:#79643f}',
    '.ep-section .actions{display:flex;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid #e9dec8}.ep-section .actions button{flex:1;min-height:39px;font-size:13px}',
    '.ep-name{width:380px;padding:22px;border-color:#c6aa70;border-radius:14px;background:#fffdf8}',
    '.ep-name h3{margin:0 0 18px;padding:0;border:0;font-size:18px;color:#87652d}',
    '.ep-name input{display:block;height:auto;margin-top:8px;padding:10px}',
    '.ep-name .actions{display:flex;gap:10px;margin-top:18px}.ep-name .actions button{flex:1}',
    '.ep-error{margin-top:10px;font-size:12px;line-height:1.7;color:#a3281f}',
    '@media(max-width:650px){.ep-section{width:94vw;padding:14px}.ep-section .manualLayout{grid-template-columns:1fr!important}.ep-section .filterGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.ep-section .manualResults{min-height:220px;max-height:330px}}'
  ].join('\n');

  /* ---------- tiny DOM helper ---------- */
  var doc = root.document;
  function h(tag, attrs, kids) {
    var node = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value != null) node.setAttribute(key, value);
    });
    (kids || []).forEach(function (kid) { if (kid != null) node.appendChild(typeof kid === 'string' ? doc.createTextNode(kid) : kid); });
    return node;
  }
  function option(value, text) { return h('option', { value: value, text: text }); }
  function fieldset(title) { return h('fieldset', {}, [h('legend', { text: title })]); }

  var active = null, toastTimer = null;
  function toast(text) {
    var el = doc.querySelector('#elan-eo-root .eo-msg');
    if (!el) return;
    el.textContent = text; el.style.display = 'block';
    root.clearTimeout(toastTimer); toastTimer = root.setTimeout(function () { el.style.display = 'none'; }, 3500);
  }
  function closePanel() {
    if (!active) return;
    var overlay = active; active = null;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  /* Everything lives inside edit mode's own overlay root so its page-blocking listeners treat the panel as editor UI. */
  function mount(panel) {
    var host = doc.getElementById('elan-eo-root');
    if (!host) throw new Error('واجهة المحرر غير جاهزة.');
    closePanel();
    if (!doc.getElementById('elan-ep-style')) { var style = h('style', { id: 'elan-ep-style' }); style.textContent = STYLE; host.appendChild(style); }
    var overlay = h('div', { class: 'ep-overlay' }, [panel]);
    overlay.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); closePanel(); } });
    host.appendChild(overlay);
    active = overlay;
  }

  /* ---------- name-only panels: brand, store, occasion, note ---------- */
  function openName(kind, at) {
    var spec = NAME_KINDS[kind];
    var input = h('input', { type: 'text', autocomplete: 'off', maxlength: '120' });
    var error = h('div', { class: 'ep-error', role: 'alert', hidden: true });
    var create = h('button', { class: 'primary', type: 'button', text: 'إنشاء' });
    var cancel = h('button', { type: 'button', text: 'إلغاء' });
    var panel = h('div', { class: 'ep-panel ep-name', role: 'dialog', 'aria-modal': 'true', 'aria-label': spec.title }, [
      h('h3', { text: spec.title }), h('label', {}, [spec.label, input]), error, h('div', { class: 'actions' }, [create, cancel])
    ]);
    function fail(text) { error.textContent = text; error.hidden = !text; }
    input.addEventListener('input', function () { input.setCustomValidity(''); fail(''); });
    input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); create.click(); } });
    cancel.onclick = closePanel;
    create.onclick = function () {
      var value = input.value.trim();
      if (!value) { input.setCustomValidity(spec.required); input.reportValidity(); input.focus(); return; }
      create.disabled = cancel.disabled = true; create.textContent = 'جارٍ الإنشاء…'; fail('');
      data('catalog.create', { kind: kind, name: value }).then(function (catalog) {
        if (!catalog.record || !catalog.record.id || !catalog.record.name) throw new Error('لم يتم تأكيد مطابقة أو إنشاء سجل الكتالوج.');
        var filters = {}; filters[spec.key] = String(catalog.record.name);
        return commit(kind, { name: String(catalog.record.name), purpose: kind, selection_mode: 'auto', filters: filters, product_size_ids: [], timer: { mode: 'none' } }, at);
      }).then(function () { closePanel(); toast(spec.done + ' اضغط حفظ لنشرها.'); })
        .catch(function (e) { fail((e && e.message) || 'تعذر الإنشاء.'); create.disabled = cancel.disabled = false; create.textContent = 'إنشاء'; });
    };
    mount(panel); input.focus();
  }

  /* ---------- section and perfume-card panel ---------- */
  function openSection(kind, at) {
    var perfume = kind === 'perfume';
    var picks = [], results = [], serial = 0;

    var nameInput = h('input', { type: 'text', autocomplete: 'off', maxlength: '120' });
    var purposeInput = h('input', { type: 'text', autocomplete: 'off', maxlength: '80' });
    var basics = h('div', { class: 'sectionGrid' }, [h('label', {}, ['اسم السيكشن', nameInput]), h('label', {}, ['الغرض من السيكشن', purposeInput])]);
    basics.hidden = perfume;

    var content = fieldset('اختيار العطور');
    var mode = h('select', { 'aria-label': 'طريقة الاختيار' }, [option('manual', 'اختيار عطور محددة'), option('automatic', 'تلقائي حسب الفلاتر')]);
    var help = h('div', { class: 'modeHelp' });
    var controls = {};
    var grid = h('div', { class: 'filterGrid' });
    FILTERS.forEach(function (f) {
      var select = h('select', {}, [option('', 'الكل')]); select.disabled = true; controls[f[0]] = select;
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
    var feedback = h('span');
    var bar = h('div', { class: 'autoBar' }, [autoButton, feedback]);
    content.appendChild(h('label', {}, [mode])); content.appendChild(help); content.appendChild(layout); content.appendChild(bar);

    var timerBox = fieldset('توقيت السيكشن');
    var enabled = h('input', { type: 'checkbox' });
    var timing = h('select', {}, [option('dates', 'بداية ونهاية محددتان'), option('duration', 'مدة من أول حفظ للسيكشن')]);
    var timingLabel = h('label', {}, [timing]);
    var startInput = h('input', { type: 'datetime-local' }), endInput = h('input', { type: 'datetime-local' });
    var dateGrid = h('div', { class: 'sectionGrid' }, [h('label', {}, ['البداية، توقيت مصر', startInput]), h('label', {}, ['النهاية، توقيت مصر', endInput])]);
    var countInput = h('input', { type: 'number', min: '1', step: '1', value: '1' });
    var unit = h('select', {}, [option('hours', 'ساعات'), option('days', 'أيام')]);
    var durationGrid = h('div', { class: 'sectionGrid' }, [h('label', {}, ['المدة', countInput]), h('label', {}, ['الوحدة', unit])]);
    timerBox.appendChild(h('label', { class: 'toggle' }, [enabled, 'تشغيل التوقيت'])); timerBox.appendChild(timingLabel); timerBox.appendChild(dateGrid); timerBox.appendChild(durationGrid);

    var error = h('div', { class: 'ep-error', role: 'alert', hidden: true });
    var save = h('button', { class: 'primary', type: 'button', text: perfume ? 'حفظ كروت العطور' : 'حفظ السيكشن' });
    var cancel = h('button', { type: 'button', text: 'إلغاء' });
    var panel = h('div', { class: 'ep-panel ep-section', role: 'dialog', 'aria-modal': 'true', 'aria-label': perfume ? 'إنشاء كارت عطر' : 'إنشاء سيكشن' }, [
      h('h3', { text: perfume ? 'إنشاء كارت عطر' : 'إنشاء سيكشن' }), basics, content, timerBox, error, h('div', { class: 'actions' }, [save, cancel])
    ]);

    function fail(text) { error.textContent = text; error.hidden = !text; }
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
    function paintResults() {
      sidebar.textContent = '';
      sidebar.appendChild(h('h4', { text: 'العطور الناتجة عن الفلترة' }));
      if (!results.length) { sidebar.appendChild(h('p', { text: 'لا توجد نتائج جاهزة، أو جارٍ تحميلها.' })); return; }
      results.slice(0, 500).forEach(function (p) {
        var added = picks.some(function (x) { return x.productSizeId === p.product_size_id; });
        var button = h('button', { type: 'button', text: added ? '✓ تمت الإضافة' : 'إضافة' });
        button.disabled = added; if (added) button.style.background = '#e3efe2';
        button.onclick = function () {
          if (!picks.some(function (x) { return x.productSizeId === p.product_size_id; })) picks.push({ productId: p.product_id, productSizeId: p.product_size_id, name: p.name, sizeLabel: p.size_label || null });
          paintChosen(); paintResults();
        };
        sidebar.appendChild(h('div', { class: 'resultRow' }, [h('span', { text: p.name + (p.size_label ? ' — ' + p.size_label : '') }), button]));
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
      sidebar.hidden = !manual; chosen.hidden = !manual; bar.hidden = manual; help.hidden = manual;
      help.textContent = manual ? '' : 'كل العطور المطابقة للفلاتر تدخل في السيكشن تلقائيًا بعد الربط، بدون تحديد عطر فردي أو حد مختارات.';
      feedback.textContent = manual ? '' : 'إضافة كل نتائج الفلاتر الحالية، بدون اختيار عطر فردي.';
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
      try { f = currentFilters(); } catch (e) { feedback.textContent = e.message; return; }
      autoButton.disabled = true; feedback.textContent = 'جارٍ إضافة نتائج الفلترة…';
      data('perfumes', { filters: f.provider }).then(function (j) {
        if (!validRows(j.rows)) throw new Error('bad rows');
        feedback.textContent = 'أضيفت ' + j.rows.length + ' نتيجة إلى إعداد السيكشن. اضغط ' + save.textContent + ' لاعتمادها.';
      }).catch(function () { feedback.textContent = 'تعذر تحميل العناصر؛ لم تُعتمد نتائج بديلة.'; })
        .then(function () { autoButton.disabled = false; });
    };
    cancel.onclick = closePanel;
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
      check.then(function () { return commit(kind, body, at); })
        .then(function () { closePanel(); toast((perfume ? 'تم إنشاء كروت العطور.' : 'تم إنشاء السيكشن.') + ' اضغط حفظ لنشره.'); })
        .catch(function (e) {
          fail((e && e.message) || 'تعذر الإنشاء.');
          save.disabled = cancel.disabled = false; save.textContent = perfume ? 'حفظ كروت العطور' : 'حفظ السيكشن';
        });
    };

    mount(panel);
    (perfume ? mode : nameInput).focus();
    loadOptions();
  }

  function open(kind, at) {
    if (!KINDS[kind]) throw new Error('نوع إنشاء غير مدعوم: ' + kind);
    if (NAME_KINDS[kind]) openName(kind, at); else openSection(kind, at);
  }

  /* Edit mode installs its bridge once, near the end of edit-mode.js. Wrap that call: capture the delegated ticket,
     route "ui.openCreatePanel" for the six kinds to the panels, and swap the prompt-based run() of the six tools. */
  var originalInstall = Bridge.install;
  Bridge.install = function (options) {
    var authorize = options.authorize, onTicket = options.onTicket, run = options.execute;
    options.authorize = function (context) {
      if (context && typeof context.ticket === 'string' && context.ticket) ticket = context.ticket;
      return authorize.apply(this, arguments);
    };
    options.onTicket = function (value) {
      if (typeof value === 'string' && value) ticket = value;
      if (typeof onTicket === 'function') return onTicket.apply(this, arguments);
    };
    options.execute = function (action, payload) {
      if (action === 'ui.openCreatePanel' && payload && KINDS[payload.kind]) { open(payload.kind, payload.at); return Promise.resolve(null); }
      return run.apply(this, arguments);
    };
    var api = originalInstall.apply(this, arguments);
    /* Same tool objects, same order in the menu: only what happens on click changes. */
    var tools = root.ElanEditTools && typeof root.ElanEditTools.list === 'function' ? root.ElanEditTools.list() : [];
    tools.forEach(function (tool) {
      var match = /^create_(section|brand|store|perfume|occasion|note)$/.exec(tool.id);
      if (match) tool.run = function (context) { open(match[1], context && context.at); return null; };
    });
    return api;
  };
})(typeof window !== 'undefined' ? window : null);
