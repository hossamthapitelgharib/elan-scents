const test = require('node:test');
const assert = require('node:assert/strict');
const editorData = require('../railway/editor-data.js');

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const STORE_1 = id(11);
const STORE_2 = id(12);
const CAT = id(21);

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

function catalogTables() {
  return {
    products: [
      { id: id(101), name: 'Rose Oud', brand_id: id(1), status: 'published', is_active: true },
      { id: id(102), name: 'Amber Night', brand_id: id(2), status: 'published', is_active: true }
    ],
    product_sizes: [
      { id: id(201), product_id: id(101), size_ml: 50, size_label: '50 ml' },
      { id: id(202), product_id: id(101), size_ml: 100, size_label: '100 ml' },
      { id: id(203), product_id: id(102), size_ml: 100, size_label: '100 ml' }
    ],
    product_categories: [{ product_id: id(101), category_id: CAT }],
    store_products: [
      { id: id(301), store_id: STORE_1, product_size_id: id(201), price: 900, stock_quantity: 4, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(302), store_id: STORE_1, product_size_id: id(202), price: 1500, stock_quantity: 2, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(303), store_id: STORE_2, product_size_id: id(203), price: 700, stock_quantity: 9, is_available: true, sync_status: 'synced', stores: { status: 'active' } }
    ],
    brands: [{ id: id(1), name: 'Atelier', is_active: true }],
    stores: [{ id: STORE_1, name: 'Store One', status: 'active' }],
    categories: [{ id: CAT, name: 'Oriental' }],
    occasions: [],
    aromatic_notes: [],
    editor_sections: []
  };
}

test('the editor panels read real, filtered catalogue data and keep the purpose the owner typed', async (t) => {
  const previousFetch = global.fetch;
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  const tables = catalogTables();
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const table = parsed.pathname.split('/').pop();
    const method = options.method || 'GET';
    calls.push({ table, method, query: parsed.search });
    assert.equal(options.headers.apikey, 'test-service-role');
    if (method === 'POST' && table === 'editor_sections') {
      const row = { id: id(900), ...JSON.parse(options.body)[0] };
      tables.editor_sections.push(row);
      return { ok: true, status: 201, json: async () => [row] };
    }
    if (method !== 'GET') return { ok: false, status: 404, json: async () => ({ message: 'unexpected request' }) };
    let rows = (tables[table] || []).slice();
    for (const [key, raw] of parsed.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const [op, ...rest] = raw.split('.');
      const value = rest.join('.');
      if (key === 'stores.status') rows = rows.filter((r) => r.stores && r.stores.status === value);
      else if (op === 'eq') rows = rows.filter((r) => String(r[key]) === value);
      else if (op === 'gt') rows = rows.filter((r) => Number(r[key]) > Number(value));
      else if (op === 'not') rows = rows.filter((r) => r[key] !== null && r[key] !== undefined);
    }
    const offset = Number(parsed.searchParams.get('offset') || 0);
    const limit = Number(parsed.searchParams.get('limit') || 1000);
    return { ok: true, status: 200, json: async () => rows.slice(offset, offset + limit) };
  };

  async function call(body) {
    const res = makeRes();
    await editorData({ method: 'POST', query: {}, body, headers: {}, __editorKeyAdmin: true }, res);
    return res;
  }

  try {
    await t.test('option lists carry named, distinct sizes for the panel', async () => {
      const res = await call({ action: 'options' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.options.sizes, [{ size_ml: 50, name: '50 ml' }, { size_ml: 100, name: '100 ml' }]);
      assert.deepEqual(res.body.options.brands.map((b) => b.name), ['Atelier']);
      assert.deepEqual(res.body.options.categories.map((c) => [c.id, c.name]), [[CAT, 'Oriental']]);
    });

    await t.test('category, store and price filters narrow the perfume list through the real tables', async () => {
      const byCategory = await call({ action: 'perfumes', filters: { category_id: CAT } });
      assert.deepEqual(byCategory.body.rows.map((r) => r.product_size_id), [id(201), id(202)]);
      assert.ok(calls.some((c) => c.table === 'product_categories' && c.query.includes('category_id=eq.' + CAT)));

      const byStore = await call({ action: 'perfumes', filters: { store_id: STORE_2 } });
      assert.deepEqual(byStore.body.rows.map((r) => r.product_size_id), [id(203)]);

      const byPrice = await call({ action: 'perfumes', filters: { store_id: STORE_1, price_min: 1000, price_max: 2000 } });
      assert.deepEqual(byPrice.body.rows.map((r) => r.product_size_id), [id(202)]);
      assert.deepEqual(Object.keys(byPrice.body.rows[0]).sort(), ['name', 'product_id', 'product_size_id', 'size_label'], 'the panel list never carries prices');
    });

    await t.test('malformed filters answer 400 and read nothing from the catalogue', async () => {
      const before = calls.length;
      for (const filters of [{ brand_id: 'nope' }, { store_id: "x' or 1=1" }, { price_min: 10, price_max: 1 }, { size_ml: -5 }]) {
        const res = await call({ action: 'perfumes', filters });
        assert.equal(res.statusCode, 400, JSON.stringify(filters));
        assert.equal(res.body.error, 'invalid_perfume_filter');
      }
      assert.equal(calls.length, before);
    });

    await t.test('the purpose typed in the section panel is stored as written; empty or control characters are refused', async () => {
      const ok = await call({ action: 'section.create', section: { element_id: 'x-winter1', name: 'عروض الشتاء', purpose: 'حملة الشتاء', selection_mode: 'auto', filters: { brand: 'Atelier' } } });
      assert.equal(ok.statusCode, 200);
      assert.equal(tables.editor_sections[0].purpose, 'حملة الشتاء');
      assert.deepEqual(tables.editor_sections[0].filters, { brand: 'Atelier' });
      const kind = await call({ action: 'section.create', section: { name: 'Atelier', purpose: 'brand', selection_mode: 'auto', filters: { brand: 'Atelier' } } });
      assert.equal(kind.statusCode, 200, 'the brand/store/occasion/note tools still send their own kind');
      const written = tables.editor_sections.length;
      for (const purpose of ['', '   ', 'bad\u0007purpose']) {
        const res = await call({ action: 'section.create', section: { name: 'X', purpose, selection_mode: 'auto', filters: {} } });
        assert.equal(res.statusCode, 400, JSON.stringify(purpose));
        assert.equal(res.body.error, 'invalid_section_purpose');
      }
      assert.equal(tables.editor_sections.length, written);
    });
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
