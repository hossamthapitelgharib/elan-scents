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
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const method = options.method || 'GET';
    calls.push({ table, method });
    assert.equal(options.headers.apikey, 'test-service-role');
    if (!Object.hasOwn(tables, table)) return { ok: false, status: 404, json: async () => ({ message: 'unknown table' }) };
    if (method === 'GET') return response(clone(tables[table]));
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
  assert.match(ui, /element\.setMedia/);
  assert.match(ui, /provider\.uploadMedia/);
  assert.match(ui, /library\.insert/);
  assert.doesNotMatch(ui, /saveLive\s*\(|publishLive\s*\(|document\.getElementById\(['"]save['"]\)\.click/);
  assert.match(editMode, /expectedRevision:\s*current\.library\.revision/);
  assert.match(editMode, /case 'library\.insert'/);
});
