const test = require('node:test');
const assert = require('node:assert/strict');
const editorData = require('../railway/editor-data.js');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function response(data) {
  return { ok: true, status: 200, json: async () => data };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('cloud library reads are authenticated and merges are revision-checked and non-destructive', async (t) => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';

  const tables = { media_library: [], editor_archive: [], editor_saved_elements: [] };
  const calls = [];
  let nextId = 1;
  const storageDeletes = [], catalogueUse = new Set();           // storage paths removed; catalogue tables that "use" the file
  let storageStatus = 200;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const method = options.method || 'GET';
    assert.equal(options.headers.apikey, 'test-service-role');
    if (parsed.pathname.startsWith('/storage/v1/object/site-media/')) {
      assert.equal(method, 'DELETE');
      if (storageStatus === 200) storageDeletes.push(parsed.pathname.slice('/storage/v1/object/site-media/'.length));
      return { ok: storageStatus === 200, status: storageStatus, json: async () => [] };
    }
    calls.push({ table, method });
    if (['aromatic_notes', 'brands', 'categories', 'occasions', 'product_images', 'profiles', 'stores'].includes(table)) return response(catalogueUse.has(table) ? [{ id: 'x' }] : []);
    if (!Object.hasOwn(tables, table)) return { ok: false, status: 404, json: async () => ({ message: 'unknown table' }) };
    if (method === 'GET') {
      const idFilter = parsed.searchParams.get('id') || '';
      if (idFilter.startsWith('neq.')) {               // «another row with the same file»
        const orFilter = decodeURIComponent(parsed.searchParams.get('or') || '');
        return response(clone(tables[table].filter((item) => item.id !== idFilter.slice(4) && orFilter.split(/[=,*)]/).some((part) => part && ((item.storage_path && item.storage_path === part) || (item.file_url && part.length > 12 && item.file_url.includes(part)))))));
      }
      return response(clone(idFilter.startsWith('eq.') ? tables[table].filter((item) => item.id === idFilter.slice(3)) : tables[table]));
    }
    if (method === 'DELETE') {
      const idFilter = parsed.searchParams.get('id') || '';
      if (!idFilter.startsWith('eq.')) return { ok: false, status: 400, json: async () => ({ message: 'a delete must name one id' }) };
      tables[table] = tables[table].filter((item) => item.id !== idFilter.slice(3));
      return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    }
    if (method === 'POST') {
      const rows = JSON.parse(options.body);
      const inserted = rows.map((row) => ({ id: '00000000-0000-4000-8000-' + String(nextId++).padStart(12, '0'), created_at: '2026-10-15T00:00:00.000Z', ...row }));
      tables[table].push(...inserted);
      return response(clone(inserted));
    }
    if (method === 'PATCH') {
      const idFilter = parsed.searchParams.get('id') || '';
      const id = idFilter.startsWith('eq.') ? idFilter.slice(3) : '';
      const row = tables[table].find((item) => item.id === id);
      if (!row) return { ok: false, status: 404, json: async () => ({ message: 'missing row' }) };
      Object.assign(row, JSON.parse(options.body));
      return response([clone(row)]);
    }
    return { ok: false, status: 405, json: async () => ({ message: 'unsupported method' }) };
  };

  async function invoke(method, { query = {}, body = {}, admin = true } = {}) {
    const req = { method, query, body, headers: {}, __editorKeyAdmin: admin };
    const res = makeRes();
    await editorData(req, res);
    return res;
  }

  try {
    await t.test('unauthenticated calls are rejected before any database request', async () => {
      const before = calls.length;
      const result = await invoke('GET', { query: { action: 'library' }, admin: false });
      assert.equal(result.statusCode, 401);
      assert.equal(calls.length, before);
    });

    await t.test('reads include a stable opaque revision', async () => {
      const result = await invoke('GET', { query: { action: 'library' } });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body.library.archive, []);
      assert.deepEqual(result.body.library.savedElements, []);
      assert.match(result.body.library.revision, /^[a-f0-9]{64}$/);
    });

    await t.test('independent media uploads do not invalidate archive and saved-element revisions', async () => {
      const before = await invoke('GET', { query: { action: 'library' } });
      tables.media_library.push({ id: 'media-1', file_url: 'https://supabase.test/image.jpg', file_type: 'image/jpeg' });
      const after = await invoke('GET', { query: { action: 'library' } });
      assert.equal(after.body.library.media.length, 1);
      assert.equal(after.body.library.revision, before.body.library.revision);
    });

    await t.test('archive records are merged without deleting existing cloud records', async () => {
      const initial = await invoke('GET', { query: { action: 'library' } });
      const archived = { element_id: 'card-1', kind: 'card', name: 'Rose card', payload: { id: 'card-1', type: 'card' } };
      const first = await invoke('POST', { body: { action: 'library.save', expectedRevision: initial.body.library.revision, library: { archive: [archived], savedElements: [] } } });
      assert.equal(first.statusCode, 200);
      assert.equal(tables.editor_archive.length, 1);
      const afterFirst = await invoke('GET', { query: { action: 'library' } });
      const duplicate = await invoke('POST', { body: { action: 'library.save', expectedRevision: afterFirst.body.library.revision, library: { archive: [archived], savedElements: [] } } });
      assert.equal(duplicate.statusCode, 200);
      assert.equal(tables.editor_archive.length, 1);
      assert.equal(calls.some((call) => call.method === 'DELETE'), false);
    });

    await t.test('new saved elements are merged, duplicate snapshots do not duplicate rows, and no DELETE is issued', async () => {
      const initial = await invoke('GET', { query: { action: 'library' } });
      const item = { name: 'Rose', kind: 'perfume-card', category: 'perfume', payload: { type: 'product-card', product_id: 'product-1' } };
      const first = await invoke('POST', { body: { action: 'library.save', expectedRevision: initial.body.library.revision, library: { archive: [], savedElements: [item] } } });
      assert.equal(first.statusCode, 200);
      assert.equal(first.body.ok, true);
      assert.equal(tables.editor_saved_elements.length, 1);

      const afterFirst = await invoke('GET', { query: { action: 'library' } });
      const duplicate = await invoke('POST', { body: { action: 'library.save', expectedRevision: afterFirst.body.library.revision, library: { archive: [], savedElements: [item] } } });
      assert.equal(duplicate.statusCode, 200);
      assert.equal(tables.editor_saved_elements.length, 1);
      assert.equal(duplicate.body.revision, afterFirst.body.library.revision);
      assert.equal(calls.some((call) => call.method === 'DELETE'), false);
    });

    await t.test('stale revisions fail with 409 and do not write', async () => {
      const beforeWrites = calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').length;
      const result = await invoke('POST', { body: { action: 'library.save', expectedRevision: '0'.repeat(64), library: { archive: [], savedElements: [{ name: 'Stale', kind: 'element', payload: { type: 'text' } }] } } });
      assert.equal(result.statusCode, 409);
      assert.equal(result.body.error, 'library_revision_conflict');
      assert.equal(calls.filter((call) => call.method === 'POST' || call.method === 'PATCH').length, beforeWrites);
    });

    await t.test('«حذف نهائي» removes exactly the one row asked for, in the right table, and nothing else', async () => {
      const keep = '00000000-0000-4000-8000-0000000000aa', gone = '00000000-0000-4000-8000-0000000000bb';
      tables.editor_saved_elements.push({ id: keep, name: 'Keep', kind: 'x', payload: {} }, { id: gone, name: 'Gone', kind: 'x', payload: {} });
      tables.editor_archive.push({ id: gone, element_id: 'e1', kind: 'x', payload: {} });
      tables.media_library.push({ id: gone, file_url: 'https://supabase.test/storage/v1/object/public/site-media/a.png', file_type: 'image' });
      const savedBefore = tables.editor_saved_elements.length, archiveBefore = tables.editor_archive.length, mediaBefore = tables.media_library.length;

      const saved = await invoke('POST', { body: { action: 'library.delete', kind: 'saved', id: gone } });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.body.ok, true);
      assert.equal(tables.editor_saved_elements.length, savedBefore - 1);
      assert.ok(tables.editor_saved_elements.some((item) => item.id === keep), 'the other saved element is still there');
      assert.equal(tables.editor_archive.length, archiveBefore, 'a saved delete does not touch the archive');
      assert.equal(tables.media_library.length, mediaBefore, 'a saved delete does not touch the media');
      assert.match(saved.body.revision, /^[a-f0-9]{64}$/);

      assert.equal((await invoke('POST', { body: { action: 'library.delete', kind: 'archive', id: gone } })).statusCode, 200);
      assert.equal(tables.editor_archive.length, archiveBefore - 1);
      assert.equal((await invoke('POST', { body: { action: 'library.delete', kind: 'media', id: gone } })).statusCode, 200);
      assert.equal(tables.media_library.length, mediaBefore - 1);
      const deletes = calls.filter((call) => call.method === 'DELETE');
      assert.equal(deletes.length, 3, 'one DELETE per request, no storage or other table involved');
      assert.deepEqual(deletes.map((call) => call.table), ['editor_saved_elements', 'editor_archive', 'media_library']);
    });

    await t.test('a delete is refused for a guest, a bad kind, a bad id, and an id that is not there, and deletes nothing', async () => {
      const before = calls.filter((call) => call.method === 'DELETE').length;
      const guest = await invoke('POST', { body: { action: 'library.delete', kind: 'saved', id: '00000000-0000-4000-8000-0000000000aa' }, admin: false });
      assert.equal(guest.statusCode, 401);
      const kind = await invoke('POST', { body: { action: 'library.delete', kind: 'products', id: '00000000-0000-4000-8000-0000000000aa' } });
      assert.equal(kind.statusCode, 400); assert.equal(kind.body.error, 'invalid_library_kind');
      const proto = await invoke('POST', { body: { action: 'library.delete', kind: 'constructor', id: '00000000-0000-4000-8000-0000000000aa' } });
      assert.equal(proto.statusCode, 400);
      const id = await invoke('POST', { body: { action: 'library.delete', kind: 'saved', id: '*' } });
      assert.equal(id.statusCode, 400); assert.equal(id.body.error, 'invalid_library_id');
      const many = await invoke('POST', { body: { action: 'library.delete', kind: 'saved', id: '00000000-0000-4000-8000-0000000000aa,00000000-0000-4000-8000-0000000000bb' } });
      assert.equal(many.statusCode, 400);
      const missing = await invoke('POST', { body: { action: 'library.delete', kind: 'saved', id: '00000000-0000-4000-8000-0000000000cc' } });
      assert.equal(missing.statusCode, 404); assert.equal(missing.body.error, 'library_item_not_found');
      assert.equal(calls.filter((call) => call.method === 'DELETE').length, before, 'none of these reached a DELETE');
      assert.ok(tables.editor_saved_elements.some((item) => item.id === '00000000-0000-4000-8000-0000000000aa'), 'the kept row is untouched');
    });

    await t.test('deleting a media row also removes its file from Storage, but only when nothing uses it', async () => {
      const editor = require('../railway/editor.js');
      const realDesign = editor.internals.currentDesignText;
      const mk = (n, extra = {}) => {
        const path = 'uploads/2026/' + String(n).repeat(20).slice(0, 20) + '.png';
        const row = { id: '00000000-0000-4000-8000-00000000f' + String(n).repeat(3), file_url: 'https://supabase.test/storage/v1/object/public/site-media/' + path, storage_path: path, file_type: 'image', ...extra };
        tables.media_library.push(row);
        return { path, id: row.id };
      };
      const del = (id, extra = {}) => invoke('POST', { body: { action: 'library.delete', kind: 'media', id, ...extra } });
      try {
        // 1. unused everywhere: row and file both go
        editor.internals.currentDesignText = async () => '{"pages":{}}';
        let a = mk(1);
        let res = await del(a.id);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.file, 'removed');
        assert.deepEqual(storageDeletes, [a.path]);
        assert.ok(!tables.media_library.some((r) => r.id === a.id), 'the row is gone');

        // 2. the published design uses it: the row goes, the file stays and the answer says why
        a = mk(2); editor.internals.currentDesignText = async () => '{"hero":{"image":"https://x/' + a.path + '"}}';
        res = await del(a.id);
        assert.equal(res.body.file, 'kept'); assert.deepEqual(res.body.keptBecause, ['تصميم الموقع']);
        assert.ok(!storageDeletes.includes(a.path));
        assert.ok(!tables.media_library.some((r) => r.id === a.id));

        // 3. the design cannot be read: unknown is never «unused»
        a = mk(3); editor.internals.currentDesignText = async () => null;
        res = await del(a.id);
        assert.equal(res.body.file, 'kept'); assert.ok(!storageDeletes.includes(a.path));

        // 4. the open, unsaved design uses it (the editor says so)
        a = mk(4); editor.internals.currentDesignText = async () => '{}';
        res = await del(a.id, { draftUses: true });
        assert.equal(res.body.file, 'kept'); assert.match(res.body.keptBecause[0], /لم يُحفظ/); assert.ok(!storageDeletes.includes(a.path));

        // 5. a catalogue picture column uses it
        a = mk(5); catalogueUse.add('stores');
        res = await del(a.id); catalogueUse.clear();
        assert.equal(res.body.file, 'kept'); assert.deepEqual(res.body.keptBecause, ['جدول stores']); assert.ok(!storageDeletes.includes(a.path));

        // 6. another library row points at the same file
        a = mk(6); const twin = mk(7, { file_url: tables.media_library[tables.media_library.length - 1].file_url, storage_path: a.path });
        res = await del(a.id);
        assert.equal(res.body.file, 'kept'); assert.match(res.body.keptBecause.join(), /نسخة أخرى/); assert.ok(!storageDeletes.includes(a.path));
        tables.media_library = tables.media_library.filter((r) => r.id !== twin.id);

        // 7. a saved element of the library carries the file
        a = mk(8); tables.editor_saved_elements.push({ id: '00000000-0000-4000-8000-0000000000e8', name: 'uses it', kind: 'image', payload: { type: 'image', src: 'https://x/' + a.path } });
        res = await del(a.id);
        assert.equal(res.body.file, 'kept'); assert.match(res.body.keptBecause.join(), /عنصر محفوظ/); assert.ok(!storageDeletes.includes(a.path));
        tables.editor_saved_elements = tables.editor_saved_elements.filter((r) => r.name !== 'uses it');

        // 8. a file the editor did not upload (not under uploads/ with a random name) is never removed from Storage
        const foreign = { id: '00000000-0000-4000-8000-0000000000f9', file_url: 'https://supabase.test/storage/v1/object/public/site-media/brand/logo.png', storage_path: 'brand/logo.png', file_type: 'image' };
        tables.media_library.push(foreign);
        const before = storageDeletes.length;
        res = await del(foreign.id);
        assert.equal(res.body.file, 'kept'); assert.equal(storageDeletes.length, before);

        // 9. Storage refuses: the row stays so the owner can try again, and the answer is an error
        a = mk(9); storageStatus = 500;
        res = await del(a.id); storageStatus = 200;
        assert.equal(res.statusCode, 502); assert.equal(res.body.error, 'storage_delete_failed');
        assert.ok(tables.media_library.some((r) => r.id === a.id), 'the row is still there');
        assert.ok(!storageDeletes.includes(a.path));
      } finally { editor.internals.currentDesignText = realDesign; }
    });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

