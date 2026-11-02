/* Authenticated browser-side adapters for the editor's section and library tools. */
(function () {
  'use strict';
  async function call(action, payload, method) {
    const opts = { method: method || (payload ? 'POST' : 'GET'), credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (payload) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify({ action, ...payload }); }
    const url = payload ? '/api/editor-data' : '/api/editor-data?action=' + encodeURIComponent(action);
    const r = await fetch(url, opts);
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw Error(j.error || 'editor_data_failed');
    return j;
  }
  window.elanSectionDataProvider = {
    getOptions: async function () { return (await call('options')).options; },
    getPerfumes: async function (filters) { return (await call('perfumes', { filters: filters || {} })).rows; }
  };
  window.elanLibraryDataProvider = {
    getLibrary: async function () { return (await call('library')).library; },
    saveLibrary: async function (library, expectedRevision) {
      return call('library.save', { library: library, expectedRevision: expectedRevision || null });
    },
    uploadMedia: async function (file, meta) {
      if (!file || !file.type || !/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type)) throw Error('unsupported_type');
      const r = await fetch('/api/editor-upload', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || (meta && meta.category) || 'صورة') },
        body: file
      });
      const j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok || !j.url) throw Error(j.error || 'upload_failed');
      return { id: j.url, name: file.name || 'صورة', src: j.url, url: j.url, type: 'image', category: (meta && meta.category) || 'general', source: 'device_upload' };
    }
  };
  window.elanEditorDataProviderReady = true;
})();
