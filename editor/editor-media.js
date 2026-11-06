/* Élan Editor — media picker (library + upload from the device), shown in the editor window with the editor's own look.
   It talks to the same-origin server (which uses the admin session); only the bytes of a video go on to the storage address the server signed. Used by the right-click menu tools
   whose ui is "media" (replace the image of the selected element) or "media_new" (create something with an image). */
(function () {
  'use strict';
  var css = document.createElement('style');
  css.textContent = [
    /* the original editor file's "مصدر الصورة أو الفيديو" dialog: 420px, cream, gold border, stacked full-width buttons */
    '#elanMediaDlg{width:420px;max-width:94vw;padding:22px;background:#fffdf8;border:1px solid #c6aa70;border-radius:14px;direction:rtl;font-family:Tahoma,Arial}',
    '#elanMediaDlg::backdrop{background:#0005}',
    '#elanMediaDlg h3{color:#87652d}',
    '#elanMediaDlg .note{font-size:12px;line-height:1.7;color:#7d6a49}#elanMediaDlg .note:empty{display:none}'
  ].join('\n');
  document.head.appendChild(css);

  function el(tag, text, props) { var x = document.createElement(tag); if (text) x.textContent = text; Object.keys(props || {}).forEach(function (k) { x[k] = props[k]; }); return x; }

  function failure(code) { var e = new Error(code); e.code = code; return e; }
  function messages(isVideo) {
    return { unsupported_type: 'نوع الملف مش مسموح.', file_does_not_match_type: 'الملف مش صورة أو فيديو صالح.', file_too_large: isVideo ? 'الفيديو أكبر من 50 ميجا.' : 'الصورة أكبر من 10 ميجا.', unauthorized: 'انتهت الجلسة، سجلي الدخول تاني.', library_record_failed: 'الملف اترفع لكن تسجيله في المكتبة فشل.', storage_unreachable: 'التخزين مش متاح دلوقتي، جرّبي كمان شوية.', upload_not_found: 'الفيديو ما وصلش للتخزين. جرّبي تاني.' };
  }
  function postJson(url, data) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !j.ok) throw failure(j.error || (r.status === 401 ? 'unauthorized' : 'upload_failed')); return j; });
    });
  }
  /* A big picture is slimmed before it goes up: a 2 MB PNG hero took seconds to show on a phone. A PNG or JPEG over 500 KB is redrawn
     at most 2000 px on its long side and saved as WebP (quality .85, transparency kept), and the smaller of the two files goes up.
     GIFs may be animated and are left alone. Any trouble (no canvas, an old browser) uploads the original. */
  var SLIM_OVER = 500 * 1024, SLIM_SIDE = 2000;
  async function slim(file) {
    try {
      if (!/^image\/(png|jpeg)$/.test(file.type) || file.size <= SLIM_OVER || typeof createImageBitmap !== 'function') return file;
      var bmp = await createImageBitmap(file);
      var k = Math.min(1, SLIM_SIDE / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      var blob = await new Promise(function (done) { c.toBlob(done, 'image/webp', 0.85); });
      if (!blob || blob.type !== 'image/webp' || blob.size >= file.size * 0.9) return file;
      return new File([blob], (file.name || 'picture').replace(/\.[^.]*$/, '') + '.webp', { type: 'image/webp' });
    } catch (e) { return file; }
  }
  /* A picture is small: it goes through the server. */
  async function uploadPicture(file, folder) {
    file = await slim(file);
    var headers = { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) };
    if (folder) headers['X-Media-Category'] = folder;   // the library folder it was uploaded from
    var r = await fetch('/api/editor-upload', { method: 'POST', credentials: 'same-origin', headers: headers, body: file });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw failure(j.error || (r.status === 401 ? 'unauthorized' : 'upload_failed'));
    return j.url;
  }
  /* A video goes straight to the storage bucket (the server only signs the upload and, afterwards, checks the stored file and records it),
     so its size is limited by the bucket, not by the Worker. Same upload the Supabase library sends: a form with the file. */
  async function uploadVideo(file, onProgress, folder) {
    var s = await postJson('/api/editor-upload-sign', { type: file.type, size: file.size });
    await new Promise(function (resolve, reject) {
      var fd = new FormData(); fd.append('cacheControl', '31536000'); fd.append('', file);
      var x = new XMLHttpRequest(); x.open('PUT', s.uploadUrl);
      x.setRequestHeader('apikey', s.apikey); x.setRequestHeader('Authorization', 'Bearer ' + s.apikey); x.setRequestHeader('x-upsert', 'false');
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
      x.onload = function () { if (x.status >= 200 && x.status < 300) resolve(); else reject(failure(x.status === 413 ? 'file_too_large' : 'upload_failed')); };
      x.onerror = function () { reject(failure('storage_unreachable')); };
      x.send(fd);
    });
    return (await postJson('/api/editor-upload-done', { path: s.path, type: file.type, name: file.name, category: folder || '' })).url;
  }

  window.elanPickMedia = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var dlg = el('dialog', '', { id: 'elanMediaDlg' }), done = false;
      function finish(v) { if (done) return; done = true; try { dlg.close(); } catch (_) { /* closed */ } dlg.remove(); resolve(v || null); }
      dlg.addEventListener('cancel', function () { finish(null); }); dlg.addEventListener('close', function () { finish(null); });
      dlg.appendChild(el('h3', 'مصدر الصورة أو الفيديو'));
      var note = el('p', '', { className: 'note' });
      function source(label, fn) { var b = el('button', label); b.type = 'button'; b.style.cssText = 'display:block;width:100%;margin:9px 0'; b.onclick = fn; dlg.appendChild(b); return b; }
      source('من مكتبة سابابيس', function () { showLibrary(); });
      source('من الجهاز', function () { showUpload(); });
      var slot = null;      // the library list or the file box, added after the buttons
      function put(node) { if (slot) slot.remove(); slot = node; dlg.appendChild(node); }
      if (opts.optional) { var skip = el('button', 'بدون صورة دلوقتي'); skip.type = 'button'; skip.style.cssText = 'display:block;width:100%;margin:9px 0'; skip.onclick = function () { finish(null); }; dlg.appendChild(skip); }
      var close = el('button', 'إلغاء'); close.type = 'button'; close.style.cssText = 'display:block;width:100%;margin:9px 0'; close.onclick = function () { finish(null); }; dlg.appendChild(close);
      dlg.insertBefore(note, close.nextSibling);      // like the original: the message and the list come after the buttons

      /* the library: one full-width button per picture or video (its name), like the original's list */
      function showLibrary() {
        var list = el('div'), more = el('button', 'المزيد'), offset = 0;
        more.type = 'button'; more.style.cssText = 'display:none;width:100%;margin:6px 0';
        list.appendChild(el('h4', 'اختر الميديا')); put(list);
        async function load() {
          note.textContent = 'بيتحمّل...';
          try {
            var r = await fetch('/api/editor-media?kind=all&offset=' + offset, { credentials: 'same-origin', cache: 'no-store' });
            var j = await r.json().catch(function () { return {}; });
            if (!r.ok || !j.ok) throw new Error(r.status === 401 ? 'انتهت الجلسة، سجلي الدخول تاني.' : 'تعذر تحميل المكتبة.');
            offset += j.items.length; note.textContent = '';
            if (!offset) list.appendChild(el('p', 'لا توجد صور أو فيديوهات محفوظة في المكتبة المركزية.'));
            j.items.forEach(function (it) {
              var b = el('button', it.title || (it.kind === 'video' ? 'فيديو' : 'صورة')); b.type = 'button'; b.dataset.kind = it.kind || '';
              b.style.cssText = 'display:block;width:100%;margin:6px 0'; b.onclick = function () { finish(it.url); }; list.appendChild(b);
            });
            list.appendChild(more); more.style.display = j.items.length < 24 ? 'none' : 'block';
          } catch (e) { note.textContent = e.message; more.style.display = 'none'; }
        }
        more.onclick = load; load();
      }
      function showUpload() {
        var f = el('input', '', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm' });
        note.textContent = 'صور (JPG, PNG, WebP, GIF, AVIF) لحد 10 ميجا، أو فيديو (MP4, WebM) لحد 50 ميجا.'; put(f);
        f.onchange = async function () {
          var file = f.files[0]; if (!file) return;
          var isVideo = /^video\//.test(file.type), limit = (isVideo ? 50 : 10) * 1024 * 1024;
          if (file.size > limit) { note.textContent = isVideo ? 'الفيديو أكبر من 50 ميجا. قصّه أو صغّر حجمه.' : 'الصورة أكبر من 10 ميجا.'; return; }
          note.textContent = 'بيترفع...';
          try { finish(isVideo ? await uploadVideo(file, function (pct) { note.textContent = 'بيترفع... ' + pct + '%'; }) : await uploadPicture(file)); }
          catch (e) { note.textContent = messages(isVideo)[e.code] || 'الرفع فشل.'; }
        };
      }
      document.body.appendChild(dlg); dlg.showModal();
    });
  };

  /* A picture or a video is only added where there is none (the white base), so replaced files never pile up. This tells the owner so
     before any picking or uploading starts, and offers the delete that clears the way. */
  function busyNotice(element) {
    var dlg = el('dialog', '', { id: 'elanMediaDlg' });
    dlg.appendChild(el('h3', 'العنصر ده فيه ميديا بالفعل'));
    dlg.appendChild(el('div', 'مينفعش ترفعي صورة أو فيديو فوق الموجود، عشان ما يتراكمش حاجات على المنصة. احذفي الميديا الحالية الأول، وبعدين ارفعي الجديدة.', { className: 'note' }));
    var foot = el('div'), del = el('button', 'حذف الميديا الحالية'), close = el('button', 'إلغاء');
    function end() { try { dlg.close(); } catch (_) { /* closed */ } dlg.remove(); }
    del.onclick = function () { end(); if (typeof runLive === 'function') runLive('tool.run', { id: 'media_delete', elementId: element.id }); };
    close.onclick = end; dlg.addEventListener('cancel', end);
    foot.append(del, close); dlg.appendChild(foot);
    document.body.appendChild(dlg); dlg.showModal();
  }

  /* Uploads a file the way the picker does (a picture through the server, a video straight to storage) and gives back its address.
     Used by the library to move the old browser-only media into the cloud library. */
  window.elanUploadMediaFile = function (file, onProgress, folder) { return /^video\//.test(file.type) ? uploadVideo(file, onProgress || function () {}, folder) : uploadPicture(file, folder); };
  // Menu tool: put a picked image into the selected element.
  window.elanLiveMedia = async function (element, tool) {
    if (element && element.hasMedia) { busyNotice(element); return; }
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