test('live editor library connects to cloud data read-only and never saves or publishes the page on load', () => {
  const ui = read('editor/editor-live-library.js');
  const host = read('railway/editor-host.js');
  const server = read('railway/server.js');
  const editMode = read('edit-mode.js');
  assert.match(host, /editor-live-library\.js\?v=/);
  assert.match(server, /'editor-live-library\.js'/);
  assert.match(ui, /window\.connectElanLibrary/);
  assert.match(ui, /selectedProvider\.getLibrary\(\)/);
  assert.match(ui, /cloud\.savedElements/);
  assert.match(ui, /cloud\.archive/);
  assert.match(ui, /page\.getState/);
  assert.match(ui, /media\.place/, 'using a picture waits for a click that says where it goes');
  assert.match(ui, /place: true/, 'so do adding a saved element and restoring an archived one');
  assert.doesNotMatch(ui, /element\.setMedia|create_image/, 'no more silent use on the selected element or on no particular place');
  assert.match(ui, /provider\.uploadMedia/);
  assert.match(ui, /library\.insert/);
  assert.match(ui, /حذف نهائي/);
  assert.match(ui, /provider\.deleteItem\(entry\.cloud\.kind, entry\.cloud\.id/);
  assert.match(read('editor/editor-data-bridge.js'), /call\('library\.delete'/);
  assert.doesNotMatch(ui, /saveLive\s*\(|publishLive\s*\(|document\.getElementById\(['"]save['"]\)\.click/);
  assert.match(editMode, /expectedRevision:\s*current\.library\.revision/);
  assert.match(editMode, /case 'library\.insert'/);
  assert.match(editMode, /case 'media\.place'/);
  assert.match(editMode, /case 'placement\.cancel'/);
  assert.match(read('elan-host-bridge.js'), /'media\.place','placement\.cancel'/);
});
