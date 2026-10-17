const test = require('node:test');
const assert = require('node:assert/strict');
const editorData = require('../railway/editor-data.js');

const PRODUCT_ID = '10000000-0000-4000-8000-000000000001';
const SIZE_ID = '20000000-0000-4000-8000-000000000002';
const SECTION_ID = '30000000-0000-4000-8000-000000000003';

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

test('dynamic section creation only accepts safe filters and currently published product sizes', async (t) => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  const calls = [];
  const items = [];
  const sections = [];

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const method = options.method || 'GET';
    calls.push({ table, method });
    assert.equal(options.headers.apikey, 'test-service-role');
    if (table === 'products' && method === 'GET') return { ok: true, status: 200, json: async () => [{ id: PRODUCT_ID, name: 'Rose', brand_id: 'brand-1', status: 'published', is_active: true }] };
    if (table === 'product_sizes' && method === 'GET') return { ok: true, status: 200, json: async () => [{ id: SIZE_ID, product_id: PRODUCT_ID, size_ml: 100, size_label: '100 ml' }] };
    if (table === 'editor_sections' && method === 'POST') {
      const row = { id: SECTION_ID, ...JSON.parse(options.body)[0] };
      sections.push(row);
      return { ok: true, status: 201, json: async () => [row] };
    }
    if (table === 'editor_section_items' && method === 'POST') {
      const rows = JSON.parse(options.body);
      items.push(...rows);
      return { ok: true, status: 201, json: async () => rows };
    }
    if (table === 'editor_sections' && method === 'DELETE') return { ok: true, status: 204, json: async () => [] };
    return { ok: false, status: 404, json: async () => ({ message: 'unexpected request' }) };
  };

  async function invoke(section) {
    const req = { method: 'POST', query: {}, body: { action: 'section.create', section }, headers: {}, __editorKeyAdmin: true };
    const res = makeRes();
    await editorData(req, res);
    return res;
  }

  try {
    await t.test('a perfume card writes one validated product-size reference and an auto section uses an existing filter', async () => {
      const manual = await invoke({
        element_id: 'x-perfume1', name: 'Rose 100 ml', purpose: 'perfume', selection_mode: 'manual',
        product_size_ids: [SIZE_ID], filters: {}
      });
      assert.equal(manual.statusCode, 200);
      assert.equal(manual.body.ref, 'x-perfume1');
      assert.equal(manual.body.itemCount, 1);
      assert.equal(items.length, 1);
      assert.equal(items[0].product_size_id, SIZE_ID);
      assert.equal(items[0].section_id, SECTION_ID);

      const automatic = await invoke({
        element_id: 'x-brand1', name: 'Atelier Rose', purpose: 'brand', selection_mode: 'auto',
        filters: { brand: 'Atelier Rose', limit: 12 }
      });
      assert.equal(automatic.statusCode, 200);
      assert.deepEqual(sections[1].filters, { brand: 'Atelier Rose', limit: 12 });
      assert.equal(automatic.body.itemCount, 0);
    });

    await t.test('unknown catalog references and unsafe filters are rejected before section writes', async () => {
      const before = calls.filter((call) => call.table === 'editor_sections' && call.method === 'POST').length;
      const unknownProduct = await invoke({
        name: 'Invalid card', purpose: 'perfume', selection_mode: 'manual',
        product_size_ids: ['40000000-0000-4000-8000-000000000004'], filters: {}
      });
      assert.equal(unknownProduct.statusCode, 400);
      assert.equal(unknownProduct.body.error, 'section_item_not_available');
      assert.equal(calls.filter((call) => call.table === 'editor_sections' && call.method === 'POST').length, before);

      const unsafeFilter = await invoke({
        name: 'Unsafe', purpose: 'brand', selection_mode: 'auto',
        filters: { unexpected: 'value' }
      });
      assert.equal(unsafeFilter.statusCode, 400);
      assert.equal(unsafeFilter.body.error, 'invalid_section_filter');
      assert.equal(calls.filter((call) => call.table === 'editor_sections' && call.method === 'POST').length, before);
    });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});

test('visual editor card tools use real catalog selections and the left-click open chip remains available', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const editMode = fs.readFileSync(path.join(root, 'edit-mode.js'), 'utf8');
  const hostBridge = fs.readFileSync(path.join(root, 'elan-host-bridge.js'), 'utf8');
  const designLayer = fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8');
  assert.match(editMode, /editorData\('options'\)/);
  assert.match(editMode, /editorData\('perfumes'/);
  assert.match(editMode, /filters\[spec\.key\] = String\(selected\.name\)/);
  assert.match(editMode, /product_size_ids: productSizeIds/);
  assert.match(editMode, /selectionMode = 'auto'/);
  assert.match(editMode, /case 'library\.insert'/);
  assert.match(hostBridge, /'library\.insert'/);
  assert.match(designLayer, /sameCatalogName\(o\.store, f\.store\)/);
  assert.match(designLayer, /sameCatalogName\(p\.brand, f\.brand\)/);
  assert.match(designLayer, /offers\.sort\(function \(a, b\) \{ return a\.price - b\.price; \}\)/);
  assert.match(editMode, /openEl\.addEventListener\('pointerdown'/);
  assert.match(editMode, /function enterPage\(e\)/);
});
