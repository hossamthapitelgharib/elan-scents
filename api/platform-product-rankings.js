const { getContext, requireRoles } = require('./_auth');

/* The platform's all-time perfume rankings, for platform admins only.
   public.product_stats holds ONE cumulative row per perfume (no time window; nothing ages out), so reading it IS the all-time picture:
   sales, views, searches and rating, each with the source it came from (customers, store_catalog or combined).
   Nothing here is computed again: the figures are the final ones the storefront ranks with; this only orders them, with ties sharing a rank. */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SOURCES = new Set(['customers', 'store_catalog', 'combined']);

/* Ties share a rank (1, 2, 2, 4): the rank of a row is 1 + the number of rows ahead of it with a different (better) key. */
const METRICS = [
  { key: 'sales', value: 'sales_count', source: 'sales_source', order: 'sales_count.desc,product_id.asc', present: 'sales_source=not.is.null', tie: row => [row.sales_count] },
  { key: 'views', value: 'views_count', source: 'views_source', order: 'views_count.desc,product_id.asc', present: 'views_source=not.is.null', tie: row => [row.views_count] },
  { key: 'searches', value: 'search_count', source: 'search_source', order: 'search_count.desc,product_id.asc', present: 'search_source=not.is.null', tie: row => [row.search_count] },
  { key: 'rating', value: 'average_rating', source: 'rating_source', order: 'average_rating.desc,reviews_count.desc,product_id.asc', present: 'average_rating=not.is.null', tie: row => [row.average_rating, row.reviews_count] }
];

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

/* ?limit=20 (1..100). Anything else is refused, not silently clamped: the dashboard never asks for it. */
function limitFrom(req) {
  const value = req.query ? req.query.limit : undefined;
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_LIMIT ? number : null;
}

const same = (a, b) => a.length === b.length && a.every((value, index) => Number(value) === Number(b[index]));

function shape(metric, rows) {
  let rank = 0;
  let previous = null;
  return rows.map((row, index) => {
    const key = metric.tie(row);
    if (!previous || !same(previous, key)) rank = index + 1;
    previous = key;
    const item = {
      rank,
      productId: row.product_id,
      name: (row.products && row.products.name) || null,
      brand: (row.products && row.products.brands && row.products.brands.name) || null,
      value: Number(row[metric.value]),
      source: SOURCES.has(row[metric.source]) ? row[metric.source] : null
    };
    if (metric.key === 'rating') {
      item.count = Number(row.reviews_count) || 0;
      /* The same two conditions the storefront's «الأكثر تقييمًا» uses: >= 3 ratings at one participant and stars >= 3.00. */
      item.inStorefrontRanking = Number(row.rating_top_source_count) >= 3 && Number(row.average_rating) >= 3;
    }
    return item;
  });
}

module.exports = async function platformProductRankings(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const limit = limitFrom(req);
    if (limit === null) return reply(res, 400, { ok: false, error: 'invalid_limit' });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const select = 'product_id,views_count,views_source,sales_count,sales_source,search_count,search_source,average_rating,reviews_count,rating_top_source_count,rating_source,products(name,brands(name))';
    const results = await Promise.all(METRICS.map(async metric => {
      const query = `select=${encodeURIComponent(select)}&${metric.present}&order=${metric.order}&limit=${limit + 1}`;
      const response = await fetch(`${context.supabaseUrl}/rest/v1/product_stats?${query}`, { headers });
      if (!response.ok) return null;
      const rows = await response.json();
      return Array.isArray(rows) ? { metric, rows } : null;
    }));
    if (results.some(result => result === null)) return reply(res, 502, { ok: false, error: 'product_rankings_unavailable' });
    const rankings = {};
    const hasMore = {};
    for (const { metric, rows } of results) {
      hasMore[metric.key] = rows.length > limit;
      rankings[metric.key] = shape(metric, rows.slice(0, limit));
    }
    return reply(res, 200, { ok: true, scope: 'all_time', limit, rankings, hasMore });
  } catch (_) {
    return reply(res, 502, { ok: false, error: 'product_rankings_unavailable' });
  }
};
