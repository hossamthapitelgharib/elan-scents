const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261103152100_unify_store_order_commissions.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261103152100_unify_store_order_commissions.sql'), 'utf8');
const integration = fs.readFileSync(path.join(__dirname, 'unified-commission-ledger.test.sql'), 'utf8');

test('new store-order commissions are written only to the pre-existing commissions ledger', () => {
  const accrue = migration.match(/create or replace function private\.accrue_store_order_commission\([\s\S]*?\$function\$;/i)?.[0] || '';
  const receive = migration.match(/create or replace function public\.receive_store_order_notification\([\s\S]*?\$function\$;/i)?.[0] || '';
  assert.ok(accrue && receive, 'accrual and merchant-notice functions are present');
  assert.match(migration, /alter table public\.commissions alter column order_item_id drop not null/i);
  assert.match(migration, /add column if not exists store_order_request_item_id uuid references public\.store_order_request_items/i);
  assert.match(accrue, /insert into public\.commissions/i);
  assert.match(accrue, /on conflict\(store_order_request_item_id\)/i);
  assert.doesNotMatch(accrue, /store_order_commissions/i);
  assert.doesNotMatch(receive, /store_order_commissions/i);
  assert.match(accrue, /round\(greatest\(i\.line_total/i, 'commission uses product line total rather than shipping or order total');
  assert.match(accrue, /coalesce\(v_rate,0\)<>15 or v_return_days is null/i, 'orders without signed 15 percent terms and a store return window do not accrue');
  assert.match(migration, /comment on table public\.store_order_commissions is 'Legacy aggregate commission evidence retained for audit/i);
});

test('product-level references, returns and verified-delivery deadlines gate claims', () => {
  assert.match(migration, /platform_order_number := v_tracking \|\| '-' \|\| lpad\(v_seq::text,2,'0'\)/i);
  assert.match(receiveFunction(), /merchantOrderReference/i);
  assert.match(migration, /delivery_verified_at is not null and v_return_days is not null/i);
  assert.match(migration, /new\.delivered_at\+make_interval\(days=>c\.return_window_days\)/i);
  assert.match(migration, /c\.return_deadline_at<=now\(\)/i);
  assert.match(migration, /status='payable'/i);
  assert.match(migration, /platform_verify_store_delivery/i);
  assert.match(migration, /delivery_verification_source='platform_manual'/i);
  assert.match(migration, /delivery_verification_reference/i);
  assert.match(migration, /commission_claim/i);
  assert.match(migration, /platform_order_number[\s\S]*?merchant_order_reference/i);
});

function receiveFunction() {
  return migration.match(/create or replace function public\.receive_store_order_notification\([\s\S]*?\$function\$;/i)?.[0] || '';
}

test('settlement requires payable status and records a payment reference and actor audit', () => {
  const settle = migration.match(/create or replace function public\.platform_mark_commission_paid\([\s\S]*?\$function\$;/i)?.[0] || '';
  assert.match(settle, /v_comm\.status <> 'payable'/i);
  assert.match(settle, /status='paid'.*payment_reference=v_ref.*paid_by=p_actor/is);
  assert.match(settle, /commission_settled/i);
  assert.match(migration, /revoke all on function public\.platform_mark_commission_paid\(uuid,text,uuid\) from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.platform_mark_commission_paid\(uuid,text,uuid\) to service_role/i);
});

test('rollback preserves financial records while restoring prior applied functions and triggers', () => {
  assert.match(rollback, /begin;/i);
  assert.match(rollback, /create trigger store_order_commission_on_status/i);
  assert.match(rollback, /store_order_commission_on_adjustment/i);
  assert.doesNotMatch(rollback, /drop table public\.commissions|delete from public\.commissions|truncate/i);
  assert.match(integration.trim(), /rollback;$/i);
  assert.match(integration, /Synthetic Commission Test/);
  assert.match(integration, /store-reported delivery alone does not start the return window/);
  assert.match(integration, /excludes 80 shipping/);
});

test('platform dashboard and Worker expose one commissions tab and protected APIs', () => {
  const html = fs.readFileSync(path.join(root, 'stores-dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'stores-dashboard.js'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'cloudflare/api-registry.js'), 'utf8');
  assert.match(html, /data-store-section="commissions"/);
  assert.doesNotMatch(html, /store-order-commissions/);
  assert.match(js, /data-settle-commission/);
  assert.match(js, /data-verify-delivery/);
  assert.match(registry, /platform-store-terms/);
  assert.match(registry, /platform-commission-payment/);
  assert.match(registry, /platform-verify-delivery/);
});
