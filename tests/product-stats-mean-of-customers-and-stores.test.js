// The final figures are the AVERAGE of the customers and all the participating stores (migration
// 20261110060252_product_stats_mean_of_customers_and_stores, the owner's decision of 2026-11-09). The real-database behaviour is
// checked by tests/final-product-stats.test.sql (and the rankings / ratings / activity tests); this file pins what must not drift:
// counts = round((customers + the sum of the ACTIVE stores) / 2) with the divisor always 2, a rating = every customer review and
// store rating weighted by their counts from 3 together, a third source value 'combined', the ranking ranks the final figure
// itself (customers do not jump the queue), and the migration only redefines functions / checks / comments - it deletes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261110060252_product_stats_mean_of_customers_and_stores.sql';
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
const section = (m, from, to) => m.slice(m.indexOf(from), to ? m.indexOf(to, m.indexOf(from)) : undefined);

test('the migration has its rollback and the real-database tests that cover it', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  for (const file of ['final-product-stats.test.sql', 'storefront-rankings.test.sql', 'storefront-ratings-single-source.test.sql', 'storefront-activity-from-customer-tables.test.sql']) {
    assert.match(read('tests', file), new RegExp(NAME.replace(/\./g, '\\.')), file + ' names the migration');
  }
  const sqlTest = read('tests', 'final-product-stats.test.sql');
  assert.match(sqlTest, /combined/);
  assert.match(sqlTest, /\(5 \+ 4 \+ 3\*2 \+ 5\*1\) \/ 5 = 4\.00/, 'the weighted rating is checked with numbers that differ from a mean of averages');
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
});

test('the source checks accept the third value, combined, and only these three', () => {
  const m = code();
  for (const c of ['views', 'sales', 'search', 'rating']) {
    assert.match(m, new RegExp(`drop constraint product_stats_${c}_source_check`));
    assert.match(m, new RegExp(`add constraint product_stats_${c}_source_check check \\(${c}_source in \\('customers', 'store_catalog', 'combined'\\)\\)`));
  }
  assert.doesNotMatch(m, /_source_matches/, 'the "source is NULL exactly when the figure is 0" constraints are left alone');
});

test('sales, views and searches are round((customers + all active stores) / 2): the divisor is always 2', () => {
  const m = code();
  const fn = section(m, 'create or replace function private.refresh_product_stats(', 'comment on function private.refresh_product_stats');
  for (const [c, s] of [['views', 'sv'], ['sales', 'ss'], ['searches', 'sq']]) {
    const a = c;
    assert.match(fn, new RegExp(`round\\(\\(coalesce\\(a\\.${a}, 0\\) \\+ coalesce\\(${s}\\.v, 0\\)\\) / 2\\.0\\)::bigint as ${c}`));
  }
  assert.equal((fn.match(/then 'combined'/g) || []).length, 3, 'one combined case per count');
  assert.equal((fn.match(/and st\.status = 'active'/g) || []).length, 3, 'inactive stores never count');
  assert.doesNotMatch(fn, /else 0 end as (views|sales|searches)\b/, 'the old "customers, otherwise stores" fallback is gone');
  assert.match(fn, /least\(c\.views, 2147483647\)::integer/);
  assert.match(fn, /is distinct from/, 'only changed rows are written');
  assert.match(fn, /security definer\s+set search_path to 'public', 'pg_temp'/);
  assert.match(m, /select private\.refresh_product_stats\(\);\s*$/, 'the table is recomputed with the new rule at the end');
});

test('a rating is every customer review and every active store rating, weighted by their counts, from 3 together', () => {
  const m = code();
  const fn = section(m, 'create or replace function private.fn_product_rating_sources()', 'comment on function private.fn_product_rating_sources()');
  assert.match(fn, /sum\(r\.rating\)::numeric as total, count\(\*\)::integer as n/);
  assert.match(fn, /where r\.is_approved/);
  assert.match(fn, /sum\(t\.average_rating \* t\.ratings_count\)::numeric as total, sum\(t\.ratings_count\)::integer as n/);
  assert.match(fn, /st\.status = 'active'/);
  assert.match(fn, /round\(\(coalesce\(c\.total, 0\) \+ coalesce\(s\.total, 0\)\) \/ \(coalesce\(c\.n, 0\) \+ coalesce\(s\.n, 0\)\), 2\)/);
  assert.match(fn, /where coalesce\(c\.n, 0\) \+ coalesce\(s\.n, 0\) >= 3/, 'the 3-ratings rule applies to both sides together');
  assert.doesNotMatch(fn, /having count\(\*\) >= 3|having sum\(t\.ratings_count\) >= 3/, 'no per-side minimum any more');
  assert.match(fn, /'combined'/);
  assert.match(fn, /security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('the four rankings rank the final figure itself: customers-sourced figures no longer come first', () => {
  const m = code();
  const rank = section(m, 'create or replace function private.fn_storefront_product_rankings()', 'comment on view public.public_products');
  assert.match(rank, /join private\.fn_product_final_stats\(\) s on s\.product_id = f\.product_id/);
  assert.doesNotMatch(rank, /\(ssrc = 'customers'\)|\(vsrc = 'customers'\)|\(qsrc = 'customers'\)|\(rsrc = 'customers'\)/);
  assert.match(rank, /partition by \(ssrc is not null\) order by sales desc/);
  assert.match(rank, /partition by \(vsrc is not null\) order by views desc/);
  assert.match(rank, /partition by \(qsrc is not null\) order by searches desc/);
  assert.match(rank, /partition by \(ar is not null\) order by ar desc nulls last, rn desc nulls last/);
  assert.match(rank, /security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('it only redefines functions, checks and comments: nothing is deleted or dropped, no grant changes', () => {
  const m = code();
  assert.doesNotMatch(m, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column|function|view|schema)\b/i);
  assert.doesNotMatch(m, /\bgrant\b|\brevoke\b/i, 'create or replace keeps the existing privileges');
  assert.doesNotMatch(m, /cron\.(un)?schedule/, 'the 5-minute job is left as it is');
  assert.match(m, /alter table public\.product_stats\s+drop constraint product_stats_views_source_check/);
});

test('the rollback restores the previous rule and recomputes before narrowing the checks again', () => {
  const rb = read('supabase', 'rollback', NAME);
  assert.match(rb, /^begin;/m);
  assert.match(rb, /commit;\s*$/);
  assert.match(rb, /case when coalesce\(a\.views, 0\) > 0 then a\.views when coalesce\(sv\.v, 0\) > 0 then sv\.v else 0 end/);
  assert.match(rb, /having count\(\*\) >= 3/);
  assert.match(rb, /order by \(ssrc = 'customers'\) desc nulls last, sales desc/);
  const refresh = rb.indexOf('select private.refresh_product_stats();');
  const narrow = rb.indexOf("add constraint product_stats_views_source_check check (views_source in ('customers', 'store_catalog'))");
  assert.ok(refresh > 0 && narrow > refresh, 'recompute first, then narrow the checks (no row can still say combined)');
});
