// The figures behind the Masterpieces filters (migration 20261106080837_storefront_activity_from_customer_tables).
// The real-database behaviour is checked by tests/storefront-activity-from-customer-tables.test.sql; this file keeps the files that belong together together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const VERSION = '20261106080837';
const NAME = VERSION + '_storefront_activity_from_customer_tables.sql';

test('the migration has its rollback and its real-database test, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'storefront-activity-from-customer-tables.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  const rollback = read('supabase', 'rollback', NAME);
  assert.match(rollback, /drop function if exists private\.fn_product_public_activity\(\)/);
  assert.match(rollback, /ps\.views_count,\s*ps\.sales_count,\s*ps\.search_count/, 'the rollback gives the figures back to product_stats');
});

test('sales come from the best-sellers table, views and searches from the guest and registered activity of the last 365 days', () => {
  const m = read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
  assert.match(m, /from public\.registered_customer_best_sellers s/, 'sales: the best-sellers table of the customers dashboard');
  assert.match(m, /from public\.guest_product_analytics a/, 'views and searches of guests');
  assert.match(m, /from public\.customer_product_events e[\s\S]*?e\.user_id is not null/, 'views and searches of registered customers only: a guest trail is a second copy of the guest counters');
  assert.match(m, /event_type in \('view', 'search'\)/);
  assert.match(m, /d_end - 364 as d_start/, 'the same 365-day window as customer_product_ranking(.., \'year\', ..)');
  assert.match(m, /'Africa\/Cairo'/);
});

test('public_products takes the three figures from the helper and keeps every other column and its security as they were', () => {
  const m = read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
  assert.match(m, /create or replace view public\.public_products with \(security_invoker = true\)/);
  assert.match(m, /COALESCE\(act\.views_count, 0\) AS views_count,\s*COALESCE\(act\.sales_count, 0\) AS sales_count,\s*COALESCE\(act\.search_count, 0\) AS search_count/);
  assert.match(m, /LEFT JOIN private\.fn_product_public_activity\(\) act ON act\.product_id = p\.id/);
  assert.match(m, /ps\.request_count,\s*ps\.average_rating,\s*ps\.reviews_count,\s*ps\.distinctiveness_score/, 'ratings and demand still come from product_stats');
  assert.doesNotMatch(m, /ps\.(views|sales|search)_count/, 'the sample numbers of product_stats are no longer read');
});

test('nothing is exposed that was not: the helper is private, returns only a product id and three counts, and the migration grants nothing', () => {
  const m = read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
  assert.match(m, /create or replace function private\.fn_product_public_activity\(\)/);
  assert.doesNotMatch(m, /create (or replace )?function public\./i, 'no client RPC');
  assert.match(m, /returns table\(product_id uuid, views_count integer, search_count integer, sales_count integer\)/);
  assert.match(m, /security definer\s+set search_path to 'public', 'pg_temp'/);
  assert.doesNotMatch(m, /\bgrant\b|\bcreate policy\b|\bdisable row level security\b|\bto anon\b/i);
  const result = m.slice(m.lastIndexOf('select coalesce(t.product_id, s.product_id)'), m.indexOf('$function$;', m.indexOf('full join sold')));
  assert.match(result, /full join sold s on s\.product_id = t\.product_id/);
  assert.doesNotMatch(result, /user_id|visitor_hash|search_text|session_id|guest_id|snapshot/i, 'no identity column reaches the result');
});

test('the storefront reads the three activity columns and the rating from public_products, and nothing that has no real source', () => {
  const core = read('app-core.js');
  assert.match(core, /public_products\?select=id,name,brand_name,sales_count,views_count,search_count,average_rating,/);
  assert.doesNotMatch(core, /public_products\?select=[^']*(request_count|distinctiveness_score|catalog_bestseller)/, 'the dead / hand-switchable columns are not read');
});
