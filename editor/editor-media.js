/* Élan Editor — media picker (library + upload from the device), shown in the editor window with the editor's own look.
   It talks to the same-origin server only; the server uses the admin session. Used by the right-click menu tools
   whose ui is "media" (replace the image of the selected element) or "media_new" (create something with an image). */
(function () {
  'use strict';
  var css = document.createElement('style');
  css.textContent = [
    '#elanMediaDlg{border:1px solid #b59655;border-radius:12px;padding:16px;width:min(640px,94vw);max-height:88vh;background:#fffaf0;direction:rtl;font-family:Tahoma,Arial}',
    '#elanMediaDlg::backdrop{background:rgba(0,0,0,.35)}',
    '#elanMediaDlg .tabs{display:flex;gap:6px;margin:10px 0}#elanMediaDlg button{font:inherit;padding:7px 12px;border:1px solid #c2a66a;border-radius:7px;background:#fff;cursor:pointer}',
    '#elanMediaDlg button.on{background:#f6ecd3}#elanMediaDlg .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:46vh;overflow:auto;margin:8px 0}',
    '#elanMediaDlg .grid img{width:100%;height:100px;object-fit:cover;border-radius:8px;border:2px solid transparent;cursor:pointer;background:#fff}#elanMediaDlg .grid img:hover{border-color:#a88032}',
    '#elanMediaDlg .note{font-size:13px;color:#6b4e00;min-height:18px;margin:6px 0}'
  ].join('\n');
  document.head.appendChild(css);

  function el(tag, text, props) { var x = document.createElement(tag); if (text) x.textContent = text; Object.keys(props || {}).forEach(function (k) { x[k] = props[k]; }); return x; }

  window.elanPickMedia = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dlg = el('dialog', '', { id: 'elanMediaDlg' }), done = false;
      function finish(v) { if (done) return; done = true; try { dlg.close(); } catch (_) { /* closed */ } dlg.remove(); resolve(v || null); }
      dlg.addEventListener('cancel', function () { finish(null); }); dlg.addEventListener('close', function () { finish(null); });
      dlg.appendChild(el('b', 'اختيار صورة'));
      var tabs = el('div', '', { className: 'tabs' }), bLib = el('button', 'المكتبة'), bUp = el('button', 'رفع من الجهاز'), bAi = el('button', 'توليد بالذكاء الاصطناعي');
      tabs.append(bLib, bUp, bAi); dlg.appendChild(tabs);
      var body = el('div'), note = el('div', '', { className: 'note' });
      dlg.append(body);
      var foot = el('div'); if (opts.optional) { var skip = el('button', 'بدون صورة دلوقتي'); skip.onclick = function () { finish(null); }; foot.appendChild(skip); }
      var close = el('button', 'إلغاء'); close.onclick = function () { finish(null); }; foot.appendChild(close); dlg.appendChild(foot);

      function mark(b) { [bLib, bUp, bAi].forEach(function (x) { x.classList.toggle('on', x === b); }); }
      function showLibrary() {
        mark(bLib); body.textContent = ''; var grid = el('div', '', { className: 'grid' }), more = el('button', 'المزيد'), offset = 0; body.append(note, grid, more);
        async function load() {
          note.textContent = 'بيتحمّل...';
          try {
            var r = await fetch('/api/editor-media?offset=' + offset, { credentials: 'same-origin', cache: 'no-store' });
            var j = await r.json().catch(function () { return {}; });
            if (!r.ok || !j.ok) throw new Error(r.status === 401 ? 'انتهت الجلسة، سجلي الدخول تاني.' : 'تعذر تحميل المكتبة.');
            offset += j.items.length; note.textContent = (!offset) ? 'المكتبة فاضية. ارفعي صورة من الجهاز.' : '';
            j.items.forEach(function (it) { var im = el('img', '', { src: it.url, alt: it.title || '', loading: 'lazy' }); im.onclick = function () { finish(it.url); }; grid.appendChild(im); });
            more.hidden = j.items.length < 24;
          } catch (e) { note.textContent = e.message; more.hidden = true; }
        }
        more.onclick = load; load();
      }
      function showUpload() {
        mark(bUp); body.textContent = '';
        var f = el('input', '', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif' });
        note.textContent = 'صور فقط (JPG, PNG, WebP, GIF, AVIF) لحد 10 ميجا.'; body.append(f, note);
        f.onchange = async function () {
          var file = f.files[0]; if (!file) return;
          if (file.size > 10 * 1024 * 1024) { note.textContent = 'الصورة أكبر من 10 ميجا.'; return; }
          note.textContent = 'بيترفع...';
          try {
            var r = await fetch('/api/editor-upload', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file });
            var j = await r.json().catch(function () { return {}; });
            if (!r.ok || !j.ok) throw new Error(({ unsupported_type: 'نوع الملف مش مسموح.', file_does_not_match_type: 'الملف مش صورة صالحة.', file_too_large: 'الصورة أكبر من 10 ميجا.', unauthorized: 'انتهت الجلسة، سجلي الدخول تاني.', library_record_failed: 'الصورة اترفعت لكن تسجيلها في المكتبة فشل.' })[j.error] || 'الرفع فشل.');
            finish(j.url);
          } catch (e) { note.textContent = e.message; }
        };
      }
      function showAi() { mark(bAi); body.textContent = ''; body.append(el('div', 'توليد الصور بالذكاء الاصطناعي محتاج مفتاح على السيرفر وموافقتك على التكلفة، ولسه ما اتفعّلش.', { className: 'note' })); }
      bLib.onclick = showLibrary; bUp.onclick = showUpload; bAi.onclick = showAi;
      document.body.appendChild(dlg); dlg.showModal(); showLibrary();
    });
  };

  // Menu tool: put a picked image into the selected element.
  window.elanLiveMedia = async function (element) {
    var url = await window.elanPickMedia();
    if (url && typeof runLive === 'function') runLive('element.setMedia', { elementId: element && element.id, src: url });
  };
  // Menu tool: create something (a banner or an image) with an image, at the pointer.
  window.elanLiveMediaNew = async function (tool, at) {
    var url = await window.elanPickMedia({ optional: tool.id === 'create_banner' });
    if (!url && tool.id !== 'create_banner') return;
    if (typeof runLive === 'function') runLive('tool.run', { id: tool.id, at: at, src: url || undefined });
  };
})();
