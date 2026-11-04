'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261103130000_server_side_customer_rpcs.sql'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
const account = fs.readFileSync(path.join(root, 'account.js'), 'utf8');

const original = [
  'replace_customer_cart(jsonb)',
  'place_store_order(jsonb)',
  'request_store_order_cancellation(uuid, text)',
  'confirm_store_order_purchase(uuid)'
];
const wrappers = [
  'replace_customer_cart_server(jsonb, uuid)',
  'place_store_order_server(jsonb, uuid)',
  'request_store_order_cancellation_server(uuid, text, uuid)',
  'confirm_store_order_purchase_server(uuid, uuid)'
];

test('the migration removes authenticated execution from all four customer SECURITY DEFINER functions', () => {
  for (const signature of original) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, '\\$&')} from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, '\\$&')} to service_role;`));
  }
});

test('the migration exposes only service-role wrappers which preserve the verified user id', () => {
  for (const signature of wrappers) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, '\\$&')} from public, anon, authenticated;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, '\\$&')} to service_role;`));
  }
  assert.equal((migration.match(/set_config\('request\.jwt\.claims'/g) || []).length, 4);
  assert.equal((migration.match(/p_user_id is null/g) || []).length, 4);
});

test('the browser uses same-origin APIs and never calls the four Supabase RPCs', () => {
  assert.match(app, /fetch\('\/api\/customer-cart'/);
  assert.match(app, /fetch\('\/api\/place-store-order'/);
  assert.match(account, /fetch\('\/api\/request-store-order-cancellation'/);
  for (const name of ['confirm_store_order_purchase', 'place_store_order', 'replace_customer_cart', 'request_store_order_cancellation']) {
    assert.doesNotMatch(app + account, new RegExp(`/rest/v1/rpc/${name}`));
  }
});

test('the four API handlers exist and are not served as static files', () => {
  for (const file of ['customer-cart.js', 'place-store-order.js', 'request-store-order-cancellation.js', 'confirm-store-order-purchase.js']) {
    assert.equal(fs.existsSync(path.join(root, 'api', file)), true, file);
  }
});
