/* Read-only cloud-library browser for the live editor. Design changes happen only after an explicit item action. */
(function () {
  'use strict';

  /* ---------- Library model: sections, comparison with the cloud, and the safe transfer of the old browser-only library ----------
     Pure functions (no DOM) so the same code is exercised by tests/editor-library-sections.test.js. The cloud library is only ever merged into:
     nothing here deletes a cloud row, and nothing deletes the local copy unless clearLocalLibrary() is called by an explicit owner action
     after the transfer was read back and confirmed. */
  var CATEGORIES = [['section', 'سيكشن'], ['brand', 'براند'], ['store', 'متجر'], ['perfume', 'عطر'], ['banner', 'بانر'], ['text', 'نص'], ['hero', 'هيرو'], ['image', 'صورة'], ['video', 'فيديو'], ['occasion', 'مناسبة'], ['note', 'نوتة عطرية'], ['text_block', 'كتلة نصية']];
  var CATEGORY_KEYS = CATEGORIES.map(function (c) { return c[0]; });
  var LOCAL_STORAGE_KEY = 'elan-fresh-editor-v1';
  var LEDGER_KEY = 'elan-library-transfer-v1';
  var LEGACY_PREFIX = 'legacy-local:';
  var BATCH_CHARS = 600000; // the server refuses more than 800000 characters per save

  function blockFromPayload(payload) {
    return payload && payload.format === 'elan-element-v1' ? payload.element : payload;
  }

  function categoryKey(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase().replace(/-card$/, '').replace(/[-\s]+/g, '_');
    if (s === 'product') s = 'perfume';
    return CATEGORY_KEYS.indexOf(s) >= 0 ? s : '';
  }

  /* The section an item belongs to: the saved category first, then its kind, then the kind or type of the block inside it. */
  function categoryOf(item) {
    if (!item || typeof item !== 'object') return 'other';
    var block = blockFromPayload(item.payload);
    var guesses = [item.category, item.kind, block && block.kind, block && block.type, item.type, item.mediaType];
    for (var i = 0; i < guesses.length; i += 1) { var key = categoryKey(guesses[i]); if (key) return key; }
    return 'other';
  }

  function categoryOfElementId(id) {
    var s = String(id || '');
    if (s === 'hero') return 'hero';
    if (/^sec:/.test(s)) return 'section';
    if (/^brand:/.test(s)) return 'brand';
    if (/^store:/.test(s)) return 'store';
    if (/^prod:/.test(s)) return 'perfume';
    if (/^col:occ/.test(s)) return 'occasion';
    if (/^col:notes/.test(s)) return 'note';
    return 'other';
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce(function (out, key) { out[key] = canonical(value[key]); return out; }, {});
  }
  function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
  function bounded(value, fallback, max) { return String(value == null ? fallback : value).trim().slice(0, max); }
  function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

  /* The row the server stores for a saved element / archived element (mirrors normalizeSaved / normalizeArchive in railway/editor-data.js). */
  function savedRow(item) {
    return { name: bounded(item.name || item.id, 'عنصر', 300) || 'عنصر', kind: bounded(item.kind, 'element', 80) || 'element', category: item.category == null ? null : (bounded(item.category, '', 100) || null), payload: plainObject(item.payload) ? item.payload : item };
  }
  function archiveRow(item) {
    return { element_id: bounded(item.element_id || '', '', 200), kind: bounded(item.kind, 'element', 80) || 'element', name: item.name == null ? null : (bounded(item.name, '', 300) || null), payload: plainObject(item.payload) ? item.payload : item };
  }
  function hasRow(rows, row, make) { return rows.some(function (x) { return same(make(x), row); }); }

  function readJson(storage, key) {
    try { var raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }

  /* What the old browser-only editor kept in this browser: saved elements, deleted elements (archive) and media (data URLs). */
  function readLocalLibrary(storage) {
    var state = readJson(storage, LOCAL_STORAGE_KEY);
    if (!plainObject(state)) return { present: false, saved: [], archive: [], media: [] };
    var list = function (v) { return Array.isArray(v) ? v.filter(plainObject) : []; };
    var local = { present: false, saved: list(state.savedElements), archive: list(state.archive), media: list(state.media) };
    local.present = local.saved.length + local.archive.length + local.media.length > 0;
    return local;
  }

  function localSavedItem(item) {
    var text = typeof item.text === 'string' ? item.text.slice(0, 35) : '';
    return { name: item.name || text || 'عنصر محلي', kind: bounded(item.kind || item.type, 'element', 80) || 'element', category: categoryOf(item), payload: item };
  }
  function localArchiveItem(item) {
    var text = typeof item.text === 'string' ? item.text.slice(0, 35) : '';
    return { element_id: LEGACY_PREFIX + String(item.id || text || 'item'), kind: bounded(item.kind || item.type, 'element', 80) || 'element', name: item.name || text || null, payload: item };
  }

  function isDataMedia(value) { return typeof value === 'string' && /^data:(image|video)\//i.test(value); }

  /* Copy of a value with every embedded picture/video data URL replaced by what `swap(dataUrl)` returns; it throws when a swap fails. */
  async function replaceDataUrls(value, swap) {
    if (isDataMedia(value)) return swap(value);
    if (Array.isArray(value)) { var list = []; for (var i = 0; i < value.length; i += 1) list.push(await replaceDataUrls(value[i], swap)); return list; }
    if (plainObject(value)) { var out = {}; for (var key of Object.keys(value)) out[key] = await replaceDataUrls(value[key], swap); return out; }
    return value;
  }

  function dataUrlToFile(dataUrl, name) {
    var m = /^data:([^;,]+)((?:;[^;,]+)*?),([\s\S]*)$/i.exec(dataUrl);
    if (!m) throw new Error('data_url_invalid');
    var type = m[1].toLowerCase(), base64 = /;base64/i.test(m[2]);
    var binary = base64 ? atob(m[3]) : decodeURIComponent(m[3]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], name || (type.indexOf('video') === 0 ? 'video' : 'image'), { type: type });
  }

  /* Splits rows into saves that stay under the server's size limit; a row that is too big alone is reported, never cut. */
  function planBatches(archiveRows, savedRows, maxChars) {
    var limit = maxChars || BATCH_CHARS, batches = [], current = { archive: [], savedElements: [] }, size = 0, tooLarge = [];
    function push(kind, row) {
      var len = JSON.stringify(row).length;
      if (len > limit) { tooLarge.push({ kind: kind, row: row }); return; }
      if (size + len > limit && (current.archive.length || current.savedElements.length)) { batches.push(current); current = { archive: [], savedElements: [] }; size = 0; }
      current[kind === 'archive' ? 'archive' : 'savedElements'].push(row); size += len;
    }
    archiveRows.forEach(function (row) { push('archive', row); });
    savedRows.forEach(function (row) { push('saved', row); });
    if (current.archive.length || current.savedElements.length) batches.push(current);
    return { batches: batches, tooLarge: tooLarge };
  }

  function readLedger(storage) { var ledger = readJson(storage, LEDGER_KEY); return plainObject(ledger) ? ledger : {}; }
  function writeLedger(storage, ledger) { try { storage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch (_) { /* the transfer still works, only the resume note is lost */ } }

  /* Counts for the library box: how much the old local library holds, and how much of it the cloud does not have yet. */
  async function describeLocal(local, cloud, storage, sha256) {
    var ledger = readLedger(storage), cloudMedia = (cloud && cloud.media || []).map(function (m) { return m.src; });
    /* Compare what the transfer would send: embedded pictures already uploaded are swapped for their addresses first. */
    async function viaLedger(item) { return replaceDataUrls(item, async function (dataUrl) { return ledger[await sha256(dataUrl)] || dataUrl; }); }
    var pendingSaved = 0, pendingArchive = 0;
    for (var si = 0; si < local.saved.length; si += 1) { if (!hasRow(cloud.savedElements || [], savedRow(localSavedItem(await viaLedger(local.saved[si]))), savedRow)) pendingSaved += 1; }
    for (var ai = 0; ai < local.archive.length; ai += 1) { if (!hasRow(cloud.archive || [], archiveRow(localArchiveItem(await viaLedger(local.archive[ai]))), archiveRow)) pendingArchive += 1; }
    var pendingMedia = 0;
    for (var i = 0; i < local.media.length; i += 1) {
      var src = local.media[i].src;
      if (typeof src !== 'string') { pendingMedia += 1; continue; }
      if (!isDataMedia(src)) continue; // already an address
      var known = ledger[await sha256(src)];
      if (!(known && cloudMedia.indexOf(known) >= 0)) pendingMedia += 1;
    }
    return { saved: local.saved.length, archive: local.archive.length, media: local.media.length, pending: pendingSaved + pendingArchive + pendingMedia, pendingSaved: pendingSaved, pendingArchive: pendingArchive, pendingMedia: pendingMedia };
  }

  /* The transfer. deps: { provider: {getLibrary, saveLibrary}, storage, uploadFile(file) -> url, sha256(text) -> hex, onProgress(text) }.
     Re-running it is safe: rows already in the cloud are skipped, uploaded pictures are remembered by their hash, and nothing is deleted anywhere. */
  async function syncLocal(deps) {
    var report = { present: false, uploaded: 0, reusedMedia: 0, alreadyThere: 0, sent: 0, failed: [], verified: false, nothingToDo: false };
    var say = deps.onProgress || function () {};
    var local = readLocalLibrary(deps.storage);
    report.present = local.present;
    if (!local.present) { report.nothingToDo = true; report.verified = true; return report; }
    say('قراءة المكتبة السحابية…');
    var cloud = await deps.provider.getLibrary();
    var ledger = readLedger(deps.storage), uploadedUrls = [], fresh = {};

    async function urlFor(dataUrl, name) {
      var sig = await deps.sha256(dataUrl);
      var known = fresh[sig] || ledger[sig];
      if (known && (fresh[sig] || (cloud.media || []).some(function (m) { return m.src === known; }))) { if (!fresh[sig]) report.reusedMedia += 1; uploadedUrls.push(known); return known; }
      var file = dataUrlToFile(dataUrl, name);
      say('رفع ' + (name || 'ملف') + '…');
      var url = await deps.uploadFile(file);
      if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('upload_failed');
      ledger[sig] = url; fresh[sig] = url; writeLedger(deps.storage, ledger);
      report.uploaded += 1; uploadedUrls.push(url);
      return url;
    }

    for (var mi = 0; mi < local.media.length; mi += 1) {
      var m = local.media[mi];
      if (!isDataMedia(m.src)) continue;
      try { await urlFor(m.src, String(m.name || 'media')); }
      catch (e) { report.failed.push({ what: 'media', name: String(m.name || 'وسيط'), reason: e && e.message || 'upload_failed' }); }
    }

    var archiveRows = [], savedRows = [];
    async function prepare(item, make, rowOf, list, rows, kind) {
      var name = item.name || (typeof item.text === 'string' ? item.text.slice(0, 35) : '') || String(item.id || '');
      try {
        var swapped = await replaceDataUrls(item, function (dataUrl) { return urlFor(dataUrl, String(item.name || kind)); });
        var built = make(swapped);
        if (hasRow(list, rowOf(built), rowOf)) { report.alreadyThere += 1; return; }
        rows.push(built);
      } catch (e) { report.failed.push({ what: kind, name: name, reason: e && e.message || 'failed' }); }
    }
    for (var si = 0; si < local.saved.length; si += 1) await prepare(local.saved[si], localSavedItem, savedRow, cloud.savedElements || [], savedRows, 'saved');
    for (var ai = 0; ai < local.archive.length; ai += 1) await prepare(local.archive[ai], localArchiveItem, archiveRow, cloud.archive || [], archiveRows, 'archive');

    var plan = planBatches(archiveRows, savedRows);
    plan.tooLarge.forEach(function (entry) { report.failed.push({ what: entry.kind, name: String(entry.row.name || entry.row.element_id || ''), reason: 'too_large' }); });
    var revision = cloud.revision;
    for (var bi = 0; bi < plan.batches.length; bi += 1) {
      say('حفظ الدفعة ' + (bi + 1) + ' من ' + plan.batches.length + '…');
      var batch = plan.batches[bi], result;
      try { result = await deps.provider.saveLibrary(batch, revision); }
      catch (e) {
        if (!/revision_conflict/.test(String(e && e.message))) { batch.archive.concat(batch.savedElements).forEach(function (row) { report.failed.push({ what: 'batch', name: String(row.name || row.element_id || ''), reason: e && e.message || 'save_failed' }); }); continue; }
        revision = (await deps.provider.getLibrary()).revision;
        try { result = await deps.provider.saveLibrary(batch, revision); }
        catch (e2) { batch.archive.concat(batch.savedElements).forEach(function (row) { report.failed.push({ what: 'batch', name: String(row.name || row.element_id || ''), reason: e2 && e2.message || 'save_failed' }); }); continue; }
      }
      if (result && typeof result.revision === 'string') revision = result.revision;
      report.sent += batch.archive.length + batch.savedElements.length;
    }

    /* Read it back: only what the cloud now really holds counts as transferred. */
    say('التأكد من النقل…');
    var after = await deps.provider.getLibrary();
    var missing = 0;
    savedRows.forEach(function (row) { if (!hasRow(after.savedElements || [], savedRow(row), savedRow)) missing += 1; });
    archiveRows.forEach(function (row) { if (!hasRow(after.archive || [], archiveRow(row), archiveRow)) missing += 1; });
    uploadedUrls.forEach(function (url) { if (!(after.media || []).some(function (x) { return x.src === url; })) missing += 1; });
    report.missingAfterSave = missing;
    report.verified = missing === 0 && report.failed.length === 0;
    return report;
  }

  /* Explicit owner action, offered only after a verified transfer: empties the three local library lists (the rest of the old editor state stays). */
  function clearLocalLibrary(storage) {
    var state = readJson(storage, LOCAL_STORAGE_KEY);
    if (!plainObject(state)) return false;
    state.savedElements = []; state.archive = []; state.media = [];
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
    return true;
  }

  var model = { CATEGORIES: CATEGORIES, categoryOf: categoryOf, categoryOfElementId: categoryOfElementId, canonical: canonical, same: same, savedRow: savedRow, archiveRow: archiveRow, readLocalLibrary: readLocalLibrary, localSavedItem: localSavedItem, localArchiveItem: localArchiveItem, describeLocal: describeLocal, planBatches: planBatches, replaceDataUrls: replaceDataUrls, dataUrlToFile: dataUrlToFile, syncLocal: syncLocal, clearLocalLibrary: clearLocalLibrary, LOCAL_STORAGE_KEY: LOCAL_STORAGE_KEY, LEDGER_KEY: LEDGER_KEY, LEGACY_PREFIX: LEGACY_PREFIX };
  if (typeof window !== 'undefined') window.ElanLibraryModel = model;
  if (typeof module === 'object' && module && module.exports) module.exports = model;

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

  /* ---------- Library window chrome: the two explicit buttons, the section tabs and the old local library box ---------- */
  var activeCategory = 'all';
  var forcedNote = '';

  function make(tag, text, css) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (css) node.style.cssText = css;
    return node;
  }

  async function sha256Hex(text) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function uploadFile(file) {
    if (typeof window.elanUploadMediaFile === 'function') return window.elanUploadMediaFile(file);
    var provider = window.elanLibraryDataProvider;
    if (provider && typeof provider.uploadMedia === 'function' && /^image\//.test(file.type)) return provider.uploadMedia(file, { category: 'general' }).then(function (r) { return r.src; });
    return Promise.reject(new Error('upload_unavailable'));
  }

  var REASONS = { too_large: 'أكبر من الحد المسموح', upload_failed: 'تعذر الرفع', upload_unavailable: 'الرفع غير متاح', library_revision_conflict: 'تغيّرت المكتبة أثناء الحفظ', data_url_invalid: 'الملف غير صالح' };

  function summarizeSync(report) {
    if (report.nothingToDo) return 'لا توجد مكتبة محلية قديمة في هذا المتصفح، ولا تغييرات معلّقة. كل شيء متزامن.';
    var parts = ['نُقل ' + report.sent + ' عنصر إلى سابابيس'];
    if (report.uploaded) parts.push('ورُفع ' + report.uploaded + ' ملف وسائط');
    if (report.alreadyThere || report.reusedMedia) parts.push('وكان ' + (report.alreadyThere + report.reusedMedia) + ' موجودًا مسبقًا');
    var text = parts.join('، ') + '.';
    if (report.failed.length) {
      text += ' تعذّر نقل ' + report.failed.length + ': ' + report.failed.slice(0, 3).map(function (f) { return f.name + ' (' + (REASONS[f.reason] || f.reason) + ')'; }).join('، ') + '.';
    }
    text += report.verified
      ? ' تأكدنا من النقل بقراءة المكتبة بعد الحفظ، ولم يُحذف شيء محليًا.'
      : ' لم يكتمل التأكيد، لذلك بقيت النسخة المحلية كما هي ويمكن إعادة المزامنة.';
    return text;
  }

  function downloadLocalBackup(local) {
    var blob = new Blob([JSON.stringify({ format: 'elan-local-library-backup-v1', savedElements: local.saved, archive: local.archive, media: local.media }, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'elan-local-library-backup.json';
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function applyCategoryFilter(dialog) {
    var rows = dialog.querySelectorAll('[data-cat]'), shown = 0;
    rows.forEach(function (row) {
      if (row.dataset.d === undefined) row.dataset.d = row.style.display || '';
      var visible = activeCategory === 'all' || row.dataset.cat === activeCategory;
      row.style.display = visible ? row.dataset.d : 'none';
      if (visible) shown += 1;
    });
    var empty = dialog.querySelector('[data-lib-empty]');
    if (empty) {
      var label = activeCategory === 'all' ? '' : (CATEGORIES.filter(function (c) { return c[0] === activeCategory; })[0] || ['', 'هذا القسم'])[1];
      empty.textContent = shown || activeCategory === 'all' ? '' : 'لا توجد عناصر في قسم «' + label + '» بعد.';
      empty.style.display = empty.textContent ? '' : 'none';
    }
  }

  function buildTabs(dialog) {
    var old = dialog.querySelector('[data-lib-tabs]');
    var tabs = old || make('div', '', 'display:flex;flex-wrap:wrap;gap:6px;margin:10px 0');
    tabs.dataset.libTabs = 'true'; tabs.dataset.libChrome = 'true';
    tabs.replaceChildren();
    var counts = {}, total = 0;
    dialog.querySelectorAll('[data-cat]').forEach(function (row) { counts[row.dataset.cat] = (counts[row.dataset.cat] || 0) + 1; total += 1; });
    var entries = [['all', 'الكل']].concat(CATEGORIES);
    if (counts.other) entries.push(['other', 'أخرى']);
    entries.forEach(function (entry) {
      var count = entry[0] === 'all' ? total : (counts[entry[0]] || 0);
      var button = make('button', entry[1] + ' (' + count + ')', 'padding:5px 10px;border:1px solid #d9cfb7;border-radius:999px;background:' + (activeCategory === entry[0] ? '#e8d6ad' : '#fff') + ';font:inherit;font-size:12px;cursor:pointer');
      button.type = 'button'; button.dataset.libCat = entry[0];
      button.setAttribute('aria-pressed', activeCategory === entry[0] ? 'true' : 'false');
      button.onclick = function () { activeCategory = entry[0]; buildTabs(dialog); };
      tabs.append(button);
    });
    if (!old) { var anchor = dialog.querySelector('[data-lib-toolbar]'); dialog.insertBefore(tabs, anchor ? anchor.nextSibling : null); }
    applyCategoryFilter(dialog);
  }

  async function buildChrome(dialog, cloud, defaultNote) {
    dialog.querySelectorAll('[data-lib-chrome]').forEach(function (node) { node.remove(); });
    var title = dialog.querySelector('h3'), after = title ? title.nextSibling : dialog.firstChild;
    var bar = make('div', '', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0');
    bar.dataset.libToolbar = 'true'; bar.dataset.libChrome = 'true';
    var load = make('button', 'تحميل المكتبة من سابابيس'), sync = make('button', 'مزامنة التغييرات');
    load.type = sync.type = 'button'; load.dataset.libAction = 'load'; sync.dataset.libAction = 'sync';
    var status = make('span', forcedNote || defaultNote, 'flex:1 1 100%;font-size:12px;line-height:1.8;color:#846631');
    status.dataset.libStatus = 'true';
    forcedNote = '';
    bar.append(load, sync, status);
    dialog.insertBefore(bar, after);

    load.onclick = async function () {
      load.disabled = sync.disabled = true; status.textContent = 'جارٍ تحميل المكتبة من سابابيس…';
      await window.openLiveLibrary();
    };
    sync.onclick = async function () {
      load.disabled = sync.disabled = true;
      try {
        var report = await model.syncLocal({ provider: window.elanLibraryDataProvider, storage: window.localStorage, uploadFile: uploadFile, sha256: sha256Hex, onProgress: function (text) { status.textContent = text; } });
        forcedNote = summarizeSync(report);
      } catch (error) {
        forcedNote = 'تعذرت المزامنة (' + (error && error.message || 'خطأ') + '). لم يُحذف شيء، ويمكن المحاولة مرة أخرى.';
      }
      await window.openLiveLibrary();
    };

    if (!cloud) return; // the library could not be read: only the retry buttons and the message are shown
    var empty = make('p', '', 'font-size:12px;color:#846631;margin:4px 0');
    empty.dataset.libEmpty = 'true'; empty.dataset.libChrome = 'true'; empty.style.display = 'none';
    dialog.insertBefore(empty, after);
    var tabs = make('div'); tabs.dataset.libTabs = 'true'; tabs.dataset.libChrome = 'true';
    dialog.insertBefore(tabs, empty);

    var local = null;
    try { local = model.readLocalLibrary(window.localStorage); } catch (_) { local = null; }
    if (local && local.present) {
      var info = await model.describeLocal(local, cloud, window.localStorage, sha256Hex);
      var box = make('div', '', 'display:grid;gap:8px;margin:10px 0;padding:10px;border:1px solid #e5dcc5;border-radius:8px');
      box.dataset.libLocal = 'true'; box.dataset.libChrome = 'true';
      box.append(make('strong', 'مكتبة قديمة محفوظة في هذا المتصفح'));
      box.append(make('span', info.saved + ' عنصر محفوظ · ' + info.archive + ' عنصر مؤرشف · ' + info.media + ' ملف وسائط', 'font-size:12px;color:#846631'));
      box.append(make('span', info.pending
        ? 'لم يُنقل منها بعد: ' + info.pending + '. «مزامنة التغييرات» تنقلها إلى سابابيس بالدمج فقط، ولا تحذف أي شيء هنا أو هناك.'
        : 'كل ما فيها موجود الآن في سابابيس. يمكنك حذف النسخة المحلية بعد أخذ نسخة احتياطية.', 'font-size:12px;line-height:1.8'));
      var row = make('div', '', 'display:flex;gap:8px;flex-wrap:wrap');
      var backup = make('button', 'تنزيل نسخة احتياطية (JSON)');
      backup.type = 'button'; backup.dataset.libAction = 'backup';
      backup.onclick = function () { downloadLocalBackup(local); };
      var drop = make('button', 'حذف النسخة المحلية القديمة');
      drop.type = 'button'; drop.dataset.libAction = 'clear-local'; drop.disabled = info.pending > 0;
      drop.title = info.pending > 0 ? 'يتاح بعد نقل كل شيء إلى سابابيس وتأكيده' : '';
      drop.onclick = async function () {
        if (!window.confirm('سيُحذف من هذا المتصفح فقط: العناصر المحفوظة والمؤرشفة والوسائط في المكتبة القديمة. المكتبة في سابابيس لا تتأثر. هل أنت متأكد؟')) return;
        model.clearLocalLibrary(window.localStorage);
        forcedNote = 'تم حذف المكتبة المحلية القديمة من هذا المتصفح. المكتبة في سابابيس كما هي.';
        await window.openLiveLibrary();
      };
      row.append(backup, drop);
      box.append(row);
      dialog.insertBefore(box, after);
    }
    buildTabs(dialog);
  }

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
          buildTabs(dialog);
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
          buildTabs(dialog);
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
        row.dataset.cat = categoryOf(item);
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
        row.dataset.cat = categoryOf(item);
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
        button.dataset.cat = categoryOfElementId(item.id);
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
        row.dataset.cat = categoryOf(item);
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
      await buildChrome(dialog, cloud, 'تم تحميل المكتبة من سابابيس · وسائط: ' + mediaRows.length + ' · عناصر محفوظة: ' + savedRows.length + ' · أرشيف: ' + cloudRows.length);
      if (!dialog.open) dialog.showModal();
    } catch (error) {
      setCloudMessage(dialog, error.message || 'تعذر تحميل المكتبة السحابية.');
      try { await buildChrome(dialog, null, 'تعذر تحميل المكتبة من سابابيس: ' + (error && error.message || 'خطأ') + '. اضغط «تحميل المكتبة من سابابيس» للمحاولة مرة أخرى.'); } catch (_) { /* the message above is enough */ }
      if (!dialog.open) dialog.showModal();
    }
  };
})();
