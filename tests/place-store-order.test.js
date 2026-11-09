// Static checks of the purchase core (docs/implementation-phase-1-purchase-core.ar.md): the migrations that built it, their rollbacks,
// and the real-database test that proves it. The behaviour itself is proved on the live database by tests/place-store-order.test.sql.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

const OLD = '20261027041127_server_confirmed_orders.sql';
const CORE = '20261107160412_phase1_purchase_core.sql';
const ADDRESS = '20261108135126_phase1_ship_address_parts.sql';
const core = read('supabase', 'migrations', CORE);
const address = read('supabase', 'migrations', ADDRESS);
const dbTest = read('tests', 'place-store-order.test.sql');

// The function as the database holds it now: the address follow-up replaced the first version of the body.
const placeOrder = address.slice(address.indexOf('create or replace function public.place_store_order'));

test('the migration files are the statements recorded in the live ledger (the ledger text has no final newline)', () => {
  assert.equal(md5(read('supabase', 'migrations', OLD)), '711638aafde18c70713a25d81fb2acfc', 'the first order migration is untouched');
  assert.equal(md5(core), 'd86d66d20b8c4e77556faac475f049b3');
  assert.equal(md5(address.replace(/\n$/, '')), '2bf8496c7e32caa7058133a06171a559');
});

test('every migration has a same-name rollback that is one transaction', () => {
  for (const name of [OLD, CORE, ADDRESS]) {
    const down = read('supabase', 'rollback', name);
    assert.match(down, /^begin;/m, `${name} rollback begins`);
    assert.match(down, /^commit;/m, `${name} rollback commits`);
  }
  const irreversible = JSON.parse(read('supabase', 'rollback', 'irreversible.json'));
  for (const name of [CORE, ADDRESS]) assert.equal(irreversible.exceptions.some((e) => e.migration === name), false, `${name} has a real rollback, not an exception`);
});

test('the order function is closed to anonymous callers and to the number maker', () => {
  const old = read('supabase', 'migrations', OLD);
  assert.match(old, /revoke all on function public\.place_store_order\(jsonb\) from public, anon;/);
  assert.match(old, /revoke all on function private\.new_tracking_number\(\) from public, anon, authenticated;/);
  assert.match(old, /alter table private\.store_order_idempotency enable row level security;/);
  assert.doesNotMatch(old, /create policy/i, 'the retry keys have no client policy');
});

test('the function is a fixed-search-path SECURITY DEFINER that reads only the store, the retry key and the total shown from the browser', () => {
  assert.match(placeOrder, /^create or replace function public\.place_store_order\(p_payload jsonb\)[\s\S]*?security definer\s+set search_path to 'public', 'private', 'pg_temp'/);
  const read_ = [...placeOrder.matchAll(/p_payload\s*(?:->>|->)\s*'([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(read_)].sort(), ['expectedSubtotal', 'idempotencyKey', 'storeId', 'subtotal'], 'nothing else in the payload is read');
  for (const untrusted of ['trackingNumber', 'customer', 'items', 'unitPrice', 'currency']) assert.doesNotMatch(placeOrder, new RegExp(`p_payload\\s*->>?\\s*'${untrusted}'`), `the payload's ${untrusted} is ignored`);
  assert.match(placeOrder, /private\.new_tracking_number\(\)/);
  assert.match(placeOrder, /from public\.cart_items ci\s+join public\.store_products sp/, 'the lines come from the saved cart and the catalog');
  assert.match(placeOrder, /from public\.customer_details/, 'the customer comes from the account');
  assert.match(placeOrder, /r\.currency is distinct from 'EGP'/, 'only EGP');
  assert.doesNotMatch(placeOrder, /delete from public\.cart_items/i, 'the cart is not cleared at creation');
  assert.doesNotMatch(placeOrder, /customer_confirmed/, 'the customer\'s confirmation plays no part');
});

test('phase 1 closes the old paths and the customer confirmation, and fixes what an order may hold at creation', () => {
  assert.match(core, /create_store_order_request_from_cart[\s\S]*?raise exception 'Retired: orders are created only by place_store_order'/);
  assert.match(core, /Customer purchase confirmation is retired/);
  assert.match(core, /Merchant numbers do not exist when an order is created/);
  assert.match(core, /Merchant numbers are recorded only after the merchant notice matched/);
  assert.match(core, /A merchant number is fixed once it is recorded/);
  for (const table of ['store_order_requests', 'store_order_request_items', 'checkout_sessions', 'commission_settlements']) {
    assert.match(core, new RegExp(`${table}_currency_egp`), `${table} accepts only EGP in the database`);
  }
  assert.match(core, /snapshot_order_customer/);
  assert.match(core, /snapshot_order_item/);
  assert.match(core, /before delete or update on public\.store_order_requests/i, 'an order cannot be deleted');
});

test('every refusal the browser maps to Arabic is raised by the function, and the API maps it to a key', () => {
  const app = read('app-core.js');
  const rpc = read('lib', 'customer-rpc.js');
  const raised = placeOrder + core;
  for (const message of ['Subtotal mismatch', 'Product is unavailable or has insufficient stock', 'Account details are incomplete', 'Cart is empty for this store',
    'Only EGP orders', 'Authentication required', 'Too many orders', 'Invalid retry key']) {
    assert.ok(raised.includes(message), `${message} is raised by the function`);
  }
  for (const message of ['Subtotal mismatch', 'Product is unavailable or has insufficient stock', 'Account details are incomplete', 'Cart is empty for this store', 'Only EGP orders', 'Authentication required', 'Too many orders']) {
    assert.ok(app.includes(message), `${message} is mapped in app-core.js`);
  }
  for (const key of ['account_incomplete', 'cart_empty', 'subtotal_mismatch', 'stock_unavailable', 'order_rate_limited', 'currency_not_supported', 'purchase_confirmation_retired']) {
    assert.ok(rpc.includes(`'${key}'`), `${key} is an API error key`);
  }
});

test('the rollbacks put the earlier functions back and drop what the migrations added', () => {
  const down = read('supabase', 'rollback', CORE);
  assert.match(down, /drop trigger if exists snapshot_order_customer/);
  assert.match(down, /drop column if exists merchant_order_number, drop column if exists merchant_invoice_number, drop column if exists customer_snapshot/);
  assert.match(down, /create or replace function public\.place_store_order/);
  assert.match(down, /create or replace function public\.create_store_order_request_from_cart/);
  assert.match(down, /create or replace function public\.confirm_store_order_purchase\(/);
  const downAddress = read('supabase', 'rollback', ADDRESS);
  assert.match(downAddress, /drop function if exists private\.compose_ship_address/);
  assert.match(downAddress, /create or replace function public\.place_store_order/);
});

test('the real-database test is a rolled-back transaction with synthetic users only', () => {
  assert.match(dbTest, /^begin;/m);
  assert.match(dbTest, /^rollback;/m);
  assert.doesNotMatch(dbTest, /^commit;/m);
  assert.match(dbTest, /@example\.invalid/);
  assert.match(dbTest, /ALL CHECKS PASSED/);
});
