/* Élan editor screen. Admin only. The login session lives in memory only (no "remember me"). */
(function () {
  'use strict';
  var ED = window.ElanDesign;
  var NAMES = { brands: 'الماركات', offers: 'العروض', new: 'وصل حديثًا', cats: 'الأقسام', master: 'الأعلى مبيعًا', occ: 'المناسبات', notes: 'النوتات', soon: 'قريبًا', stores: 'المتاجر' };
  var TEXT_LABELS = { magic: 'نص "magic"', view: 'نص زر العرض', explore: 'نص زر الاستكشاف', contactT: 'عنوان التواصل', send: 'نص زر الإرسال' };
  var session = null, revision = null, design = null, seq = [], busy = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k]; else if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]); else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function say(kind, text) { var m = $('msg'); m.className = kind; m.textContent = text; }
  function clearMsg() { $('msg').className = ''; $('msg').textContent = ''; }
  function rid() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }

  async function api(method, body, query) {
    var r = await fetch('/api/editor' + (query || ''), {
      method: method, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    var data = {}; try { data = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, data: data };
  }

  function currentSeq() {
    var blockIds = design.blocks.map(function (b) { return b.id; });
    var all = ED.BUILTIN.concat(blockIds), out = [];
    design.order.forEach(function (id) { if (all.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id); });
    all.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
    return out;
  }
  function blockOf(id) { return design.blocks.filter(function (b) { return b.id === id; })[0]; }
  function secOf(id) { design.sections[id] = design.sections[id] || {}; return design.sections[id]; }
  function tidySection(id) {
    var s = design.sections[id]; if (!s) return;
    if (s.title) { if (!s.title.ar) delete s.title.ar; if (!s.title.en) delete s.title.en; if (!s.title.ar && !s.title.en) delete s.title; }
    if (!s.hidden && !s.title) delete design.sections[id];
  }
  function move(id, dir) {
    var i = seq.indexOf(id), j = i + dir;
    if (j < 0 || j >= seq.length) return;
    seq.splice(i, 1); seq.splice(j, 0, id); render();
  }

  function render() {
    var box = $('sections'); box.textContent = '';
    seq.forEach(function (id) {
      var isBlock = ED.BUILTIN.indexOf(id) === -1;
      if (isBlock) return;
      var s = design.sections[id] || {};
      var row = el('div', { class: 'row' + (s.hidden ? ' hidden-sec' : '') });
      row.appendChild(el('div', { class: 'top' }, [
        el('b', { text: NAMES[id] || id }),
        el('div', { class: 'ctl' }, [
          el('button', { text: '↑', title: 'فوق', onclick: function () { move(id, -1); } }),
          el('button', { text: '↓', title: 'تحت', onclick: function () { move(id, 1); } })
        ])
      ]));
      var chk = el('input', { type: 'checkbox' }); chk.checked = !!s.hidden;
      chk.addEventListener('change', function () { var e = secOf(id); if (chk.checked) e.hidden = true; else delete e.hidden; tidySection(id); render(); });
      row.appendChild(el('label', { class: 'chk' }, [chk, el('span', { text: 'إخفاء القسم' })]));
      var ta = el('input', { placeholder: 'عنوان بديل (عربي)' }); ta.value = (s.title && s.title.ar) || '';
      var te = el('input', { placeholder: 'Title (English)', dir: 'ltr' }); te.value = (s.title && s.title.en) || '';
      function setTitle() { var e = secOf(id); e.title = { ar: ta.value, en: te.value }; tidySection(id); }
      ta.addEventListener('input', setTitle); te.addEventListener('input', setTitle);
      row.appendChild(el('div', { class: 'grid2' }, [ta, te]));
      box.appendChild(row);
    });
    renderBlocks(); renderTexts();
  }

  function renderBlocks() {
    var box = $('blocks'); box.textContent = '';
    seq.forEach(function (id) {
      var b = blockOf(id); if (!b) return;
      var row = el('div', { class: 'row' });
      row.appendChild(el('div', { class: 'top' }, [
        el('b', { text: 'نص: ' + id }),
        el('div', { class: 'ctl' }, [
          el('button', { text: '↑', onclick: function () { move(id, -1); } }),
          el('button', { text: '↓', onclick: function () { move(id, 1); } }),
          el('button', { class: 'danger', text: 'حذف', onclick: function () {
            design.blocks = design.blocks.filter(function (x) { return x.id !== id; });
            seq = seq.filter(function (x) { return x !== id; }); render();
          } })
        ])
      ]));
      if (b.type !== 'text') { row.appendChild(el('small', { class: 'hint', text: 'بلوك ' + b.type + ' (التعديل متاح لاحقًا، وبيتحفظ زي ما هو)' })); box.appendChild(row); return; }
      var ar = el('textarea', { placeholder: 'النص بالعربي' }); ar.value = (b.text && b.text.ar) || '';
      var en = el('textarea', { placeholder: 'Text in English', dir: 'ltr' }); en.value = (b.text && b.text.en) || '';
      function setText() { b.text = {}; if (ar.value.trim()) b.text.ar = ar.value; if (en.value.trim()) b.text.en = en.value; }
      ar.addEventListener('input', setText); en.addEventListener('input', setText);
      row.appendChild(el('div', { class: 'grid2' }, [ar, en]));
      var size = el('select', {}, ['sm', 'md', 'lg', 'xl'].map(function (v) { return el('option', { value: v, text: { sm: 'صغير', md: 'متوسط', lg: 'كبير', xl: 'كبير جدًا' }[v] }); }));
      size.value = (b.style && b.style.size) || 'md';
      var align = el('select', {}, ['start', 'center', 'end'].map(function (v) { return el('option', { value: v, text: { start: 'بداية السطر', center: 'وسط', end: 'نهاية السطر' }[v] }); }));
      align.value = (b.style && b.style.align) || 'center';
      size.addEventListener('change', function () { b.style = b.style || {}; b.style.size = size.value; });
      align.addEventListener('change', function () { b.style = b.style || {}; b.style.align = align.value; });
      row.appendChild(el('div', { class: 'grid2' }, [size, align]));
      box.appendChild(row);
    });
    if (!box.firstChild) box.appendChild(el('small', { class: 'hint', text: 'مفيش بلوكات نصوص لسه.' }));
  }

  function renderTexts() {
    var box = $('texts'); box.textContent = '';
    ED.TEXT_KEYS.forEach(function (k) {
      var ar = el('input', { placeholder: 'عربي' }); ar.value = (design.texts.ar && design.texts.ar[k]) || '';
      var en = el('input', { placeholder: 'English', dir: 'ltr' }); en.value = (design.texts.en && design.texts.en[k]) || '';
      function set(l, v) { design.texts[l] = design.texts[l] || {}; if (v.trim()) design.texts[l][k] = v; else delete design.texts[l][k]; if (!Object.keys(design.texts[l]).length) delete design.texts[l]; }
      ar.addEventListener('input', function () { set('ar', ar.value); });
      en.addEventListener('input', function () { set('en', en.value); });
      box.appendChild(el('div', { class: 'row' }, [el('b', { text: TEXT_LABELS[k] || k }), el('div', { class: 'grid2' }, [ar, en])]));
    });
  }

  async function load() {
    var r = await api('GET', null, '?action=state');
    if (r.status === 401 || r.status === 403) { throw new Error(r.status === 403 ? 'الحساب ده مش أدمن للمنصة.' : 'لازم تسجلي الدخول تاني.'); }
    if (r.status === 503) throw new Error('الإديتور لسه مش مظبوط على السيرفر (مفاتيح ناقصة).');
    if (!r.data.ok) throw new Error('تعذر تحميل التصميم.');
    revision = r.data.revision; design = r.data.design; seq = currentSeq();
    $('branchNote').textContent = 'الحفظ بيروح لفرع: ' + (r.data.branch || '');
    $('login').style.display = 'none'; $('app').style.display = 'grid'; $('logout').hidden = false;
    render();
  }

  async function waitPublished(rev) {
    for (var i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 5000); });
      var r = await api('POST', { action: 'status', revision: rev });
      if (r.data && r.data.published) return true;
    }
    return false;
  }

  async function save() {
    if (busy) return; busy = true; $('save').disabled = true;
    try {
      design.order = seq.slice();
      var norm = ED.normalize(design, { strict: true });
      if (!norm.ok) { say('err', 'فيه حاجة غلط في التعديلات: ' + norm.errors.slice(0, 2).join('، ')); return; }
      say('info', 'بيتحفظ...');
      var r = await api('POST', { action: 'save', design: norm.design, expectedRevision: revision, requestId: rid() });
      if (r.status === 409) { say('err', 'التصميم اتعدل من مكان تاني. اعملي تحديث للصفحة وجربي تاني، وما فيش حاجة اتمسحت.'); return; }
      if (!r.data.ok) { say('err', 'الحفظ ما نجحش (' + (r.data.error || r.status) + '). مفيش حاجة اتغيرت على الموقع.'); return; }
      revision = r.data.revision;
      if (r.data.unchanged) { say('ok', 'مفيش تغيير جديد، الموقع بالفعل زي ما هو.'); return; }
      say('info', 'اتحفظ. بنستنى الموقع يتحدّث (حوالي دقيقة)...');
      if (await waitPublished(revision)) { say('ok', 'اتنشر! الموقع اتحدّث.'); $('preview').src = '/?cb=' + Date.now(); }
      else say('err', 'اتحفظ بس الموقع لسه ما اتحدّثش. استني شوية وحدّثي المعاينة.');
    } catch (e) { say('err', 'حصلت مشكلة في الاتصال: ' + (e && e.message || '')); }
    finally { busy = false; $('save').disabled = false; }
  }

  $('loginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault(); clearMsg();
    var f = ev.target;
    try {
      var cfg = await fetch('/api/config').then(function (r) { return r.json(); });
      var r = await fetch(cfg.url + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.email.value.trim(), password: f.password.value })
      });
      var d = await r.json();
      if (!r.ok || !d.access_token) throw new Error('الإيميل أو كلمة السر غلط.');
      session = d; f.password.value = '';
      await load();
    } catch (e) { session = null; say('err', e.message || 'تعذر الدخول.'); }
  });
  $('addText').addEventListener('click', function () {
    var id = 'x-' + rid().slice(0, 8);
    design.blocks.push({ id: id, type: 'text', style: { align: 'center', size: 'md' }, text: { ar: 'نص جديد' } });
    seq.push(id); render();
  });
  $('save').addEventListener('click', save);
  $('logout').addEventListener('click', function () { session = null; location.reload(); });
})();
