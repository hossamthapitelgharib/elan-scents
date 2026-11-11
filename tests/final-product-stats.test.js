// The final, cumulative figures table (migration 20261109060420_final_product_stats_table). NOTE: its "customers first, stores
// only as a fallback" rule was replaced on 2026-11-09 by the average of both sides (20261110060252_product_stats_mean_of_customers_and_stores,
// pinned in tests/product-stats-mean-of-customers-and-stores.test.js); this file keeps describing the migration file as it was applied.
// The real-database behaviour is checked by tests/final-product-stats.test.sql; this file keeps the files that belong together
// together and pins the rules that must not drift: figures are all-time (no window), the stores' figures are used only when the
// customers have none and are never summed with them, retention folds a guest's views into the anonymous archive BEFORE
// deleting it, request_count is gone, the ranking and the card read the table, and nothing public can run the writers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261109060420_final_product_stats_table.sql';
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
const section = (m, from, to) => m.slice(m.indexOf(from), to ? m.indexOf(to) : undefined);

test('the migration has its rollback and its real-database test, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'final-product-stats.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  const rollback = read('supabase', 'rollback', NAME);
  assert.match(rollback, /select cron\.unschedule\('refresh-product-stats-5min'\);/);
  assert.match(rollback, /add column request_count integer not null default 0/, 'the dropped column comes back');
  assert.match(rollback, /drop function private\.refresh_product_stats\(uuid\[\]\);/);
  assert.match(rollback, /drop function private\.fn_product_final_stats\(\);/);
  assert.match(rollback, /drop table private\.product_activity_archive;/);
  assert.match(rollback, /and e\.occurred_at >= win\.start_ts|e\.occurred_at >= win\.start_ts/, 'the 365-day window comes back');
  assert.match(rollback, /\('c58f79e5-b869-491d-98d9-170bd993c501'::uuid, 250, 100\)/, 'the ten sample rows are written down so they can be restored');
  assert.equal((rollback.match(/::uuid, \d+, \d+\)/g) || []).length, 10);
});

test('the other real-database tests refresh the table before they read it', () => {
  for (const file of ['storefront-rankings.test.sql', 'storefront-ratings-single-source.test.sql', 'store-catalog-figures-ingest.test.sql', 'storefront-activity-from-customer-tables.test.sql']) {
    assert.match(read('tests', file), /perform private\.refresh_product_stats\(\);/, file);
  }
});

test('request_count is dropped, every figure carries its source, and the constraints come after the first refresh replaced the sample rows', () => {
  const m = code();
  assert.match(m, /alter table public\.product_stats\s+drop column request_count,/);
  for (const c of ['views_source', 'sales_source', 'search_source', 'rating_source']) {
    assert.match(m, new RegExp(`add column ${c} text check \\(${c} in \\('customers', 'store_catalog'\\)\\)`));
  }
  assert.doesNotMatch(m, /distinctiveness_score/, 'distinctiveness_score is left alone');
  const refresh = m.indexOf('select private.refresh_product_stats();\n\nalter table public.product_stats');
  const constraints = m.indexOf('add constraint product_stats_views_source_matches');
  assert.ok(refresh > 0 && constraints > refresh, 'the sample rows must be replaced before the table refuses a figure without a source');
  for (const c of ['views', 'sales', 'search']) {
    assert.match(m, new RegExp(`add constraint product_stats_${c}_source_matches check \\(\\(${c}_source is null\\) = \\(${c}_count = 0\\)\\)`));
  }
  assert.match(m, /add constraint product_stats_rating_source_matches check \(\(rating_source is null\) = \(average_rating is null\)\)/);
  assert.doesNotMatch(m, /\b(delete from|truncate|drop table)\s+(public\.)?product_stats/i);
});

