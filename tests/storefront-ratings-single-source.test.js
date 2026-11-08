// One source for a perfume's rating (migration 20261108061117_storefront_ratings_single_source).
// The real-database behaviour is checked by tests/storefront-ratings-single-source.test.sql; this file keeps the files that belong
// together together and pins the rules that must not drift: the card and the "most rated" ranking read ONE function, a rating needs
// at least 3 real ratings, and the columns nothing can back (or a store can switch by hand) are not in the public view.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261108061117_storefront_ratings_single_source.sql';
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');

test('the migration has its rollback and its real-database test, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'storefront-ratings-single-source.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  const rollback = read('supabase', 'rollback', NAME);
  assert.match(rollback, /drop function if exists private\.fn_product_rating_sources\(\);/);
  assert.match(rollback, /ps\.request_count,\s*ps\.average_rating,\s*ps\.reviews_count,\s*ps\.distinctiveness_score/, 'the old columns come back from product_stats');
  assert.match(rollback, /grant select on public\.public_products to anon, authenticated, service_role;/);
});

test('a rating exists only with at least 3 real ratings: customers\' approved reviews first, otherwise active stores\' catalog ratings', () => {
  const m = code();
  const fn = m.slice(m.indexOf('create or replace function private.fn_product_rating_sources()'), m.indexOf('comment on function private.fn_product_rating_sources()'));
  assert.match(fn, /from public\.reviews r\s+where r\.is_approved\s+group by r\.product_id\s+having count\(\*\) >= 3/);
  assert.match(fn, /join public\.stores st on st\.id = t\.store_id and st\.status = 'active'/);
  assert.match(fn, /having sum\(t\.ratings_count\) >= 3/);
  assert.match(fn, /coalesce\(c\.avg_rating, s\.avg_rating\)/, 'customers win over stores');
  assert.match(fn, /stable\s+security definer\s+set search_path to 'public', 'pg_temp'/);
  assert.match(m, /revoke all on function private\.fn_product_rating_sources\(\) from public;\s*grant execute on function private\.fn_product_rating_sources\(\) to anon, authenticated, service_role;/, 'the security_invoker view needs EXECUTE for its callers');
});

test('the ranking and the card read the same function, so they cannot disagree', () => {
  const m = code();
  const rank = m.slice(m.indexOf('create or replace function private.fn_storefront_product_rankings()'), m.indexOf('drop view public.public_products;'));
  assert.match(rank, /left join private\.fn_product_rating_sources\(\) ra on ra\.product_id = f\.product_id/);
  assert.doesNotMatch(rank, /public\.reviews|store_catalog_ratings/, 'the ranking no longer repeats the calculation');
  assert.match(rank, /order by \(rsrc = 'customers'\) desc nulls last, ar desc nulls last, rn desc nulls last/, 'customers first, then the stores; best first');
  const view = m.slice(m.indexOf('create view public.public_products'));
  assert.match(view, /rt\.average_rating::numeric\(3,2\) AS average_rating,\s*rt\.ratings_count AS reviews_count/);
  assert.match(view, /LEFT JOIN private\.fn_product_rating_sources\(\) rt ON rt\.product_id = p\.id/);
});

test('public_products keeps its safety and loses the columns nothing can back', () => {
  const m = code();
  const view = m.slice(m.indexOf('create view public.public_products'));
  assert.match(view, /create view public\.public_products with \(security_invoker = true\) as/);
  assert.doesNotMatch(view, /request_count|distinctiveness_score|catalog_bestseller|is_catalog_bestseller|product_stats/, 'no dead column, no hand-switchable flag, no sample numbers');
  assert.match(m, /revoke all on public\.public_products from public, anon, authenticated;\s*grant select on public\.public_products to anon, authenticated, service_role;/);
  assert.doesNotMatch(m, /product_stats[^;]*\b(delete|truncate|drop|update)\b|\b(delete from|truncate|drop table|update)\s+public\.product_stats/i, 'the sample data is left alone');
});

test('the storefront no longer reads what the view no longer has', () => {
  const core = read('app-core.js');
  const select = core.match(/ga\('public_products\?select=([^']*)'/)[1];
  assert.equal(select, 'id,name,brand_name,sales_count,views_count,search_count,average_rating,short_description,official_description,composition,gender&order=id.asc');
});
