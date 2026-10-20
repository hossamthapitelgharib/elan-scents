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

  /* Messages for the codes /api/editor-data answers with when image generation is refused or fails. */
  const AI_MESSAGES = {
    ai_not_configured: 'التوليد غير مُفعّل: لم يُضبط مفتاح الخدمة على الخادم.',
    cost_confirmation_required: 'وافقي على احتساب التكلفة أولًا.',
    invalid_ai_prompt: 'الوصف غير صالح (من 3 إلى 1000 حرف).',
    invalid_ai_size: 'مقاس الصورة غير مدعوم.',
    ai_daily_limit_reached: 'تم الوصول إلى الحد الأقصى لعدد الصور خلال 24 ساعة.',
    ai_rate_limited: 'خدمة التوليد مشغولة الآن. حاولي بعد قليل.',
    ai_prompt_rejected: 'رفضت الخدمة هذا الوصف. غيّريه وحاولي مرة أخرى.',
    ai_not_authorized: 'مفتاح خدمة التوليد المضبوط على الخادم غير صالح.',
    ai_provider_unreachable: 'تعذر الاتصال بخدمة التوليد.',
    ai_provider_failed: 'لم تُرجع خدمة التوليد صورة صالحة.',
    ai_invalid_response: 'استجابة التوليد غير صالحة؛ لم تُضف صورة.',
    upload_failed: 'تعذر حفظ الصورة المولّدة في المكتبة.',
    storage_unreachable: 'تعذر حفظ الصورة المولّدة في المكتبة.',
    library_record_failed: 'تعذر تسجيل الصورة المولّدة في المكتبة.',
    data_provider_failed: 'تعذر الاتصال بقاعدة البيانات.'
  };

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

      /* AI image generation. Off until the server has a key; every image needs the owner's explicit cost
         confirmation; the result only lands in the library, it is never applied to the page automatically. */
      const aiBox = document.createElement('div');
      aiBox.dataset.aiBox = 'true';
      aiBox.style.cssText = 'display:grid;gap:8px;margin:10px 0;padding:10px;border:1px solid #e5dcc5;border-radius:8px';
      const aiTitle = document.createElement('strong');
      aiTitle.textContent = 'توليد صورة بالذكاء الاصطناعي';
      /* A <span>, not <small>: the dialog's own note is found with dialog.querySelector('small'). */
      const aiState = document.createElement('span');
      aiState.style.cssText = 'font-size:11px;line-height:1.7;color:#846631';
      aiState.textContent = 'جارٍ قراءة حالة الخدمة…';
      const aiPrompt = document.createElement('textarea');
      aiPrompt.rows = 3;
      aiPrompt.maxLength = 1000;
      aiPrompt.placeholder = 'صفي الصورة المطلوبة';
      aiPrompt.setAttribute('aria-label', 'وصف الصورة المطلوبة');
      aiPrompt.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid #d9cfb7;border-radius:7px;font:inherit';
      const aiConfirmLabel = document.createElement('label');
      aiConfirmLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px';
      const aiConfirm = document.createElement('input');
      aiConfirm.type = 'checkbox';
      aiConfirmLabel.append(aiConfirm, 'أوافق على احتساب تكلفة هذه الصورة على حساب خدمة التوليد الخاص بالموقع');
      const aiGo = document.createElement('button');
      aiGo.textContent = 'توليد الصورة';
      aiBox.append(aiTitle, aiState, aiPrompt, aiConfirmLabel, aiGo);
      mediaList.insertBefore(aiBox, mediaInput);

      function aiEnabled(on) { aiPrompt.disabled = !on; aiConfirm.disabled = !on; aiGo.disabled = !on; }
      async function refreshAiStatus() {
        aiEnabled(false);
        const provider = window.elanLibraryDataProvider;
        if (!provider || typeof provider.getAiStatus !== 'function' || typeof provider.generateImage !== 'function') {
          aiState.textContent = 'توليد الصور غير متاح في هذه الجلسة.';
          return;
        }
        try {
          const status = await provider.getAiStatus();
          if (!status || status.configured !== true) { aiState.textContent = 'التوليد غير مُفعّل: لم يُضبط مفتاح الخدمة على الخادم بعد.'; return; }
          if (!(status.remaining > 0)) { aiState.textContent = 'تم الوصول إلى الحد الأقصى (' + status.dailyLimit + ' صورة كل 24 ساعة).'; return; }
          aiState.textContent = 'المتاح الآن: ' + status.remaining + ' من ' + status.dailyLimit + ' صورة كل 24 ساعة.';
          aiEnabled(true);
        } catch (_) {
          aiState.textContent = 'تعذر قراءة حالة توليد الصور.';
        }
      }
      aiGo.onclick = async function () {
        const prompt = aiPrompt.value.trim();
        if (prompt.length < 3) { setCloudMessage(dialog, 'اكتبي وصفًا للصورة (3 أحرف على الأقل).'); return; }
        if (!aiConfirm.checked) { setCloudMessage(dialog, AI_MESSAGES.cost_confirmation_required); return; }
        aiEnabled(false);
        setCloudMessage(dialog, 'جارٍ توليد الصورة… قد يستغرق ذلك حتى دقيقتين.');
        try {
          const item = await window.elanLibraryDataProvider.generateImage(prompt, { confirmCost: true });
          if (!item || !safeMediaUrl(item.src) || !/^image(?:\/|$)/i.test(String(item.type || ''))) throw new Error('ai_invalid_response');
          if (emptyMedia) emptyMedia.remove();
          mediaList.insertBefore(renderMediaRow({ ...item, name: String(item.name || 'صورة مولّدة') }), aiBox.nextSibling);
          aiConfirm.checked = false;
          aiPrompt.value = '';
          setCloudMessage(dialog, 'تم توليد الصورة وحفظها في المكتبة. لم تُطبّق على الصفحة ولم يُحفظ أو يُنشر التصميم.');
        } catch (error) {
          setCloudMessage(dialog, AI_MESSAGES[error && error.message] || 'تعذر توليد الصورة.');
        }
        refreshAiStatus();
      };
      refreshAiStatus();

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