test('the customers\' figures are all time: no window, and the archive of deleted guests is added', () => {
  const m = code();
  const fn = section(m, 'create or replace function private.fn_product_public_activity()', 'comment on function private.fn_product_public_activity()');
  assert.doesNotMatch(fn, /\b36[45]\b|interval|start_ts|end_ts|d_start|occurred_at >=|activity_date between/, 'no time window');
  assert.match(fn, /from public\.guest_product_analytics a\s+where a\.event_type in \('view', 'search'\)/);
  assert.match(fn, /from public\.customer_product_events e\s+where e\.user_id is not null\s+and e\.event_type in \('view', 'search'\)/);
  assert.match(fn, /from private\.product_activity_archive r/);
  assert.match(fn, /public\.registered_customer_best_sellers/);
  assert.match(fn, /stable\s+security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('a store figure is used only when the customers have none, and the two are never summed', () => {
  const m = code();
  const fn = section(m, 'create or replace function private.refresh_product_stats(', "revoke all on function private.refresh_product_ratings");
  assert.match(fn, /case when coalesce\(a\.views, 0\) > 0 then a\.views when coalesce\(sv\.v, 0\) > 0 then sv\.v else 0 end/);
  assert.match(fn, /case when coalesce\(a\.sales, 0\) > 0 then a\.sales when coalesce\(ss\.v, 0\) > 0 then ss\.v else 0 end/);
  assert.match(fn, /case when coalesce\(a\.searches, 0\) > 0 then a\.searches when coalesce\(sq\.v, 0\) > 0 then sq\.v else 0 end/);
  assert.doesNotMatch(fn, /a\.views \+ |a\.sales \+ |a\.searches \+ /, 'never summed');
  assert.equal((fn.match(/join public\.stores st on st\.id = t\.store_id and st\.status = 'active'/g) || []).length, 3, 'an inactive store never counts');
  assert.match(fn, /left join private\.fn_product_rating_sources\(\) r on r\.product_id = p\.id/, 'the one rating rule');
  assert.match(fn, /on conflict \(product_id\) do update/);
  assert.match(fn, /is distinct from/, 'only the rows that changed are written');
  assert.match(fn, /security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('only the server side can run the writers; the job runs every 5 minutes; the review trigger refreshes one perfume', () => {
  const m = code();
  assert.match(m, /revoke all on function private\.refresh_product_ratings\(uuid\[\]\) from public, anon, authenticated;/);
  assert.match(m, /revoke all on function private\.refresh_product_stats\(uuid\[\]\) from public, anon, authenticated;/);
  assert.doesNotMatch(m, /grant execute on function private\.refresh_product_(stats|ratings)/);
  assert.match(m, /select cron\.schedule\(\s*'refresh-product-stats-5min',\s*'\*\/5 \* \* \* \*',\s*'select private\.refresh_product_stats\(\);'\s*\);/);
  const trigger = section(m, 'create or replace function private.refresh_product_rating()', 'create or replace function private.fn_product_final_stats()');
  assert.match(trigger, /perform private\.refresh_product_ratings\(array_remove\(array\[new\.product_id, old\.product_id\], null\)\);/);
  assert.doesNotMatch(trigger, /update public\.product_stats|round\(avg/, 'no raw average that ignores the 3-ratings rule');
  assert.doesNotMatch(m, /create (or replace )?function public\.refresh_product/, 'a public function would become a client RPC');
});

test('retention folds a deleted browser\'s views and searches into the archive BEFORE it deletes them, and the archive holds no visitor', () => {
  const m = code();
  assert.match(m, /create table private\.product_activity_archive \(\s*product_id uuid not null references public\.products \(id\) on delete cascade,\s*event_type text not null check \(event_type in \('view', 'search'\)\),\s*event_count bigint not null default 0 check \(event_count >= 0\),\s*updated_at timestamptz not null default now\(\),\s*primary key \(product_id, event_type\)\s*\);/);
  assert.match(m, /alter table private\.product_activity_archive enable row level security;\s*revoke all on table private\.product_activity_archive from public, anon, authenticated;/);
  const purge = section(m, 'create or replace function public.purge_expired_guest_fingerprints(', 'select private.refresh_product_stats();');
  const fold = purge.indexOf('insert into private.product_activity_archive');
  const del = purge.indexOf('delete from public.guest_product_analytics where visitor_hash = any(v_hashes);');
  assert.ok(fold > 0 && del > fold, 'fold first, delete second');
  assert.match(purge, /on conflict \(product_id, event_type\) do update\s+set event_count = t\.event_count \+ excluded\.event_count/);
  assert.match(purge, /a\.event_type in \('view', 'search'\) and a\.product_id is not null/);
  assert.match(purge, /if p_retention is null or p_retention < interval '30 days' then/, 'the typo guard stays');
  assert.match(purge, /security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('the ranking and the card read the final table, through a private function the visitor roles may run', () => {
  const m = code();
  assert.match(m, /revoke all on function private\.fn_product_final_stats\(\) from public;\s*grant execute on function private\.fn_product_final_stats\(\) to anon, authenticated, service_role;/);
  const rank = section(m, 'create or replace function private.fn_storefront_product_rankings()', 'create or replace view public.public_products');
  assert.match(rank, /join private\.fn_product_final_stats\(\) s on s\.product_id = f\.product_id/);
  assert.doesNotMatch(rank, /public\.reviews|store_catalog_|fn_product_public_activity|fn_product_rating_sources/, 'the ranking no longer recomputes anything');
  assert.match(rank, /order by \(ssrc = 'customers'\) desc nulls last, sales desc/, 'customers-sourced figures first');
  assert.match(rank, /order by \(rsrc = 'customers'\) desc nulls last, ar desc nulls last, rn desc nulls last/);
  const view = section(m, 'create or replace view public.public_products');
  assert.match(view, /create or replace view public\.public_products with \(security_invoker = true\) as/);
  assert.match(view, /LEFT JOIN private\.fn_product_final_stats\(\) st ON st\.product_id = p\.id/);
  assert.match(view, /nullif\(st\.reviews_count, 0\) AS reviews_count/, 'no rating -> NULL on the card, as before');
  assert.doesNotMatch(view, /request_count|distinctiveness_score|catalog_bestseller/);
});

test('the storefront still selects only columns the view has', () => {
  const core = read('app-core.js');
  const select = core.match(/ga\('public_products\?select=([^']*)'/)[1];
  assert.equal(select, 'id,name,brand_name,sales_count,views_count,search_count,average_rating,reviews_count,short_description,official_description,composition,gender&order=id.asc');
  assert.doesNotMatch(core, /request_count/);
});
