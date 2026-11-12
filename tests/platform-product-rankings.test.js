const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const handler = require(path.join(__dirname, '..', 'api', 'platform-product-rankings'));

function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader(k, v) { (out.headers = out.headers || {})[k] = v; return this; }, json(body) { out.body = body; return this; } }; }
function jsonResponse(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
const configure = () => { process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'; };

const row = (id, extra = {}) => ({ product_id: id, views_count: 0, views_source: null, sales_count: 0, sales_source: null, search_count: 0, search_source: null, average_rating: null, reviews_count: 0, rating_top_source_count: 0, rating_source: null, products: { name: `name-${id}`, brands: { name: 'Brand' } }, ...extra });

/* admin session + a routed product_stats: `answer(url)` returns the rows for one query */
function install(answer, role = 'platform_admin') {
  const stats = [];
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/auth/v1/user')) return jsonResponse({ id: 'u1' });
    if (target.includes('/rest/v1/profiles?select=id,full_name,phone,role')) return jsonResponse([{ id: 'u1', role }]);
    stats.push({ target, options });
    return answer(new URL(target));
  };
  return stats;
}

test('only a platform admin: other roles and other methods never reach product_stats', async () => {
  configure();
  const stats = install(() => jsonResponse([]), 'customer');
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  assert.equal(res.out.status, 403);
  assert.equal(stats.length, 0);
  const post = recorder();
  await handler({ method: 'POST', headers: {} }, post);
  assert.equal(post.out.status, 405);
  const anonymous = recorder();
  await handler({ method: 'GET', headers: {} }, anonymous);
  assert.equal(anonymous.out.status, 401);
});

test('four reads of the cumulative product_stats with the service key, each ordered and filtered by its own source; no time window', async () => {
  configure();
  const stats = install(() => jsonResponse([]));
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' }, query: {} }, res);
  assert.equal(res.out.status, 200);
  assert.equal(stats.length, 4);
  assert.ok(stats.every(({ target, options }) => target.startsWith('https://test.supabase.co/rest/v1/product_stats?') && options.headers.apikey === 'service-key'));
  const by = Object.fromEntries(stats.map(({ target }) => { const u = new URL(target); return [u.searchParams.get('order').split('.')[0], u.searchParams]; }));
  assert.equal(by.sales_count.get('sales_source'), 'not.is.null');
  assert.equal(by.views_count.get('views_source'), 'not.is.null');
  assert.equal(by.search_count.get('search_source'), 'not.is.null');
  assert.equal(by.average_rating.get('average_rating'), 'not.is.null');
  assert.equal(by.average_rating.get('order'), 'average_rating.desc,reviews_count.desc,product_id.asc', 'stars, then the final count');
  assert.ok(stats.every(({ target }) => !/created_at|updated_at|gte\.|lte\.|\bsince\b/.test(decodeURIComponent(target))), 'all-time: no date filter');
  assert.ok(stats.every(({ target }) => /limit=21(&|$)/.test(target)), 'one row more than shown tells whether there is more');
  assert.equal(res.out.body.scope, 'all_time');
  assert.equal(res.out.headers['Cache-Control'], 'no-store');
});

test('ranks with ties sharing a rank, carries each row\'s source, and tells the storefront-eligible ratings apart', async () => {
  configure();
  install(url => {
    const order = url.searchParams.get('order');
    if (order.startsWith('sales_count')) return jsonResponse([row('a', { sales_count: 50, sales_source: 'combined' }), row('b', { sales_count: 30, sales_source: 'customers' }), row('c', { sales_count: 30, sales_source: 'store_catalog' }), row('d', { sales_count: 7, sales_source: 'store_catalog' })]);
    if (order.startsWith('average_rating')) return jsonResponse([
      row('a', { average_rating: '4.00', reviews_count: 305, rating_top_source_count: 500, rating_source: 'combined' }),
      row('b', { average_rating: '4.00', reviews_count: 10, rating_top_source_count: 3, rating_source: 'customers' }),
      row('c', { average_rating: '2.67', reviews_count: 320, rating_top_source_count: 500, rating_source: 'store_catalog' }),
      row('d', { average_rating: '3.00', reviews_count: 2, rating_top_source_count: 2, rating_source: 'store_catalog' })]);
    return jsonResponse([]);
  });
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' }, query: { limit: '20' } }, res);
  const { sales, rating, views } = res.out.body.rankings;
  assert.deepEqual(sales.map(r => [r.rank, r.productId, r.value, r.source]), [[1, 'a', 50, 'combined'], [2, 'b', 30, 'customers'], [2, 'c', 30, 'store_catalog'], [4, 'd', 7, 'store_catalog']]);
  assert.deepEqual(rating.map(r => [r.rank, r.productId, r.value, r.count, r.inStorefrontRanking]), [[1, 'a', 4, 305, true], [2, 'b', 4, 10, true], [3, 'c', 2.67, 320, false], [4, 'd', 3, 2, false]],
    'the same two conditions as the storefront: >= 3 ratings at one participant AND stars >= 3.00');
  assert.deepEqual(views, []);
  assert.equal(sales[0].name, 'name-a');
  assert.equal(sales[0].brand, 'Brand');
});

test('a tie is decided by both stars AND count for the rating ranking', async () => {
  configure();
  install(url => url.searchParams.get('order').startsWith('average_rating')
    ? jsonResponse([row('a', { average_rating: 4, reviews_count: 9, rating_top_source_count: 5, rating_source: 'combined' }), row('b', { average_rating: 4, reviews_count: 9, rating_top_source_count: 5, rating_source: 'combined' }), row('c', { average_rating: 4, reviews_count: 8, rating_top_source_count: 5, rating_source: 'combined' })])
    : jsonResponse([]));
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  assert.deepEqual(res.out.body.rankings.rating.map(r => r.rank), [1, 1, 3]);
});

test('limit: default 20, one more row is read to say hasMore, an out-of-range limit is refused', async () => {
  configure();
  install(url => jsonResponse(url.searchParams.get('order').startsWith('views_count') ? [row('a', { views_count: 3, views_source: 'customers' }), row('b', { views_count: 2, views_source: 'customers' }), row('c', { views_count: 1, views_source: 'customers' })] : []));
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' }, query: { limit: '2' } }, res);
  assert.equal(res.out.body.rankings.views.length, 2);
  assert.equal(res.out.body.hasMore.views, true);
  assert.equal(res.out.body.hasMore.sales, false);
  for (const limit of ['0', '101', 'abc', '2.5']) {
    const bad = recorder();
    await handler({ method: 'GET', headers: { authorization: 'Bearer t' }, query: { limit } }, bad);
    assert.equal(bad.out.status, 400, limit);
    assert.equal(bad.out.body.error, 'invalid_limit');
  }
});

test('a failed read is one clear error, not partial rankings; an unknown source never leaks through', async () => {
  configure();
  install(url => url.searchParams.get('order').startsWith('views_count') ? jsonResponse({ message: 'boom' }, 500) : jsonResponse([]));
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  assert.equal(res.out.status, 502);
  assert.deepEqual(res.out.body, { ok: false, error: 'product_rankings_unavailable' });
  install(url => jsonResponse(url.searchParams.get('order').startsWith('sales_count') ? [row('a', { sales_count: 5, sales_source: '<script>' })] : []));
  const ok = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer t' } }, ok);
  assert.equal(ok.out.body.rankings.sales[0].source, null);
});

test('the handler is registered for the Worker and reads no customer data', () => {
  const registry = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'api-registry.js'), 'utf8');
  assert.match(registry, /'platform-product-rankings': \(\) => require\('\.\.\/api\/platform-product-rankings\.js'\)/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'platform-product-rankings.js'), 'utf8');
  assert.match(source, /requireRoles\(await getContext\(req\), \['platform_admin'\]\)/);
  assert.doesNotMatch(source, /customer_|guest_|profiles|email|phone/i);
});
