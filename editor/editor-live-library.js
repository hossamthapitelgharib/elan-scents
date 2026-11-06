/* Élan Editor — the library window of the live editor.
   Same window as the original editor's library: title, the two tabs, the twelve section buttons in a 3-column grid, the section heading,
   one row per item, the upload button with its note, "إغلاق", the load/sync buttons and the message line. What is shown comes from the
   platform page (its archive) and from the cloud library (media, saved elements, archive). Nothing here saves or publishes the page:
   inserting, restoring or using a picture changes the preview only, until the owner presses "حفظ". */
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

  /* ---------- the window ---------- */
  var libTab = 'archive', libCategory = 'section', forcedNote = '';
  var ACTIVE = '#e8d6ad';

  function make(tag, text, css) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (css) node.style.cssText = css;
    return node;
  }
  function libButton(text, fn) { var b = make('button', text); b.type = 'button'; b.onclick = fn; return b; }
  function labelOf(key) { var hit = CATEGORIES.filter(function (c) { return c[0] === key; })[0]; return hit ? hit[1] : key === 'other' ? 'أخرى' : ''; }
  function say(text) { if (typeof window.markBridge === 'function') window.markBridge(text); }

  async function sha256Hex(text) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function uploadFile(file, folder) {
    if (typeof window.elanUploadMediaFile === 'function') return window.elanUploadMediaFile(file, null, folder);
    var provider = window.elanLibraryDataProvider;
    if (provider && typeof provider.uploadMedia === 'function' && /^image\//.test(file.type)) return provider.uploadMedia(file, { category: folder || 'general' }).then(function (r) { return r.src; });
    return Promise.reject(new Error('upload_unavailable'));
  }

  /* An element file (the JSON this editor exports) becomes a saved element of the cloud library, in the folder it was uploaded from. */
  async function saveElementFile(file, folder, cloud) {
    var provider = window.elanLibraryDataProvider;
    if (!provider || typeof provider.saveLibrary !== 'function' || !cloud || !cloud.revision) throw new Error('upload_unavailable');
    if (file.size > 400000) throw new Error('too_large');
    var obj;
    try { obj = JSON.parse(await file.text()); } catch (_) { throw new Error('not_an_element_file'); }
    if (!obj || obj.format !== 'elan-element-v1' || !supportedBlock(obj)) throw new Error('not_an_element_file');
    var block = blockFromPayload(obj);
    var row = savedRow({ name: String(file.name || '').replace(/\.json$/i, '') || block.name || 'عنصر', kind: block.kind || block.type || 'element', category: folder, payload: obj });
    await provider.saveLibrary({ archive: [], savedElements: [row] }, cloud.revision);
  }

  var REASONS = { too_large: 'أكبر من الحد المسموح', upload_failed: 'تعذر الرفع', upload_unavailable: 'الرفع غير متاح', library_revision_conflict: 'تغيّرت المكتبة أثناء الحفظ', not_an_element_file: 'الملف ده مش ملف عنصر صادر من المحرر أو نوعه مش مدعوم', library_item_not_found: 'العنصر اتحذف قبل كده', library_delete_unconfirmed: 'الحذف ما اتأكدش', storage_delete_failed: 'تعذر مسح الملف من التخزين', invalid_library_id: 'العنصر ده ما لوش رقم في سابابيس', data_url_invalid: 'الملف غير صالح' };

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

  /* Everything the window lists, already placed in its section. */
  function collect(st, cloud) {
    var pageArchive = Array.isArray(st && st.archive) ? st.archive : [];
    var pageIds = new Set(pageArchive.map(function (item) { return String(item.id); }));
    var activeIds = new Set((st && st.design && Array.isArray(st.design.blocks) ? st.design.blocks : []).map(function (block) { return String(block.id); }));
    var archive = pageArchive.map(function (item) {
      return { section: categoryOfElementId(item.id), name: String(item.name || item.id), restore: { elementId: item.id }, can: true };
    });
    (cloud ? cloud.archive : []).forEach(function (item) {
      if (pageIds.has(String(item.element_id))) return;
      var block = blockFromPayload(item.payload);
      var can = supportedBlock(item.payload) && block.id === item.element_id && !activeIds.has(String(item.element_id));
      archive.push({ section: categoryOf(item), name: String(item.name || item.element_id || 'عنصر'), restore: { elementId: item.element_id, payload: item.payload }, can: can, cloud: { kind: 'archive', id: item.id } });
    });
    var saved = (cloud ? cloud.savedElements : []).map(function (item) {
      return { section: categoryOf(item), name: String(item.name || 'عنصر'), payload: item.payload, can: supportedBlock(item.payload), cloud: { kind: 'saved', id: item.id } };
    });
    var designText = ''; try { designText = JSON.stringify(st && st.design || ''); } catch (_) { designText = ''; }
    var media = (cloud ? cloud.media : []).filter(function (m) { return m && m.src; }).map(function (m) {
      var key = String(m.src).split('/site-media/')[1] || String(m.src);
      return { section: categoryOf(m), name: String(m.name || m.id || 'وسيط'), src: m.src, type: String(m.type || ''), can: safeMediaUrl(m.src), cloud: { kind: 'media', id: m.id }, draftUses: designText.indexOf(key) >= 0 };
    });
    return { archive: archive, saved: saved, media: media };
  }

  function row(list, entry, label, run, preview) {
    var box = make('div', '', 'display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #dfd0b3;border-radius:10px');
    if (preview && entry.can && /^image(?:\/|$)/i.test(entry.type)) {
      var img = make('img', '', 'width:60px;height:50px;object-fit:contain');
      img.src = entry.src; img.alt = entry.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      box.append(img);
    }
    var text = make('span', entry.name, 'flex:1');
    var act = libButton(label, run);
    act.disabled = !entry.can;
    box.append(text, act);
    /* «حذف نهائي» is on every row, as in the original window. A row that is not in the cloud library yet (an element archived on the page
       and not saved) has nothing to delete there, so its button is there but off. */
    var del = libButton('حذف نهائي', function () { return onDelete(entry); });
    del.style.color = '#a02222'; del.dataset.libAction = 'delete';
    if (!entry.cloud || !entry.cloud.id) { del.disabled = true; del.title = 'يُحذف نهائيًا بعد حفظ التصميم، وحين يظهر من مكتبة سابابيس'; }
    box.append(del);
    list.append(box);
  }

  /* What the owner is asked before a permanent delete, and told after it. A picture or video also goes from Storage when nothing uses it. */
  function askFor(entry) {
    return entry.cloud.kind === 'media'
      ? 'حذف هذا الوسيط نهائيًا من مكتبة سابابيس ومن التخزين؟ لو كان مستخدمًا في الموقع فسيبقى الملف نفسه كي لا تتكسر الصفحة. لا يمكن التراجع عن هذا الحذف.'
      : 'حذف هذا العنصر نهائيًا من مكتبة سابابيس؟ النسخ الموجودة في الصفحة لن تُحذف. لا يمكن التراجع عن هذا الحذف.';
  }
  function doneText(kind, result) {
    if (kind === 'media') {
      if (result && result.file === 'removed') return 'حُذف الوسيط نهائيًا من مكتبة سابابيس ومن التخزين.';
      var why = result && Array.isArray(result.keptBecause) && result.keptBecause.length ? ' لأنه مستخدم أو لم نتأكد من عدم استخدامه: ' + result.keptBecause.join('، ') : '';
      return 'حُذف الوسيط من المكتبة، لكن الملف نفسه باقٍ في التخزين' + why + '. شيلِه من مكانه ثم احذف الملف لو أردت مسحه نهائيًا.';
    }
    return kind === 'saved' ? 'حُذف العنصر المحفوظ نهائيًا من مكتبة سابابيس.' : 'حُذف العنصر المؤرشف نهائيًا من مكتبة سابابيس.';
  }
  async function onDelete(entry) {
    var provider = window.elanLibraryDataProvider;
    if (!entry.cloud || !provider || typeof provider.deleteItem !== 'function') return;
    if (!window.confirm(askFor(entry))) return;
    try {
      var result = await provider.deleteItem(entry.cloud.kind, entry.cloud.id, { draftUses: entry.draftUses === true });
      forcedNote = doneText(entry.cloud.kind, result);
    } catch (error) {
      forcedNote = 'تعذر الحذف: ' + (REASONS[error && error.message] || (error && error.message) || 'خطأ') + '. لم يُحذف شيء.';
    }
    await window.openLiveLibrary();
  }

  function setNote(dialog, text) {
    var message = dialog.querySelector('[data-cloud-message]');
    if (message) message.textContent = text;
  }

  async function paint(dialog, ctx) {
    var bridge = window.elanLiveEditorBridge;
    var data = collect(ctx.st, ctx.cloud);
    var selectedId = ctx.st && ctx.st.selected && ctx.st.selected.id || null;
    dialog.replaceChildren();
    dialog.style.width = '720px';
    dialog.append(make('h3', 'مكتبة إيلان'));

    var tabs = make('div', '', 'display:flex;gap:8px;margin-bottom:12px');
    [['archive', 'العناصر المحذوفة'], ['saved', 'الميديا والعناصر المحفوظة']].forEach(function (entry) {
      var b = libButton(entry[1], function () { libTab = entry[0]; paint(dialog, ctx); });
      b.dataset.libTab = entry[0];
      if (libTab === entry[0]) b.style.background = ACTIVE;
      tabs.append(b);
    });
    dialog.append(tabs);

    function inTab(key) {
      var pool = libTab === 'archive' ? data.archive : data.saved.concat(data.media);
      return pool.filter(function (x) { return x.section === key; }).length;
    }
    var keys = CATEGORIES.map(function (c) { return c[0]; });
    if (inTab('other')) keys.push('other');
    var folders = make('div', '', 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px');
    keys.forEach(function (key) {
      var b = libButton(labelOf(key) + ' (' + inTab(key) + ')', function () { libCategory = key; paint(dialog, ctx); });
      b.dataset.libCat = key;
      if (libCategory === key) b.style.background = ACTIVE;
      folders.append(b);
    });
    dialog.append(folders);
    if (keys.indexOf(libCategory) < 0) libCategory = 'section';

    var heading = make('h4', labelOf(libCategory));
    dialog.append(heading);
    var list = make('div', '', 'display:grid;gap:10px');
    list.dataset.libList = 'true';
    dialog.append(list);

    function applied(text) { dialog.close(); say(text); }
    function failed(error, fallback) { setNote(dialog, error && error.message || fallback); }

    if (libTab === 'archive') {
      data.archive.filter(function (x) { return x.section === libCategory; }).forEach(function (entry) {
        row(list, entry, 'استرجاع', async function () {
          try { await bridge.request('archive.restore', entry.restore); applied('أُعيد العنصر إلى المعاينة فقط. اضغطي «حفظ» لنشره.'); }
          catch (error) { failed(error, 'تعذر استرجاع العنصر.'); }
        });
      });
    } else {
      data.saved.filter(function (x) { return x.section === libCategory; }).forEach(function (entry) {
        row(list, entry, 'إضافة نسخة', async function () {
          try { await bridge.request('library.insert', { payload: entry.payload }); applied('أُدرج العنصر في المعاينة فقط. اضغطي «حفظ» لنشره إلى المتجر.'); }
          catch (error) { failed(error, 'تعذر إدراج العنصر المحفوظ.'); }
        });
      });
      data.media.filter(function (x) { return x.section === libCategory; }).forEach(function (entry) {
        row(list, entry, 'استخدام', async function () {
          try {
            if (selectedId) await bridge.request('element.setMedia', { elementId: selectedId, src: entry.src });
            else await bridge.request('tool.run', { id: 'create_image', src: entry.src, at: null });
            applied('تم تطبيق الوسيط على المعاينة فقط؛ اضغطي «حفظ» لنشره.');
          } catch (error) { failed(error, 'تعذر تطبيق الوسيط.'); }
        }, true);
      });
      /* Like the original window, every section takes an upload: a picture or a video (kept in the cloud library, in THIS section), or an
         element file (JSON) exported by this editor (kept as a saved element in this section). Nothing is added to the page by uploading. */
      var picker = make('input'); picker.type = 'file'; picker.hidden = true;
      picker.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/webm,.json,application/json';
      var upload = libButton('رفع ملف وحفظه في ' + heading.textContent, function () { picker.click(); });
      upload.dataset.libAction = 'upload';
      picker.onchange = async function () {
        var file = picker.files && picker.files[0]; picker.value = '';
        if (!file) return;
        var folder = libCategory;
        upload.disabled = true; setNote(dialog, 'جارٍ رفع الملف…');
        try {
          if (/\.json$/i.test(file.name) || file.type === 'application/json') {
            await saveElementFile(file, folder, ctx.cloud);
            forcedNote = 'تم حفظ العنصر في مكتبة سابابيس داخل «' + labelOf(folder) + '». لم يُطبّق على الصفحة ولم يُحفظ أو يُنشر التصميم.';
          } else {
            await uploadFile(file, folder);
            forcedNote = 'تم رفع الملف وحفظه في مكتبة سابابيس داخل «' + labelOf(folder) + '». لم يُطبّق على الصفحة ولم يُحفظ أو يُنشر التصميم.';
          }
          await window.openLiveLibrary();
        } catch (error) {
          upload.disabled = false;
          setNote(dialog, 'تعذر رفع الملف: ' + (REASONS[error && error.message] || (error && error.message) || 'خطأ') + '.');
        }
      };
      dialog.append(upload, picker);
      dialog.append(make('small', 'صور حتى 10 ميجا، وفيديو حتى 50 ميجا، أو ملف عنصر JSON صادر من هذا المحرر. تُحفظ الملفات في مكتبة سابابيس داخل هذا القسم، ولا تُضاف للصفحة عند الرفع للمكتبة.'));
    }
    if (!list.children.length) list.append(make('p', 'لا توجد عناصر في هذا القسم بعد.'));
    dialog.append(libButton('إغلاق', function () { dialog.close(); }));

    var controls = make('div', '', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px');
    var load = libButton('تحميل المكتبة من سابابيس'), sync = libButton('مزامنة التغييرات');
    load.dataset.libAction = 'load'; sync.dataset.libAction = 'sync';
    controls.append(load, sync);
    dialog.append(controls);
    var message = make('p', ctx.note, 'font-size:12px;line-height:1.8;color:#846631');
    message.dataset.cloudMessage = 'true';
    dialog.append(message);

    load.onclick = async function () {
      load.disabled = sync.disabled = true; setNote(dialog, 'جارٍ تحميل المكتبة من سابابيس…');
      await window.openLiveLibrary();
    };
    sync.onclick = async function () {
      load.disabled = sync.disabled = true;
      try {
        var report = await model.syncLocal({ provider: window.elanLibraryDataProvider, storage: window.localStorage, uploadFile: uploadFile, sha256: sha256Hex, onProgress: function (text) { setNote(dialog, text); } });
        forcedNote = summarizeSync(report);
      } catch (error) {
        forcedNote = 'تعذرت المزامنة (' + (error && error.message || 'خطأ') + '). لم يُحذف شيء، ويمكن المحاولة مرة أخرى.';
      }
      await window.openLiveLibrary();
    };

    if (ctx.cloud) await paintLocalBox(dialog, ctx.cloud);
  }

  /* The old browser-only library (from before the cloud library), shown only while this browser still holds one. */
  async function paintLocalBox(dialog, cloud) {
    var local = null;
    try { local = model.readLocalLibrary(window.localStorage); } catch (_) { local = null; }
    if (!local || !local.present) return;
    var info = await model.describeLocal(local, cloud, window.localStorage, sha256Hex);
    var box = make('div', '', 'display:grid;gap:8px;margin:10px 0;padding:10px;border:1px solid #e5dcc5;border-radius:8px');
    box.dataset.libLocal = 'true';
    box.append(make('strong', 'مكتبة قديمة محفوظة في هذا المتصفح'));
    box.append(make('span', info.saved + ' عنصر محفوظ · ' + info.archive + ' عنصر مؤرشف · ' + info.media + ' ملف وسائط', 'font-size:12px;color:#846631'));
    box.append(make('span', info.pending
      ? 'لم يُنقل منها بعد: ' + info.pending + '. «مزامنة التغييرات» تنقلها إلى سابابيس بالدمج فقط، ولا تحذف أي شيء هنا أو هناك.'
      : 'كل ما فيها موجود الآن في سابابيس. يمكنك حذف النسخة المحلية بعد أخذ نسخة احتياطية.', 'font-size:12px;line-height:1.8'));
    var actions = make('div', '', 'display:flex;gap:8px;flex-wrap:wrap');
    var backup = libButton('تنزيل نسخة احتياطية (JSON)', function () { downloadLocalBackup(local); });
    backup.dataset.libAction = 'backup';
    var drop = libButton('حذف النسخة المحلية القديمة', async function () {
      if (!window.confirm('سيُحذف من هذا المتصفح فقط: العناصر المحفوظة والمؤرشفة والوسائط في المكتبة القديمة. المكتبة في سابابيس لا تتأثر. هل أنت متأكد؟')) return;
      model.clearLocalLibrary(window.localStorage);
      forcedNote = 'تم حذف المكتبة المحلية القديمة من هذا المتصفح. المكتبة في سابابيس كما هي.';
      await window.openLiveLibrary();
    });
    drop.dataset.libAction = 'clear-local'; drop.disabled = info.pending > 0;
    drop.title = info.pending > 0 ? 'يتاح بعد نقل كل شيء إلى سابابيس وتأكيده' : '';
    actions.append(backup, drop);
    box.append(actions);
    dialog.append(box);
  }

  window.openLiveLibrary = async function () {
    var dialog = document.getElementById('libraryDialog');
    var bridge = window.elanLiveEditorBridge;
    if (!dialog || !bridge) return;
    var ctx = { st: null, cloud: null, note: '' };
    try { ctx.st = await bridge.request('page.getState'); } catch (_) { ctx.st = null; }
    var failure = '';
    try { ctx.cloud = await window.connectElanLibrary(window.elanLibraryDataProvider); }
    catch (error) { failure = error && error.message || 'خطأ'; }
    var counts = ctx.cloud ? 'وسائط: ' + ctx.cloud.media.length + ' · عناصر محفوظة: ' + ctx.cloud.savedElements.length + ' · أرشيف: ' + ctx.cloud.archive.length : '';
    ctx.note = forcedNote || (failure ? 'تعذر تحميل المكتبة من سابابيس: ' + failure + '. اضغط «تحميل المكتبة من سابابيس» للمحاولة مرة أخرى.' : 'تم تحميل المكتبة من سابابيس · ' + counts);
    forcedNote = '';
    await paint(dialog, ctx);
    if (!dialog.open) dialog.showModal();
  };
})();
