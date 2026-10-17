/* Read-only cloud-library browser for the live editor. Design changes happen only after an explicit item action. */
(function () {
  'use strict';

  function validCloudLibrary(data) {
    return !!data && Array.isArray(data.media) && Array.isArray(data.archive) &&
      Array.isArray(data.savedElements) && /^[a-f0-9]{64}$/i.test(String(data.revision || ''));
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value || ''), location.href);
      return url.protocol === 'https:' && (url.origin === location.origin || url.hostname === 'sbgdtuqfrnfeggkwqtrw.supabase.co');
    } catch (_) { return false; }
  }

  function blockFromPayload(payload) {
    return payload && payload.format === 'elan-element-v1' ? payload.element : payload;
  }

  function supportedBlock(payload) {
    const block = blockFromPayload(payload);
    return !!block && typeof block === 'object' && !Array.isArray(block) && ['text', 'banner', 'image', 'smart'].includes(block.type);
  }

  function setCloudMessage(dialog, text) {
    let message = dialog.querySelector('[data-cloud-message]');
    if (!message) {
      message = document.createElement('p');
      message.dataset.cloudMessage = 'true';
      message.style.cssText = 'font-size:12px;line-height:1.8;color:#846631';
      const note = dialog.querySelector('small');
      dialog.insertBefore(message, note || null);
    }
    message.textContent = text;
  }

  function ensureSection(dialog, id, title, before) {
    let list = dialog.querySelector('#' + id);
    if (list) return list;
    const heading = document.createElement('h4');
    heading.textContent = title;
    list = document.createElement('div');
    list.id = id;
    const reference = before || dialog.querySelector('small');
    dialog.insertBefore(heading, reference || null);
    dialog.insertBefore(list, reference || null);
    return list;
  }

  window.connectElanLibrary = async function (provider) {
    const selectedProvider = provider || window.elanLibraryDataProvider;
    if (!selectedProvider || typeof selectedProvider.getLibrary !== 'function' || typeof selectedProvider.saveLibrary !== 'function') {
      throw new Error('موصل المكتبة السحابية غير متاح.');
    }
    window.elanLibraryDataProvider = selectedProvider;
    const data = await selectedProvider.getLibrary();
    if (!validCloudLibrary(data)) throw new Error('استجابة المكتبة السحابية غير صالحة.');
    // Connecting is read-only: it does not replace the page design or invoke Save/Publish.
    return data;
  };

  window.loadCloudLibrary = async function () {
    try {
      if (typeof cloudLibraryPending !== 'undefined' && cloudLibraryPending) {
        if (typeof showLibraryCloudMessage === 'function') showLibraryCloudMessage('توجد تغييرات محلية غير مؤكدة؛ لم نستبدلها بالمكتبة السحابية.');
        return false;
      }
      const data = await window.connectElanLibrary(window.elanLibraryDataProvider);
      state.archive = clone(data.archive);
      state.media = clone(data.media);
      state.savedElements = clone(data.savedElements);
      cloudLibraryRevision = data.revision;
      cloudLibraryReady = true;
      cloudLibraryPending = false;
      lastLibrarySignature = JSON.stringify(librarySnapshot());
      library();
      if (typeof showLibraryCloudMessage === 'function') {
        showLibraryCloudMessage('تم تحميل المكتبة السحابية. لم يُحفظ أو يُنشر تصميم الصفحة.');
      }
      return true;
    } catch (_) {
      if (typeof showLibraryCloudMessage === 'function') showLibraryCloudMessage('تعذر تحميل المكتبة السحابية؛ لم تتغير بيانات التصميم.');
      return false;
    }
  };

  window.openLiveLibrary = async function () {
    const dialog = document.getElementById('libraryDialog');
    const mediaList = document.getElementById('mediaList');
    const archiveList = document.getElementById('archiveList');
    if (!dialog || !mediaList || !archiveList || !window.elanLiveEditorBridge) return;

    try {
      const bridge = window.elanLiveEditorBridge;
      const st = await bridge.request('page.getState');
      const cloud = await window.connectElanLibrary(window.elanLibraryDataProvider);
      mediaList.replaceChildren();
      archiveList.replaceChildren();
      const addMedia = document.getElementById('addMedia');
      if (addMedia) addMedia.hidden = true;

      const mediaHeading = mediaList.previousElementSibling;
      if (mediaHeading && mediaHeading.tagName === 'H4') mediaHeading.textContent = 'وسائط المكتبة السحابية';
      const archiveHeading = archiveList.previousElementSibling;
      if (archiveHeading && archiveHeading.tagName === 'H4') archiveHeading.textContent = 'أرشيف الصفحة الحالية';
      const savedList = ensureSection(dialog, 'cloudSavedElements', 'العناصر المحفوظة سحابيًا', archiveHeading);
      savedList.replaceChildren();
      const cloudArchive = ensureSection(dialog, 'cloudArchiveItems', 'الأرشيف السحابي', dialog.querySelector('small'));
      cloudArchive.replaceChildren();

      let emptyMedia = null;
      const picker = document.createElement('button');
      picker.textContent = 'رفع صورة إلى المكتبة السحابية';
      mediaList.append(picker);
      const mediaInput = document.createElement('input');
      mediaInput.type = 'file';
      mediaInput.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
      mediaInput.hidden = true;
      mediaInput.onchange = async function () {
        const file = mediaInput.files && mediaInput.files[0];
        mediaInput.value = '';
        if (!file) return;
        const provider = window.elanLibraryDataProvider;
        if (!provider || typeof provider.uploadMedia !== 'function') {
          setCloudMessage(dialog, 'رفع الصور السحابي غير مهيأ في هذه الجلسة.');
          return;
        }
        picker.disabled = true;
        try {
          const uploaded = await provider.uploadMedia(file, { category: 'general' });
          if (!uploaded || !safeMediaUrl(uploaded.src) || !/^image(?:\/|$)/i.test(String(uploaded.type || ''))) throw new Error('استجابة رفع الصورة غير صالحة.');
          const record = { ...uploaded, name: String(uploaded.name || file.name || 'صورة') };
          if (emptyMedia) emptyMedia.remove();
          const row = renderMediaRow(record);
          mediaList.insertBefore(row, mediaInput);
          setCloudMessage(dialog, 'تم تأكيد رفع الصورة إلى المكتبة السحابية. لم تُطبّق على الصفحة ولم يُحفظ أو يُنشر التصميم.');
        } catch (error) {
          setCloudMessage(dialog, error.message || 'تعذر رفع الصورة إلى المكتبة السحابية.');
        } finally {
          picker.disabled = false;
        }
      };
      picker.onclick = function () { mediaInput.click(); };
      mediaList.append(mediaInput);

      const selectedId = st && st.selected && st.selected.id || null;
      const mediaRows = Array.isArray(cloud.media) ? cloud.media.filter((item) => item && item.src) : [];
      function renderMediaRow(item) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:8px 0;padding:8px;border:1px solid #e5dcc5;border-radius:8px';
        if (safeMediaUrl(item.src) && /^image(?:\/|$)/i.test(String(item.type || ''))) {
          const preview = document.createElement('img');
          preview.src = item.src;
          preview.alt = String(item.name || 'وسيط محفوظ');
          preview.loading = 'lazy';
          preview.referrerPolicy = 'no-referrer';
          preview.style.cssText = 'width:64px;height:52px;object-fit:cover;border-radius:5px';
          row.append(preview);
        }
        const label = document.createElement('span');
        label.textContent = [item.name || item.id || 'وسيط', item.type || ''].filter(Boolean).join(' · ');
        label.style.cssText = 'flex:1;overflow-wrap:anywhere';
        row.append(label);
        const use = document.createElement('button');
        use.textContent = selectedId && safeMediaUrl(item.src) ? 'استخدام للعنصر المحدد' : 'حددي عنصرًا أولًا';
        use.disabled = !selectedId || !safeMediaUrl(item.src);
        use.onclick = async function () {
          try {
            await bridge.request('element.setMedia', { elementId: selectedId, src: item.src });
            setCloudMessage(dialog, 'تم تطبيق الوسيط على المعاينة فقط؛ اضغطي «حفظ» لنشره.');
          } catch (error) {
            setCloudMessage(dialog, error.message || 'تعذر تطبيق الوسيط على العنصر.');
          }
        };
        row.append(use);
        return row;
      }
      if (!mediaRows.length) {
        emptyMedia = document.createElement('p');
        emptyMedia.textContent = 'لا توجد وسائط محفوظة في المكتبة السحابية.';
        mediaList.append(emptyMedia);
      }
      mediaRows.forEach((item) => mediaList.insertBefore(renderMediaRow(item), mediaInput));

      const savedRows = Array.isArray(cloud.savedElements) ? cloud.savedElements : [];
      if (!savedRows.length) {
        const empty = document.createElement('p');
        empty.textContent = 'لا توجد عناصر محفوظة سحابيًا حتى الآن.';
        savedList.append(empty);
      }
      savedRows.forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0';
        const label = document.createElement('span');
        label.textContent = [item.name || 'عنصر', item.kind || 'عام', item.category || ''].filter(Boolean).join(' · ');
        label.style.flex = '1';
        row.append(label);
        const insert = document.createElement('button');
        const canInsert = supportedBlock(item.payload);
        insert.textContent = canInsert ? 'إدراج في المعاينة' : 'غير قابل للإدراج هنا';
        insert.disabled = !canInsert;
        insert.onclick = async function () {
          try {
            await bridge.request('library.insert', { payload: item.payload });
            setCloudMessage(dialog, 'أُدرج العنصر في المعاينة فقط. اضغطي «حفظ» لنشره إلى المتجر.');
          } catch (error) {
            setCloudMessage(dialog, error.message || 'تعذر إدراج العنصر المحفوظ.');
          }
        };
        row.append(insert);
        savedList.append(row);
      });

      const pageArchive = Array.isArray(st && st.archive) ? st.archive : [];
      const pageArchiveIds = new Set(pageArchive.map((item) => String(item.id)));
      const activeBlockIds = new Set((st && st.design && Array.isArray(st.design.blocks) ? st.design.blocks : []).map((block) => String(block.id)));
      if (!pageArchive.length) archiveList.textContent = 'أرشيف الصفحة فارغ.';
      pageArchive.forEach((item) => {
        const button = document.createElement('button');
        button.textContent = 'استرجاع: ' + (item.name || item.id);
        button.onclick = async function () {
          try { await bridge.request('archive.restore', { elementId: item.id }); dialog.close(); }
          catch (error) { setCloudMessage(dialog, error.message || 'تعذر استرجاع العنصر.'); }
        };
        archiveList.append(button);
      });

      const cloudRows = Array.isArray(cloud.archive) ? cloud.archive : [];
      if (!cloudRows.length) cloudArchive.textContent = 'الأرشيف السحابي فارغ.';
      cloudRows.forEach((item) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:7px 0';
        const label = document.createElement('span');
        label.textContent = [item.name || item.element_id || 'عنصر', item.kind || 'عام', item.archived_at || ''].filter(Boolean).join(' · ');
        label.style.flex = '1';
        row.append(label);
        const restore = document.createElement('button');
        const cloudBlock = blockFromPayload(item.payload);
        const canRestore = pageArchiveIds.has(String(item.element_id)) || (supportedBlock(item.payload) && cloudBlock.id === item.element_id && !activeBlockIds.has(String(item.element_id)));
        restore.textContent = canRestore ? 'استعادة للمعاينة' : 'غير متاح في هذه الصفحة';
        restore.disabled = !canRestore;
        restore.onclick = async function () {
          try {
            await bridge.request('archive.restore', { elementId: item.element_id, payload: item.payload });
            setCloudMessage(dialog, 'أُعيد العنصر إلى المعاينة فقط. اضغطي «حفظ» لنشره.');
          } catch (error) {
            setCloudMessage(dialog, error.message || 'تعذر استعادة العنصر المؤرشف.');
          }
        };
        row.append(restore);
        cloudArchive.append(row);
      });

      const note = dialog.querySelector('small');
      if (note) note.textContent = 'الرفع والحفظ في المكتبة السحابية منفصلان عن تصميم الصفحة. الإدراج أو الاستعادة يغيّران المعاينة فقط حتى تضغطي «حفظ».';
      const title = dialog.querySelector('h3');
      if (title) title.textContent = 'المكتبة السحابية والأرشيف';
      setCloudMessage(dialog, 'اتصال القراءة ناجح · وسائط: ' + mediaRows.length + ' · عناصر محفوظة: ' + savedRows.length + ' · مراجعة المكتبة: ' + cloud.revision.slice(0, 12));
      if (!dialog.open) dialog.showModal();
    } catch (error) {
      setCloudMessage(dialog, error.message || 'تعذر تحميل المكتبة السحابية.');
      if (!dialog.open) dialog.showModal();
    }
  };
})();
