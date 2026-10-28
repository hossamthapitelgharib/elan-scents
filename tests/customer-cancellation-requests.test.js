const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261027105200_customer_cancellation_requests.sql';
const root = path.join(__dirname, '..');
const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'supabase', 'rollback', NAME), 'utf8');
const dbTest = fs.readFileSync(path.join(__dirname, 'customer-cancellation-requests.test.sql'), 'utf8');

test('the migration file is the statement recorded in the live ledger', () => {
  assert.equal(crypto.createHash('md5').update(up).digest('hex'), '271e91a294f343b01a6e93cdf63b7893');
});

test('migration and rollback are single transactions', () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
});

test('the request table is server-only: RLS on, no policy, no client privilege', () => {
  assert.match(up, /alter table public\.store_order_cancellation_requests enable row level security;/);
  assert.match(up, /revoke all on table public\.store_order_cancellation_requests from public, anon, authenticated;/);
  assert.match(up, /grant all on table public\.store_order_cancellation_requests to service_role;/);
  assert.doesNotMatch(up, /create policy/i);
  assert.match(up, /request_id uuid primary key references public\.store_order_requests \(id\) on delete cascade/, 'one request per order');
  assert.match(up, /char_length\(reason\) <= 500/);
});

test('the function is closed to anonymous callers and is a fixed-search-path SECURITY DEFINER', () => {
  assert.match(up, /revoke all on function public\.request_store_order_cancellation\(uuid, text\) from public, anon;/);
  assert.match(up, /grant execute on function public\.request_store_order_cancellation\(uuid, text\) to authenticated, service_role;/);
  assert.match(up, /create or replace function public\.request_store_order_cancellation[\s\S]*?security definer\s+set search_path to 'public', 'private', 'pg_temp'/);
});

test('the function takes the caller from the token, locks his own order, and only asks while the store has not answered', () => {
  const body = up.slice(up.indexOf('create or replace function public.request_store_order_cancellation'));
  assert.match(body, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(body, /r\.id = p_request_id and r\.user_id = v_user_id\s+for update/);
  assert.match(body, /status <> 'awaiting_store_confirmation'/);
  assert.doesNotMatch(body, /update public\.store_order_requests/i, 'the request never changes the order: the store decides');
  assert.match(body, /emit_order_notification/);
});

test('every refusal the page maps to Arabic is raised by the function', () => {
  const page = fs.readFileSync(path.join(root, 'account.js'), 'utf8');
  for (const message of ['Order is no longer waiting for the store', 'Reason is too long', 'Order not found', 'Authentication required']) {
    assert.ok(up.includes(message), `${message} is raised by the function`);
  }
  for (const needle of ['no longer waiting', 'Reason is too long', 'Order not found', 'Authentication required']) {
    assert.ok(page.includes(needle), `${needle} is mapped in account.js`);
  }
});

test('the rollback removes everything the migration added, and nothing else', () => {
  assert.match(down, /drop function if exists public\.request_store_order_cancellation\(uuid, text\);/);
  assert.match(down, /drop table if exists public\.store_order_cancellation_requests;/);
  assert.doesNotMatch(down, /place_store_order|store_order_requests;/);
});

test('the real-database test is a rolled-back transaction with synthetic users only', () => {
  assert.match(dbTest, /^begin;/m);
  assert.match(dbTest, /^rollback;/m);
  assert.doesNotMatch(dbTest, /^commit;/m);
  assert.match(dbTest, /@example\.invalid/);
  assert.match(dbTest, /ALL CHECKS PASSED/);
});
