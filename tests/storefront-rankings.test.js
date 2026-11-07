// The rankings behind the four Masterpieces buttons (migration 20261107135337_storefront_rankings_from_store_catalogs).
// The real-database behaviour is checked by tests/storefront-rankings.test.sql; this file keeps the files that belong together together
// and pins the rules that must not drift: nobody types a ranking figure in, customers' real figures come first, only perfumes offered right now are ranked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const VERSION = '20261107135337';
const NAME = VERSION + '_storefront_rankings_from_store_catalogs.sql';
const TABLES = ['store_catalog_best_sellers', 'store_catalog_most_viewed', 'store_catalog_most_searched', 'store_catalog_ratings'];
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');

test('the migration has its rollback and its real-database test, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'storefront-rankings.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  const rollback = read('supabase', 'rollback', NAME);
  for (const t of TABLES) assert.match(rollback, new RegExp('drop table if exists public\\.' + t + ';'));
  assert.match(rollback, /drop view if exists public\.storefront_product_rankings;/);
  assert.match(rollback, /drop function if exists private\.fn_storefront_product_rankings\(\);/);
  assert.match(rollback, /raise exception 'the store catalog ranking tables hold % rows reported by stores/, 'a rollback never throws away what stores reported');
});

test('there is one table per ranking, every row belongs to one store offer, and the keys are copied from that offer', () => {
  const m = code();
  for (const t of TABLES) {
    assert.match(m, new RegExp('create table public\\.' + t + ' \\(\\s*store_product_id uuid primary key references public\\.store_products\\(id\\) on delete cascade,\\s*store_id uuid not null references public\\.stores\\(id\\) on delete cascade,\\s*product_size_id uuid not null references public\\.product_sizes\\(id\\) on delete cascade,'), t);
    assert.match(m, new RegExp('create trigger ' + t + '_sync_keys before insert or update on public\\.' + t));
  }
  assert.match(m, /select sp\.store_id, sp\.product_size_id into new\.store_id, new\.product_size_id\s+from public\.store_products sp where sp\.id = new\.store_product_id;/);
  assert.match(m, /average_rating numeric\(3,2\) not null check \(average_rating >= 1 and average_rating <= 5\)/);
});

test('nobody can type a ranking figure in: the tables are read-only for every client role and written only by the server', () => {
  const m = code();
  for (const t of TABLES) {
    assert.match(m, new RegExp('alter table public\\.' + t + ' enable row level security;'));
    assert.match(m, new RegExp('revoke all on table public\\.' + t + ' from public, anon, authenticated;'));
    assert.match(m, new RegExp('grant select on table public\\.' + t + ' to authenticated;'));
    assert.match(m, new RegExp('grant all on table public\\.' + t + ' to service_role;'));
    assert.match(m, new RegExp('create policy ' + t + '_read on public\\.' + t + ' for select to authenticated\\s+using \\(\\(select private\\.is_platform_admin\\(\\)\\) or \\(select private\\.is_store_member\\(store_id\\)\\)\\);'));
  }
  assert.doesNotMatch(m, /for (insert|update|delete|all)\b/i, 'no write policy for any client role');
  assert.doesNotMatch(m, /grant (insert|update|delete|all)[^;]* to (anon|authenticated)/i, 'no write grant for any client role');
  assert.doesNotMatch(m, /to anon[^;]*on table public\.store_catalog|on table public\.store_catalog[^;]* to anon/i, 'visitors read none of the store tables');
});

test('customers first, then the stores\' catalogs; only perfumes the platform offers right now; stores that are not active do not count', () => {
  const m = code();
  assert.match(m, /from private\.fn_catalog_public_platform_offers\(\) o\s+join public\.products p on p\.id = o\.product_id and p\.status = 'published' and p\.is_active/, 'bound to the canonical cheapest-offer-per-size contract');
  assert.match(m, /from private\.fn_product_public_activity\(\) a/, 'customers\' real sales, views and searches');
  assert.match(m, /from public\.reviews r\s+where r\.is_approved\s+group by r\.product_id\s+having count\(\*\) >= 3/, 'customers\' rating: approved reviews only, at least 3');
  assert.equal((m.match(/join public\.stores st on st\.id = t\.store_id and st\.status = 'active'/g) || []).length, 4, 'every store figure ignores inactive stores');
  assert.match(m, /having sum\(t\.ratings_count\) >= 3/, 'a store rating needs at least 3 ratings');
  assert.match(m, /order by cs desc, ss desc/, 'sales: customers\' units, then the stores\'');
  assert.match(m, /order by cv desc, sv desc/, 'views: customers\' views, then the stores\'');
  assert.match(m, /order by cq desc, sq desc/, 'searches: customers\' searches, then the stores\'');
  assert.match(m, /order by ca desc nulls last, cn desc nulls last, sa desc nulls last, sn desc nulls last/, 'rating: customers\' average, then their count, then the stores\'');
  assert.match(m, /case when r\.cs > 0 then 'customers' when r\.ss > 0 then 'store_catalog' end/, 'each rank says which source decided it');
  assert.match(m, /rank\(\) over/, 'equal figures share a rank');
  assert.doesNotMatch(m, /row_number\(\)/);
});

test('nothing is exposed that was not: helpers are private, the view shows ids, ranks and sources only, and keeps the caller\'s rights', () => {
  const m = code();
  assert.doesNotMatch(m, /create (or replace )?function public\./i, 'no client RPC');
  assert.match(m, /create or replace function private\.fn_storefront_product_rankings\(\)[\s\S]*?security definer\s+set search_path to 'public', 'pg_temp'/);
  assert.match(m, /grant execute on function private\.fn_storefront_product_rankings\(\) to anon, authenticated, service_role;/, 'the security_invoker view runs the function with the caller\'s rights: EXECUTE must stay granted');
  assert.match(m, /create or replace view public\.storefront_product_rankings with \(security_invoker = true\)/);
  assert.match(m, /grant select on public\.storefront_product_rankings to anon, authenticated, service_role;/);
  const view = m.slice(m.indexOf('create or replace view public.storefront_product_rankings'));
  assert.doesNotMatch(view.slice(0, view.indexOf('revoke all')), /user_id|visitor_hash|search_text|session_id|guest_id|units_sold|views_count|searches_count|average_rating|ratings_count/i, 'no count and no identity in the view');
});

test('the storefront reads the ranking view, tolerates its absence, and never reads the store tables itself', () => {
  const core = read('app-core.js');
  assert.match(core, /ga\('storefront_product_rankings\?select=product_id,sales_rank,views_rank,searches_rank,rating_rank&order=product_id\.asc'\)\.catch\(/);
  for (const t of TABLES) assert.doesNotMatch(core, new RegExp(t), t + ' is not a storefront source');
});
