const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VERSION_NAME = '20261020115120_harden_adjustment_trigger_fn_and_add_fk_indexes.sql';
const root = path.join(__dirname, '..', 'supabase');
const read = (dir) => fs.readFileSync(path.join(root, dir, VERSION_NAME), 'utf8');

test('migration removes client access to the adjustment trigger function', () => {
  const sql = read('migrations');
  assert.match(sql, /revoke execute on function public\.validate_store_order_item_adjustment\(\) from public, anon, authenticated;/);
  assert.doesNotMatch(sql, /grant execute on function public\.validate_store_order_item_adjustment/);
});

test('migration covers the six unindexed foreign keys', () => {
  const sql = read('migrations');
  const wanted = [
    'customer_product_events (session_id)',
    'customer_product_events (product_size_id)',
    'customer_product_events (store_product_id)',
    'customer_searches (session_id)',
    'store_order_item_adjustments (created_by)',
    'store_order_item_adjustments (request_item_id, request_id)'
  ];
  for (const target of wanted) assert.ok(sql.includes(`on public.${target};`), `missing index on ${target}`);
});

test('shipment owner policy evaluates auth.uid() once per statement', () => {
  const sql = read('migrations');
  assert.match(sql, /alter policy store_shipments_owner_read on public\.store_shipments/);
  assert.match(sql, /r\.user_id = \(select auth\.uid\(\)\)/);
});

test('the migration is transactional and has a matching rollback', () => {
  const up = read('migrations');
  assert.match(up, /^begin;/m);
  assert.match(up, /^commit;/m);
  const down = read('rollback');
  assert.match(down, /drop index if exists public\.customer_searches_session_id_idx;/);
  assert.match(down, /r\.user_id = auth\.uid\(\)/);
});
