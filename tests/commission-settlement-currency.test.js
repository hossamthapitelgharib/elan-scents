const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261105094846_fix_commission_settlement_currency.sql'), 'utf8');

test('settlement currency is derived from the linked store-order line, not a missing commissions column', () => {
  assert.match(migration, /v_comm\.store_order_request_item_id is not null/i);
  assert.match(migration, /from public\.store_order_request_items i\s+join public\.store_order_requests r/i);
  assert.match(migration, /upper\(coalesce\(nullif\(trim\(i\.currency\)/i);
  assert.match(migration, /v_currency text := 'EGP'/i, 'legacy commissions use the platform currency because legacy orders store no currency');
  assert.doesNotMatch(migration, /v_comm\.currency/i);
  assert.match(migration, /insert into public\.commission_settlements\(commission_id,store_id,amount,currency,requested_by\)[\s\S]*?v_currency/i);
  assert.match(migration, /revoke all on function public\.platform_request_commission_settlement\(uuid,uuid\) from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.platform_request_commission_settlement\(uuid,uuid\) to service_role/i);
});
