const test = require('node:test');
const assert = require('node:assert/strict');
const createCatalog = require('../railway/editor-catalog.js');

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const BRAND_A = id(1);
const BRAND_B = id(2);
const STORE_1 = id(11);
const STORE_2 = id(12);
const CAT = id(21);
const OCC = id(31);
const NOTE = id(41);

/* A small PostgREST-like fake: eq./gt./not.is.null filters, the embedded stores.status filter, limit and offset. */
function fakeDb(tables) {
  const calls = [];
  async function sb(ctx, table, query) {
    calls.push(table + query);
    const params = new URLSearchParams((query || '').replace(/^\?/, ''));
    let rows = (tables[table] || []).slice();
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const [op, ...rest] = raw.split('.');
      const value = rest.join('.');
      if (key === 'stores.status') rows = rows.filter((r) => r.stores && r.stores.status === value);
      else if (op === 'eq') rows = rows.filter((r) => String(r[key]) === value);
      else if (op === 'gt') rows = rows.filter((r) => Number(r[key]) > Number(value));
      else if (op === 'not' && value === 'is.null') rows = rows.filter((r) => r[key] !== null && r[key] !== undefined);
      else throw new Error('fake db cannot read filter ' + key + '=' + raw);
    }
    const offset = Number(params.get('offset') || 0);
    const limit = Number(params.get('limit') || 1000);
    return rows.slice(offset, offset + limit);
  }
  return { sb, calls };
}

function catalogTables() {
  return {
    products: [
      { id: id(101), name: 'Rose Oud', brand_id: BRAND_A, status: 'published', is_active: true },
      { id: id(102), name: 'Amber Night', brand_id: BRAND_B, status: 'published', is_active: true },
      { id: id(103), name: 'Hidden Draft', brand_id: BRAND_A, status: 'published', is_active: true },
      { id: id(104), name: 'Old Stock', brand_id: BRAND_A, status: 'archived', is_active: true }
    ],
    product_sizes: [
      { id: id(201), product_id: id(101), size_ml: 50, size_label: '50 ml' },
      { id: id(202), product_id: id(101), size_ml: 100, size_label: '100 ml' },
      { id: id(203), product_id: id(102), size_ml: 100, size_label: '100 ml' },
      { id: id(204), product_id: id(103), size_ml: 100, size_label: '100 ml' },
      { id: id(205), product_id: id(104), size_ml: 100, size_label: '100 ml' }
    ],
    product_categories: [{ product_id: id(101), category_id: CAT }, { product_id: id(102), category_id: id(22) }],
    product_occasions: [{ product_id: id(101), occasion_id: OCC }, { product_id: id(103), occasion_id: OCC }],
    product_notes: [{ product_id: id(101), note_id: NOTE }, { product_id: id(102), note_id: NOTE }],
    store_products: [
      // 201: cheapest eligible offer is 900 (the 400 offer is out of stock, the 300 offer is unsynced, the 200 one belongs to an inactive store)
      { id: id(301), store_id: STORE_1, product_size_id: id(201), price: 900, stock_quantity: 4, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(302), store_id: STORE_2, product_size_id: id(201), price: 400, stock_quantity: 0, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(303), store_id: STORE_2, product_size_id: id(201), price: 300, stock_quantity: 5, is_available: true, sync_status: 'stale', stores: { status: 'active' } },
      { id: id(304), store_id: STORE_2, product_size_id: id(201), price: 200, stock_quantity: 5, is_available: true, sync_status: 'synced', stores: { status: 'inactive' } },
      { id: id(305), store_id: STORE_1, product_size_id: id(202), price: 1500, stock_quantity: 2, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(306), store_id: STORE_2, product_size_id: id(202), price: 1200, stock_quantity: 2, is_available: true, sync_status: 'synced', stores: { status: 'active' } },
      { id: id(307), store_id: STORE_2, product_size_id: id(203), price: 700, stock_quantity: 9, is_available: false, sync_status: 'synced', stores: { status: 'active' } }
    ],
    brands: [{ id: BRAND_A, name: 'Atelier', is_active: true }, { id: BRAND_B, name: 'Dormant', is_active: false }],
    stores: [{ id: STORE_1, name: 'Store One', status: 'active' }, { id: STORE_2, name: 'Store Two', status: 'inactive' }],
    categories: [], occasions: [], notes: []
  };
}

const sizeIds = (rows) => rows.map((r) => r.product_size_id);

