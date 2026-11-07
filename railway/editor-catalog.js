/* Élan Scents — catalogue lookups for the editor's creation panels (server only, service role).
   All results are read from catalog_filter_product_sizes: one SQL query applies the cross-dimension
   filters with EXISTS and returns the platform-selected price with its exact store_product_id. */
'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE = 1000;
const MAX_PAGES = 50;

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
  if (raw.gender !== undefined && raw.gender !== null && raw.gender !== '') {
    if (!['men', 'women', 'unisex'].includes(raw.gender)) throw fail('invalid_perfume_filter');
    out.gender = raw.gender;
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
  async function fetchAll(ctx, table, query) {
    const rows = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const base = query || '';
      const separator = base.includes('?') ? '&' : '?';
      const chunk = await sb(ctx, table, base + separator + 'limit=' + PAGE + '&offset=' + (page * PAGE));
      if (!Array.isArray(chunk)) throw fail('catalog_read_failed', 502);
      rows.push(...chunk);
      if (chunk.length < PAGE) return rows;
    }
    throw fail('catalog_too_large', 502);
  }

  async function options(ctx) {
    const [brands, stores, categories, occasions, notes] = await Promise.all([
      sb(ctx, 'brands', '?select=id,name&is_active=eq.true&order=name.asc&limit=500'),
      sb(ctx, 'stores', '?select=id,name&status=eq.active&order=name.asc,id.asc&limit=500'),
      sb(ctx, 'categories', '?select=id,key,name&order=name.asc&limit=500'),
      sb(ctx, 'occasions', '?select=id,key,name&order=name.asc&limit=500'),
      sb(ctx, 'aromatic_notes', '?select=id,key,name&order=name.asc&limit=500')
    ]);
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

  async function perfumes(ctx, filters) {
    const f = cleanPerfumeFilters(filters);
    const args = new URLSearchParams();
    for (const [key, value] of Object.entries(f)) args.set('p_' + key, String(value));
    const query = args.toString() ? '?' + args.toString() : '';
    return fetchAll(ctx, 'rpc/catalog_filter_product_sizes', query);
  }

  return { options, perfumes };
};
