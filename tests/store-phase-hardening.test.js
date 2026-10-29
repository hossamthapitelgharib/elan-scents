const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261028163408_store_phase_hardening.sql';
const root = path.join(__dirname, '..');
const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'supabase', 'rollback', NAME), 'utf8');
const dbTest = fs.readFileSync(path.join(__dirname, 'store-phase-hardening.test.sql'), 'utf8');

test('the migration file is the statement recorded in the live ledger', () => {
  assert.equal(crypto.createHash('md5').update(up).digest('hex'), '9175d9deb8cc10d867acb640ac075644');
});

test('migration and rollback are single transactions', () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
});

test('orders are made only by place_store_order: the older functions and the legacy insert policies are closed', () => {
  for (const fn of ['create_checkout_session', 'create_store_order_request', 'create_store_order_request_from_cart']) {
    assert.ok(up.includes(`revoke all on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} is closed to clients`);
    assert.ok(up.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} stays open to the server`);
    assert.ok(down.includes(`grant execute on function public.${fn}(jsonb) to authenticated;`), `${fn} is reopened by the rollback`);
  }
  assert.match(up, /drop policy if exists own_insert on public\.orders;/);
  assert.match(up, /drop policy if exists own_insert on public\.order_items;/);
  assert.match(down, /create policy own_insert on public\.orders/);
  assert.match(down, /create policy own_insert on public\.order_items/);
  assert.doesNotMatch(up.replace(/^--.*$/gm, ''), /place_store_order/, 'the migration statements do not touch the function the storefront uses');
});

test('the storefront does not call any of the closed functions', () => {
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  assert.doesNotMatch(core, /create_checkout_session|create_store_order_request/);
  assert.match(core, /rpc\/place_store_order/);
});

test('the data rules are CHECK constraints that the rollback removes', () => {
  for (const name of ['offers_title_length', 'offers_description_length', 'offers_discount_value_range', 'offers_dates_in_order', 'stores_links_are_http', 'store_products_link_is_http']) {
    assert.ok(up.includes(name), `${name} is added`);
    assert.ok(down.includes(name), `${name} is dropped by the rollback`);
  }
  assert.match(up, /discount_value > 0 and \(discount_type is distinct from 'percentage' or discount_value <= 100\)/);
  assert.match(up, /\^https\?:\/\/\[\^\[:space:\]\]\+\$/, 'links must start with http:// or https:// and hold no space');
});

test('only the platform may set the catalog bestseller flag, and a missing user (the server sync) is not blocked', () => {
  const body = up.slice(up.indexOf('create or replace function private.guard_store_product_platform_columns'), up.indexOf('create table public.platform_audit_log'));
  assert.match(body, /\(select auth\.uid\(\)\) is not null and not private\.is_platform_admin\(\)/);
  assert.match(body, /errcode = '42501'/);
  assert.match(body, /before insert or update on public\.store_products/);
  assert.match(body, /revoke all on function private\.guard_store_product_platform_columns\(\) from public, anon, authenticated;/);
});

test('the audit table is server-only and holds no personal data', () => {
  assert.match(up, /alter table public\.platform_audit_log enable row level security;/);
  assert.match(up, /revoke all on table public\.platform_audit_log from public, anon, authenticated;/);
  assert.match(up, /grant all on table public\.platform_audit_log to service_role;/);
  assert.doesNotMatch(up.slice(up.indexOf('create table public.platform_audit_log'), up.indexOf('-- 5. Store accounts')), /create policy/i);
  const link = up.slice(up.indexOf('create or replace function public.platform_link_store_account'), up.indexOf('create or replace function public.platform_unlink_store_account'));
  const audit = link.slice(link.indexOf('insert into public.platform_audit_log'));
  assert.doesNotMatch(audit, /v_email|p_email/, 'the audit row has no email');
});

test('the account functions are service-role only fixed-search-path SECURITY DEFINER functions', () => {
  for (const sig of ['platform_store_accounts(uuid)', 'platform_link_store_account(uuid, text, uuid)', 'platform_unlink_store_account(uuid, uuid)']) {
    assert.ok(up.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), `${sig} is closed to clients`);
    assert.ok(up.includes(`grant execute on function public.${sig} to service_role;`), `${sig} is open to the server`);
  }
  assert.equal((up.match(/security definer\s+set search_path to 'public', 'private', 'auth', 'pg_temp'/g) || []).length, 3);
});

test('linking refuses what would hurt: unconfirmed email, platform admin, a customer with orders', () => {
  const link = up.slice(up.indexOf('create or replace function public.platform_link_store_account'), up.indexOf('create or replace function public.platform_unlink_store_account'));
  for (const message of ['Invalid email', 'Store not found', 'User not found', 'Email not confirmed', 'Platform admin cannot be a store account', 'Customer has order history']) {
    assert.ok(link.includes(`raise exception '${message}'`), `${message} is raised`);
  }
  assert.match(link, /email_confirmed_at/);
  assert.match(link, /store_order_requests[\s\S]*checkout_sessions[\s\S]*public\.orders/, 'all three order tables are checked');
  assert.match(link, /on conflict \(store_id, user_id\) do nothing/, 'two concurrent links make one account');
  assert.match(link, /if v_role = 'customer' then\s+update public\.profiles set role = 'store_admin'/, 'only a customer is promoted');
});

test('unlinking returns the role only when the last account goes, and never touches a platform admin', () => {
  const unlink = up.slice(up.indexOf('create or replace function public.platform_unlink_store_account'), up.indexOf('revoke all on function public.platform_store_accounts'));
  assert.match(unlink, /raise exception 'Account not found'/);
  assert.match(unlink, /not exists \(select 1 from public\.store_accounts a where a\.user_id = v_user_id\)/);
  assert.match(unlink, /set role = 'customer' where id = v_user_id and role = 'store_admin'/);
});

test('the rollback removes what the migration added', () => {
  for (const drop of [
    'drop function if exists public.platform_unlink_store_account(uuid, uuid);',
    'drop function if exists public.platform_link_store_account(uuid, text, uuid);',
    'drop function if exists public.platform_store_accounts(uuid);',
    'drop table if exists public.platform_audit_log;',
    'drop trigger if exists guard_platform_columns on public.store_products;',
    'drop function if exists private.guard_store_product_platform_columns();'
  ]) assert.ok(down.includes(drop), drop);
});

test('the real-database test is a rolled-back transaction with synthetic users only', () => {
  assert.match(dbTest, /^begin;/m);
  assert.match(dbTest, /^rollback;/m);
  assert.doesNotMatch(dbTest, /^commit;/m);
  assert.match(dbTest, /@example\.invalid/);
  assert.doesNotMatch(dbTest, /@(gmail|hotmail|outlook|yahoo)\./i);
  assert.match(dbTest, /ALL CHECKS PASSED/);
});
