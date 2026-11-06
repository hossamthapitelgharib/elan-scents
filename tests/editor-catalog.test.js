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
    if (table === 'rpc/catalog_filter_product_sizes') {
      const products = tables.products || [];
      const sizes = tables.product_sizes || [];
      const value = (key) => params.get('p_' + key);
      const links = (tableName, productId, column, selected) => !selected || (tables[tableName] || []).some((row) => String(row.product_id) === String(productId) && String(row[column]) === selected);
      let result = [];
      for (const size of sizes) {
        const product = products.find((row) => String(row.id) === String(size.product_id) && row.status === 'published' && row.is_active === true);
        const offer = (tables.catalog_platform_offers || []).find((row) => String(row.product_size_id) === String(size.id));
        if (!product || !offer) continue;
        if (value('brand_id') && String(product.brand_id).toLowerCase() !== value('brand_id')) continue;
        if (value('gender') && product.gender !== value('gender')) continue;
        if (!links('product_categories', product.id, 'category_id', value('category_id'))) continue;
        if (!links('product_occasions', product.id, 'occasion_id', value('occasion_id'))) continue;
        if (!links('product_notes', product.id, 'note_id', value('note_id'))) continue;
        if (value('store_id') && String(offer.store_id).toLowerCase() !== value('store_id')) continue;
        if (value('size_ml') && Number(size.size_ml) !== Number(value('size_ml'))) continue;
        if (value('price_min') && Number(offer.price) < Number(value('price_min'))) continue;
        if (value('price_max') && Number(offer.price) > Number(value('price_max'))) continue;
        if (value('search') && !String(product.name).toLowerCase().includes(value('search').toLowerCase())) continue;
        const relation = (linksTable, column, dictionary) => (tables[linksTable] || []).filter((row) => String(row.product_id) === String(product.id)).map((row) => ({ id: row[column], key: (dictionary || []).find((item) => String(item.id) === String(row[column]))?.key })).filter((row) => row.key !== undefined);
        const cats = relation('product_categories', 'category_id', tables.categories);
        const occs = relation('product_occasions', 'occasion_id', tables.occasions);
        const notes = relation('product_notes', 'note_id', tables.aromatic_notes);
        result.push({ product_id: product.id, product_size_id: size.id, name: product.name, size_ml: size.size_ml, size_label: size.size_label, gender: product.gender || null,
          category_ids: cats.map((row) => row.id), category_keys: cats.map((row) => row.key),
          occasion_ids: occs.map((row) => row.id), occasion_keys: occs.map((row) => row.key),
          note_ids: notes.map((row) => row.id), note_keys: notes.map((row) => row.key),
          store_product_id: offer.store_product_id, store_id: offer.store_id, price: Number(offer.price), currency: offer.currency });
      }
      result.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ar') || Number(a.size_ml || 0) - Number(b.size_ml || 0));
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 1000);
      return result.slice(offset, offset + limit);
    }
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
    catalog_platform_offers: [
      { product_size_id: id(201), store_product_id: id(301), store_id: STORE_1, price: 100, currency: 'EGP', is_available: true, stock_quantity: null, sync_status: 'synced', store_status: 'active' },
      { product_size_id: id(202), store_product_id: id(307), store_id: STORE_2, price: 120, currency: 'EGP', is_available: true, stock_quantity: 2, sync_status: 'synced', store_status: 'active' },
      { product_size_id: id(203), store_product_id: id(308), store_id: STORE_2, price: 700, currency: 'EGP', is_available: true, stock_quantity: 9, sync_status: 'synced', store_status: 'active' },
      { product_size_id: id(204), store_product_id: id(309), store_id: STORE_1, price: 50, currency: 'EGP', is_available: true, stock_quantity: 5, sync_status: 'synced', store_status: 'active' }
    ],
    brands: [{ id: BRAND_A, name: 'Atelier', is_active: true }, { id: BRAND_B, name: 'Dormant', is_active: false }],
    stores: [{ id: STORE_1, name: 'Store One', status: 'active' }, { id: STORE_2, name: 'Store Two', status: 'inactive' }],
    categories: [{ id: CAT, key: 'floral' }, { id: id(22), key: 'amber' }],
    occasions: [{ id: OCC, key: 'work' }], aromatic_notes: [{ id: NOTE, key: 'oud' }]
  };
}

const sizeIds = (rows) => rows.map((r) => r.product_size_id);

