/* Élan Scents — catalogue lookups for the editor's creation panels (server only, service role).
   Filters follow the approved panel contract: brand_id, store_id, category_id, occasion_id, note_id,
   size_ml, price_min, price_max and search. Every filter is applied against the real tables
   (product_categories, product_occasions, product_notes, store_products); nothing is simulated. */
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const MAX_PAGES = 50;
const RELATIONS = [
  ['category_id', 'product_categories'],
  ['occasion_id', 'product_occasions'],
  ['note_id', 'product_notes']
];

function fail(code, status) { return Object.assign(new Error(code), { status: status || 400 }); }

function cleanPerfumeFilters(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const key of ['brand_id', 'store_id', 'category_id', 'occasion_id', 'note_id']) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !UUID.test(value)) throw fail('invalid_perfume_filter');
    out[key] = value.toLowerCase();
  }
  if (raw.size_ml !== undefined && raw.size_ml !== null && raw.size_ml !== '') {
    const size = Number(raw.size_ml);
    if (!Number.isInteger(size) || size < 1 || size > 10000) throw fail('invalid_perfume_filter');
    out.size_ml = size;
  }
  for (const key of ['price_min', 'price_max']) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 10000000) throw fail('invalid_perfume_filter');
    out[key] = number;
  }
  if (out.price_min !== undefined && out.price_max !== undefined && out.price_min > out.price_max) throw fail('invalid_perfume_filter');
  const search = String(raw.search == null ? '' : raw.search).trim().slice(0, 100);
  if (search) out.search = search;
  return out;
}

module.exports = function createCatalog(sb) {
  /* PostgREST returns at most one page per request, so read every page with a stable key order. */
  async function fetchAll(ctx, table, query) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const chunk = await sb(ctx, table, query + '&limit=' + PAGE + '&offset=' + (page * PAGE));
      if (!Array.isArray(chunk)) throw fail('catalog_read_failed', 502);
      for (const row of chunk) rows.push(row);
      if (chunk.length < PAGE) return rows;
    }
    throw fail('catalog_too_large', 502);
  }

  async function options(ctx) {
    const [brands, stores, categories, occasions, notes] = await Promise.all([
      sb(ctx, 'brands', '?select=id,name&is_active=eq.true&order=name.asc&limit=500'),
      sb(ctx, 'stores', '?select=id,name&status=eq.active&order=name.asc&limit=500'),
      sb(ctx, 'categories', '?select=id,name&order=name.asc&limit=500'),
      sb(ctx, 'occasions', '?select=id,name&order=name.asc&limit=500'),
      sb(ctx, 'aromatic_notes', '?select=id,name&order=name.asc&limit=500')
    ]);
    // One entry per distinct size, named for the panel's list (the table holds one row per perfume and size).
    const sizeRows = await fetchAll(ctx, 'product_sizes', '?select=id,size_ml&size_ml=not.is.null&order=id.asc');
    const seen = new Set();
    const sizes = [];
    for (const row of sizeRows) {
      const ml = Number(row.size_ml);
      if (!Number.isInteger(ml) || ml < 1 || seen.has(ml)) continue;
      seen.add(ml);
      sizes.push({ size_ml: ml, name: ml + ' ml' });
    }
    sizes.sort((a, b) => a.size_ml - b.size_ml);
    return { brands, stores, categories, occasions, notes, sizes };
  }

  async function productIdsFor(ctx, table, column, id) {
    const rows = await fetchAll(ctx, table, '?select=product_id&' + column + '=eq.' + encodeURIComponent(id) + '&order=product_id.asc');
    return new Set(rows.map((row) => String(row.product_id)));
  }

  /* The approved offer rule: available, in stock, synced, and from an active store.
     Price filters compare against the cheapest such offer (of the chosen store, when one is chosen). */
  async function bestEligiblePrices(ctx, storeId) {
    const query = '?select=id,product_size_id,price,stores!inner(status)&is_available=eq.true&stock_quantity=gt.0&sync_status=eq.synced&stores.status=eq.active'
      + (storeId ? '&store_id=eq.' + encodeURIComponent(storeId) : '') + '&order=id.asc';
    const rows = await fetchAll(ctx, 'store_products', query);
    const best = new Map();
    for (const row of rows) {
      const price = Number(row.price);
      if (!Number.isFinite(price)) continue;
      const key = String(row.product_size_id);
      if (!best.has(key) || price < best.get(key)) best.set(key, price);
    }
    return best;
  }

  async function perfumes(ctx, filters) {
    const f = cleanPerfumeFilters(filters);
    const products = await fetchAll(ctx, 'products', '?select=id,name,brand_id,status,is_active&status=eq.published&is_active=eq.true&order=id.asc');
    const sizes = await fetchAll(ctx, 'product_sizes', '?select=id,product_id,size_ml,size_label&order=id.asc');
    const limits = [];
    for (const [key, table] of RELATIONS) {
      if (f[key]) limits.push(await productIdsFor(ctx, table, key, f[key]));
    }
    const priced = f.store_id !== undefined || f.price_min !== undefined || f.price_max !== undefined;
    const prices = priced ? await bestEligiblePrices(ctx, f.store_id) : null;
    const byId = new Map(products
      .filter((p) => (!f.brand_id || String(p.brand_id) === f.brand_id) && limits.every((set) => set.has(String(p.id))))
      .map((p) => [String(p.id), p]));
    const needle = f.search ? f.search.toLocaleLowerCase() : '';
    const found = [];
    for (const s of sizes) {
      const p = byId.get(String(s.product_id));
      if (!p) continue;
      if (needle && !String(p.name || '').toLocaleLowerCase().includes(needle)) continue;
      if (f.size_ml !== undefined && Number(s.size_ml) !== f.size_ml) continue;
      if (prices) {
        const price = prices.get(String(s.id));
        if (price === undefined) continue;
        if (f.price_min !== undefined && price < f.price_min) continue;
        if (f.price_max !== undefined && price > f.price_max) continue;
      }
      found.push({
        ml: Number(s.size_ml) || 0,
        row: { product_id: p.id, product_size_id: s.id, name: p.name, size_label: s.size_label || (s.size_ml ? String(s.size_ml) + ' ml' : null) }
      });
    }
    found.sort((a, b) => String(a.row.name || '').localeCompare(String(b.row.name || ''), 'ar') || a.ml - b.ml);
    return found.map((x) => x.row);
  }

  return { options, perfumes };
};

module.exports.cleanPerfumeFilters = cleanPerfumeFilters;
