const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261105060349_commission_settlements.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261105060349_commission_settlements.sql'), 'utf8');

test('commission settlements separate payable eligibility from payment state', () => {
  assert.match(migration, /create table public\.commission_settlements/i);
  assert.match(migration, /commission_id uuid not null unique references public\.commissions/i);
  assert.match(migration, /status text not null default 'payment_requested'/i);
  assert.match(migration, /'payment_requested','payment_submitted','payment_verified','paid','rejected','cancelled'/i);
  assert.match(migration, /commission_settlements_status_fields_check/i);
  assert.match(migration, /commission_settlements_dates_check/i);
});

test('settlement workflow requires evidence before verification and verification before paid', () => {
  assert.match(migration, /platform_request_commission_settlement/i);
  assert.match(migration, /v_comm\.status <> 'payable'/i);
  assert.match(migration, /platform_submit_commission_settlement/i);
  assert.match(migration, /platform_verify_commission_settlement/i);
  assert.match(migration, /Settlement evidence is required/i);
  assert.match(migration, /platform_mark_commission_settlement_paid/i);
  assert.match(migration, /v_settlement\.status <> 'payment_verified'/i);
  assert.match(migration, /set status='paid', paid_at=now\(\)/i);
});

test('direct commission paid transition is guarded by an actual paid settlement', () => {
  assert.match(migration, /create or replace function private\.guard_commission_paid_transition/i);
  assert.match(migration, /where s\.commission_id = new\.id and s\.status = 'paid'/i);
  assert.match(migration, /Paid commission cannot be reopened/i);
  assert.match(migration, /Commission requires a paid settlement/i);
  assert.match(migration, /create trigger guard_commission_paid_transition/i);
  assert.match(migration, /create or replace function private\.guard_commission_settlement_transition/i);
  assert.match(migration, /Settlement financial snapshot is immutable/i);
});

test('legacy payment RPC is retained only as a verified-settlement finalization wrapper', () => {
  const wrapper = migration.match(/create or replace function public\.platform_mark_commission_paid\([\s\S]*?end;\n\$function\$;/i)?.[0] || '';
  assert.ok(wrapper);
  assert.match(wrapper, /commission_settlements/i);
  assert.match(wrapper, /Commission settlement is not verified/i);
  assert.doesNotMatch(wrapper, /update public\.commissions\s+set status='paid'/i);
});

test('rollback refuses to remove financial settlement records', () => {
  assert.match(rollback, /Refusing rollback: commission settlement records exist/i);
  assert.match(rollback, /drop table if exists public\.commission_settlements/i);
});
