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
  for (const eventType of ['view', 'search', 'cart_add', 'cart_remove']) {
    assert.match(core, new RegExp(`trackGuestProduct\\(['\"]${eventType}['\"]`));
  }
  assert.match(snapshotMigration, /capture_product_snapshot/i);
  assert.match(snapshotMigration, /product_images/i); assert.match(snapshotMigration, /aromaticNotes/i);
  assert.match(snapshotMigration, /storeOffers/i); assert.match(snapshotMigration, /cart_items_product_snapshot/i);
  assert.match(snapshotMigration, /drop constraint if exists customer_product_events_product_id_fkey/i);
  assert.match(snapshotMigration, /drop constraint if exists guest_product_analytics_product_id_fkey/i);
  assert.match(snapshotMigration, /product_snapshot jsonb not null/i);
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
