const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261027041127_server_confirmed_orders.sql';
const root = path.join(__dirname, '..');
const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'supabase', 'rollback', NAME), 'utf8');
const dbTest = fs.readFileSync(path.join(__dirname, 'place-store-order.test.sql'), 'utf8');

test('the migration file is the statement recorded in the live ledger', () => {
  assert.equal(crypto.createHash('md5').update(up).digest('hex'), '711638aafde18c70713a25d81fb2acfc');
});

test('migration and rollback are single transactions', () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
});

test('the order function is closed to anonymous callers and to the number maker', () => {
  assert.match(up, /revoke all on function public\.place_store_order\(jsonb\) from public, anon;/);
  assert.match(up, /grant execute on function public\.place_store_order\(jsonb\) to authenticated, service_role;/);
  assert.match(up, /revoke all on function private\.new_tracking_number\(\) from public, anon, authenticated;/);
  assert.match(up, /alter table private\.store_order_idempotency enable row level security;/);
  assert.doesNotMatch(up, /create policy/i, 'the retry keys have no client policy');
});

test('the function is a fixed-search-path SECURITY DEFINER and never trusts a number from the browser', () => {
  assert.match(up, /create or replace function public\.place_store_order[\s\S]*?security definer\s+set search_path to 'public', 'private', 'pg_temp'/);
  const body = up.slice(up.indexOf('create or replace function public.place_store_order'));
  assert.doesNotMatch(body, /p_payload->>'trackingNumber'/, 'the payload tracking number is not read');
  assert.match(body, /private\.new_tracking_number\(\)/);
});

test('every refusal the browser maps to Arabic is raised by the function', () => {
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  for (const message of ['Price changed', 'Subtotal mismatch', 'Product is unavailable or has insufficient stock', 'Product is not offered by this store',
    'Customer details are required', 'Authentication required', 'Too many orders']) {
    assert.ok(up.includes(message), `${message} is raised by the function`);
    assert.ok(core.includes(message), `${message} is mapped in app-core.js`);
  }
});

test('the rollback removes everything the migration added, and nothing else', () => {
  assert.match(down, /drop function if exists public\.place_store_order\(jsonb\);/);
  assert.match(down, /drop function if exists private\.new_tracking_number\(\);/);
  assert.match(down, /drop table if exists private\.store_order_idempotency;/);
  assert.match(down, /cron\.unschedule\('order-idempotency-retention-7d'\)/);
  assert.doesNotMatch(down, /create_checkout_session|create_store_order_request/);
});

test('the real-database test is a rolled-back transaction with synthetic users only', () => {
  assert.match(dbTest, /^begin;/m);
  assert.match(dbTest, /^rollback;/m);
  assert.doesNotMatch(dbTest, /^commit;/m);
  assert.match(dbTest, /@example\.invalid/);
  assert.match(dbTest, /ALL CHECKS PASSED/);
});
