const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('customer activity migration preserves RLS, full product joins, four rankings, and transfers logs on claim', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261011001908_customer_activity_details.sql'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'customers-dashboard.js'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const snapshotName = '20261013101123_product_activity_snapshots.sql';
  const appliedSnapshot = path.join(root, 'supabase/migrations', snapshotName);
  const snapshotMigration = fs.readFileSync(fs.existsSync(appliedSnapshot) ? appliedSnapshot : path.join(root, 'supabase/pending', snapshotName), 'utf8');
  const searchMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261015032124_customer_search_operations.sql'), 'utf8');
  const migrationDirs = ['supabase/migrations', 'supabase/pending'];
  const transferMigrationPath = migrationDirs.map(dir => {
    const base = path.join(root, dir);
    const name = fs.readdirSync(base).find(file => file.endsWith('_transfer_guest_analytics_on_claim.sql'));
    return name ? path.join(base, name) : null;
  }).find(Boolean);
  assert.ok(transferMigrationPath, 'guest analytics claim-transfer migration must be present');
  const transferMigration = fs.readFileSync(transferMigrationPath, 'utf8');
  const transactionalFixture = fs.readFileSync(path.join(root, 'tests/customer-activity-transactional.test.sql'), 'utf8');
  const core = loadCoreSource();
  assert.match(migration, /create table if not exists public\.customer_sessions/i);
  assert.match(migration, /create table if not exists public\.customer_product_events/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /to_jsonb\(p\)/i);
  assert.match(migration, /update public\.customer_sessions set guest_id=null,user_id=p_user_id where guest_id=v_guest\.id/i);
  assert.match(migration, /update public\.customer_product_events set guest_id=null,user_id=p_user_id/i);
  assert.match(migration, /cart_remove/);
  assert.match(dashboard, /const prefix = actor === 'guest' \? 'guest' : 'registered'/);
  assert.match(dashboard, /\$\{prefix\}TopProducts/); assert.match(dashboard, /\$\{prefix\}BasketProducts/);
  assert.match(dashboard, /data\.topViewed/); assert.match(dashboard, /data\.topSearched/);
  assert.match(dashboard, /data\.topCartAdded/); assert.match(dashboard, /data\.topCartRemoved/);
  assert.match(dashboard, /registeredAnalyticsPeriod/);
  assert.match(identity, /customer-activity/); assert.match(identity, /heartbeat/);
  assert.match(identity, /prepareLogout/);
  for (const eventType of ['view', 'cart_add', 'cart_remove']) {
    assert.match(core, new RegExp(`trackGuestProduct\\(['\"]${eventType}['\"]`));
  }
  assert.match(core, /GuestIdentity\.search\(query,items\)/);
  assert.match(snapshotMigration, /capture_product_snapshot/i);
  assert.match(snapshotMigration, /product_images/i); assert.match(snapshotMigration, /aromaticNotes/i);
  assert.match(snapshotMigration, /storeOffers/i); assert.match(snapshotMigration, /cart_items_product_snapshot/i);
  assert.match(snapshotMigration, /drop constraint if exists customer_product_events_product_id_fkey/i);
  assert.match(snapshotMigration, /drop constraint if exists guest_product_analytics_product_id_fkey/i);
  assert.match(snapshotMigration, /product_snapshot jsonb not null/i);
  assert.match(searchMigration, /create table if not exists public\.customer_searches/i);
  assert.match(searchMigration, /search_text text not null/i);
  assert.match(searchMigration, /result_products jsonb not null/i);
  assert.match(searchMigration, /capture_product_snapshot/i);
  assert.match(searchMigration, /record_customer_product_event/i);
  assert.match(searchMigration, /update public\.customer_searches set guest_id = null, user_id = p_user_id/i);
  assert.match(searchMigration, /platform_customer_search_detail/i);
  assert.match(searchMigration, /grant execute on function public\.record_customer_search[\s\S]*to service_role/i);
  assert.match(searchMigration, /revoke all on public\.customer_searches from public, anon, authenticated/i);
  assert.match(transferMigration, /p_analytics_hash text/i);
  assert.match(transferMigration, /delete from public\.guest_product_analytics\s+where visitor_hash = p_analytics_hash/i);
  assert.match(transferMigration, /delete from public\.guest_analytics_visits\s+where visitor_hash = p_analytics_hash/i);
  assert.match(transferMigration, /update public\.customer_product_events\s+set guest_id = null, user_id = p_user_id/i);
  assert.match(transferMigration, /update public\.customer_searches\s+set guest_id = null, user_id = p_user_id/i);
  assert.match(transactionalFixture, /insert into public\.products\(brand_id, name, slug/i);
  assert.match(transactionalFixture, /delete from public\.products where id = v_snapshot_product_id/i);
  assert.match(transactionalFixture, /activity product snapshot was lost or incomplete after deleting its catalog fixture/i);
  assert.match(transactionalFixture, /search result snapshot was lost after deleting its catalog fixture/i);
  assert.match(transactionalFixture, /claim_guest_browser_cart\(v_guest_hash, v_analytics_hash, v_customer_id\)/i);
  assert.match(transactionalFixture, /guest search history or anonymous product aggregates were not transferred\/removed correctly/i);
  assert.match(dashboard, /عمليات البحث ونتائج المنتجات/);
  assert.match(dashboard, /search\.searchText/);
  assert.match(identity, /search: search/);
  assert.match(core, /GuestIdentity\.search\(query,items\)/);
  assert.match(core, /LAST_GUEST_SEARCH_KEY=signature/);
});

test('category views expose separate customer event tables and current carts to service_role only', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014101846_customer_activity_category_views.sql'), 'utf8');
  const accessMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014102019_restrict_customer_activity_view_access.sql'), 'utf8');
  for (const name of [
    'customer_product_view_events', 'customer_product_search_events',
    'customer_product_cart_add_events', 'customer_product_cart_remove_events',
    'guest_current_cart_items', 'registered_customer_current_cart_items'
  ]) assert.match(migration, new RegExp(`create or replace view public\\.${name}\\s+with \\(security_invoker = true\\)`, 'i'));
  for (const eventType of ['view', 'search', 'cart_add', 'cart_remove']) assert.match(migration, new RegExp(`where event_type = '${eventType}'`, 'i'));
  assert.match(migration, /product_snapshot/);
  assert.match(migration, /jsonb_array_elements\(gv\.cart_snapshot\)/i);
  assert.match(migration, /revoke all privileges[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select on table[\s\S]*to service_role/i);
  assert.match(accessMigration, /revoke all privileges[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(accessMigration, /grant select on table[\s\S]*to service_role/i);
});

test('admin customer details serve immutable product snapshots for current carts and event history', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014093223_platform_customer_detail_product_snapshots.sql'), 'utf8');
  assert.match(migration, /nullif\(e\.product_snapshot, '\{\}'::jsonb\)/i);
  assert.match(migration, /nullif\(ci\.product_snapshot, '\{\}'::jsonb\)/i);
  assert.match(migration, /productSnapshot/i);
  assert.match(migration, /selectedSize/i);
  assert.match(migration, /selectedOffer/i);
  assert.match(migration, /left join public\.public_products p on p\.id = e\.product_id/i);
  assert.match(migration, /grant execute on function public\.platform_customer_activity_detail\(uuid, uuid, integer, integer\) to service_role/i);
  assert.match(migration, /revoke all on function public\.platform_customer_activity_detail\(uuid, uuid, integer, integer\) from public, anon, authenticated/i);
});