test('without filters the RPC returns published sizes with the platform-selected offer and no direct offer-table query', async () => {
  const db = fakeDb(catalogTables());
  const rows = await createCatalog(db.sb).perfumes({}, {});
  assert.deepEqual(sizeIds(rows).sort(), [id(201), id(202), id(203), id(204)].sort());
  assert.equal(rows[0].name, 'Amber Night');
  assert.ok(db.calls.some((c) => c.startsWith('rpc/catalog_filter_product_sizes?')), 'all filters use one RPC');
  assert.ok(!db.calls.some((c) => c.startsWith('store_products') || c.startsWith('catalog_platform_offers')), 'the editor does not recompute or reselect offers');
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

test('gender filters use products.gender; category IDs stay tied to product_categories and results expose keys', async () => {
  const tables = catalogTables();
  tables.products[0].gender = 'men';
  tables.products[1].gender = 'women';
  tables.products[2].gender = 'unisex';
  tables.categories = [{ id: CAT, key: 'women', name: 'ملصق متغير' }, { id: id(22), key: 'men', name: 'رجالي قديم' }];
  tables.occasions = [{ id: OCC, key: 'work', name: 'ملصق مناسبة متغير' }];
  tables.aromatic_notes = [{ id: NOTE, key: 'oud', name: 'ملصق نوتة متغير' }];
  // Deliberately disagree with products.gender: the stable gender enum is authoritative.
  tables.product_categories = [{ product_id: id(101), category_id: CAT }, { product_id: id(102), category_id: id(22) }];
  const catalog = createCatalog(fakeDb(tables).sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { category_id: CAT })), [id(201), id(202)], 'category_id is an independent product_categories relation filter');
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { gender: 'men' })).sort(), [id(201), id(202)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { gender: 'women' })), [id(203)]);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { gender: 'unisex' })), [id(204)], 'products.gender works without any category relation row');
  const row = (await catalog.perfumes({}, { occasion_id: OCC, note_id: NOTE, gender: 'men' }))[0];
  assert.equal(row.gender, 'men');
  assert.deepEqual(row.category_ids, [CAT]);
  assert.deepEqual(row.category_keys, ['women']);
  assert.deepEqual(row.occasion_ids, [OCC]);
  assert.deepEqual(row.occasion_keys, ['work']);
  assert.deepEqual(row.note_ids, [NOTE]);
  assert.deepEqual(row.note_keys, ['oud']);
  assert.deepEqual(row.category_ids.map((value) => typeof value), ['string'], 'UUIDs are returned directly rather than selector indexes');
});

test('a store filter returns only the store that owns the exact global cheapest eligible offer', async () => {
  const db = fakeDb(catalogTables());
  const catalog = createCatalog(db.sb);
  const globalRows = await catalog.perfumes({}, { price_min: 100, price_max: 100 });
  assert.deepEqual(sizeIds(globalRows), [id(201)]);
  assert.equal(globalRows[0].store_id, STORE_1);
  assert.equal(globalRows[0].store_product_id, id(301));
  assert.equal(globalRows[0].price, 100);
  assert.equal(globalRows[0].currency, 'EGP');
  assert.equal(globalRows[0].store_product_id, id(301), 'price and store_product_id come from the same selected offer row');
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_1 })).sort(), [id(201), id(204)].sort(), 'store filter checks ownership of the canonical platform offer');
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_2 })).sort(), [id(202), id(203)].sort());
  const storeCall = db.calls.find((c) => c.includes('p_store_id=' + STORE_1));
  assert.match(storeCall, new RegExp('p_store_id=' + STORE_1));
  assert.ok(!db.calls.some((c) => c.startsWith('catalog_platform_offers')), 'the RPC owns eligibility and selection');
});

test('price limits compare against the cheapest eligible offer, inclusive at both ends', async () => {
  const catalog = createCatalog(fakeDb(catalogTables()).sb);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 100, price_max: 100 })), [id(201)]);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_max: 100 })).sort(), [id(201), id(204)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 120 })).sort(), [id(202), id(203)].sort());
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { price_min: 1300 })), []);
  // Price limits remain global even while restricting ownership to a store.
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_2, price_min: 100, price_max: 100 })), []);
  assert.deepEqual(sizeIds(await catalog.perfumes({}, { store_id: STORE_2, price_min: 120, price_max: 120 })), [id(202)]);
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
    { brand_id: 'not-a-uuid' }, { store_id: "x' or 1=1" }, { category_id: 5 }, { category_id: [CAT] }, { gender: 'male' }, { gender: ['men', 'women'] }, { size_ml: 0 }, { size_ml: 2.5 },
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
  const offers = sizes.map((size, n) => ({ product_size_id: size.id, store_product_id: id(80000 + n), store_id: STORE_1, price: 100, currency: 'EGP' }));
  const db = fakeDb({ products, product_sizes: sizes, catalog_platform_offers: offers });
  const rows = await createCatalog(db.sb).perfumes({}, {});
  assert.equal(rows.length, 2400);
  assert.equal(new Set(sizeIds(rows)).size, 2400);
  assert.ok(db.calls.filter((c) => c.startsWith('rpc/catalog_filter_product_sizes')).length >= 3);
});

test('size options are distinct, named and sorted', async () => {
  const tables = catalogTables();
  tables.product_sizes.push({ id: id(206), product_id: id(102), size_ml: 30, size_label: '30 ml' }, { id: id(207), product_id: id(102), size_ml: null, size_label: 'Set' });
  const options = await createCatalog(fakeDb(tables).sb).options({});
  assert.deepEqual(options.sizes, [{ size_ml: 30, name: '30 ml' }, { size_ml: 50, name: '50 ml' }, { size_ml: 100, name: '100 ml' }]);
  assert.deepEqual(options.brands.map((b) => b.name), ['Atelier'], 'inactive brands are not offered');
  assert.deepEqual(options.stores.map((s) => s.name), ['Store One'], 'inactive stores are not offered');
});