test('without filters every published, active perfume size is listed and no offer data is read', async () => {
  const db = fakeDb(catalogTables());
  const rows = await createCatalog(db.sb).perfumes({}, {});
  assert.deepEqual(sizeIds(rows).sort(), [id(201), id(202), id(203), id(204)].sort());
  assert.equal(rows[0].name, 'Amber Night');
  assert.ok(!db.calls.some((c) => c.startsWith('store_products')), 'store offers are only read when a store or price filter is used');
  assert.equal(rows.find((r) => r.product_size_id === id(201)).size_label, '50 ml');
});

test('category, occasion and note filters use the real relation tables and intersect', async () => {
  const catalog = createCatalog(fakeDb(catalogTables()).sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { category_id: CAT })).sort(), [id(201), id(202)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { occasion_id: OCC })).sort(), [id(201), id(202), id(204)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { note_id: NOTE })).sort(), [id(201), id(202), id(203)].sort());
  const both = await catalog.perfumes({}, { occasion_id: OCC, note_id: NOTE, brand_id: BRAND_A, size_ml: 100 });
  assert.deepEqual(sizeIds(both), [id(202)]);
});

test('a store filter keeps only sizes with an eligible offer from that store', async () => {
  const db = fakeDb(catalogTables());
  const catalog = createCatalog(db.sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_1 })).sort(), [id(201), id(202)].sort());
  // Store 2 only has an unavailable, an out-of-stock, an unsynced and an inactive-store offer for size 201,
  // so only its available offer for 202 counts; size 203 is marked unavailable.
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_2 })), [id(202)]);
  const storeCall = db.calls.find((c) => c.startsWith('store_products') && c.includes('store_id=eq.' + STORE_2));
  assert.match(storeCall, /is_available=eq\.true/);
  assert.match(storeCall, /stock_quantity=gt\.0/);
  assert.match(storeCall, /sync_status=eq\.synced/);
  assert.match(storeCall, /stores\.status=eq\.active/);
});

test('price limits compare against the cheapest eligible offer, inclusive at both ends', async () => {
  const catalog = createCatalog(fakeDb(catalogTables()).sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 900, price_max: 900 })), [id(201)]);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_max: 1000 })), [id(201)]);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 1000 })), [id(202)]);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 1300 })), []);
  // With a store chosen, only that store's offers are compared: store 1 sells 202 at 1500.
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_1, price_min: 1300 })), [id(202)]);
});

test('search and size filters keep working together', async () => {
  const catalog = createCatalog(fakeDb(catalogTables()).sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { search: ' rose ' })).sort(), [id(201), id(202)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { search: 'rose', size_ml: 50 })), [id(201)]);
});

test('unsafe or malformed filter values are rejected before any read', async () => {
  const db = fakeDb(catalogTables());
  const catalog = createCatalog(db.sb);
  const bad = [
    { brand_id: 'not-a-uuid' }, { store_id: "x' or 1=1" }, { category_id: 5 }, { size_ml: 0 }, { size_ml: 2.5 },
    { price_min: -1 }, { price_max: 'abc' }, { price_min: 10, price_max: 5 }
  ];
  for (const filters of bad) {
    await assert.rejects(() => catalog.perfumes({}, filters), (e) => e.message === 'invalid_perfume_filter' && e.status === 400, JSON.stringify(filters));
  }
  assert.equal(db.calls.length, 0);
});

test('every page is read, not just the first one', async () => {
  const sizes = [];
  const products = [];
  for (let n = 0; n < 2400; n++) {
    products.push({ id: id(10000 + n), name: 'P' + String(n).padStart(4, '0'), brand_id: BRAND_A, status: 'published', is_active: true });
    sizes.push({ id: id(50000 + n), product_id: id(10000 + n), size_ml: 100, size_label: '100 ml' });
  }
  const db = fakeDb({ products, product_sizes: sizes });
  const rows = await createCatalog(db.sb).perfumes({}, {});
  assert.equal(rows.length, 2400);
  assert.equal(new Set(sizeIds(rows)).size, 2400);
  assert.ok(db.calls.filter((c) => c.startsWith('products')).length >= 3);
});

test('size options are distinct, named and sorted', async () => {
  const tables = catalogTables();
  tables.product_sizes.push({ id: id(206), product_id: id(102), size_ml: 30, size_label: '30 ml' }, { id: id(207), product_id: id(102), size_ml: null, size_label: 'Set' });
  const options = await createCatalog(fakeDb(tables).sb).options({});
  assert.deepEqual(options.sizes, [{ size_ml: 30, name: '30 ml' }, { size_ml: 50, name: '50 ml' }, { size_ml: 100, name: '100 ml' }]);
  assert.deepEqual(options.brands.map((b) => b.name), ['Atelier'], 'inactive brands are not offered');
  assert.deepEqual(options.stores.map((s) => s.name), ['Store One'], 'inactive stores are not offered');
});
