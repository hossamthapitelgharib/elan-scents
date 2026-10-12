const { loadCoreSource } = require('./load-core');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('customer activity migration preserves RLS, full product joins, four rankings, and transfers logs on claim', () => {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261011001908_customer_activity_details.sql'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');
  const identity = fs.readFileSync(path.join(root, 'guest-identity.js'), 'utf8');
  const core = loadCoreSource();
  assert.match(migration, /create table if not exists public\.customer_sessions/i);
  assert.match(migration, /create table if not exists public\.customer_product_events/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /to_jsonb\(p\)/i);
  assert.match(migration, /update public\.customer_product_events set guest_id=null,user_id=p_user_id/i);
  assert.match(migration, /cart_remove/);
  assert.match(dashboard, /guestTopProducts/); assert.match(dashboard, /guestBasketProducts/);
  assert.match(dashboard, /data\.topViewed/); assert.match(dashboard, /data\.topSearched/);
  assert.match(dashboard, /data\.topCartAdded/); assert.match(dashboard, /data\.topCartRemoved/);
  assert.doesNotMatch(dashboard, /registeredAnalyticsPeriod/);
  assert.match(identity, /customer-activity/); assert.match(identity, /heartbeat/);
  assert.match(core, /trackGuestProduct\('cart_remove'/); assert.match(core, /trackGuestProduct\('search'/);
});
