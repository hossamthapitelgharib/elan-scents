const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261024165336_customer_data_hardening.sql';
const root = path.join(__dirname, '..');
const up = fs.readFileSync(path.join(root, 'supabase', 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'supabase', 'rollback', NAME), 'utf8');
const dbTest = fs.readFileSync(path.join(__dirname, 'customer-data-hardening.test.sql'), 'utf8');

test('the migration is one transaction with a matching rollback', () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^begin;/m);
    assert.match(sql, /^commit;/m);
  }
});

test('a cart line is capped at 99 units', () => {
  assert.match(up, /add constraint cart_items_quantity_max check \(quantity <= 99\)/);
  assert.match(up, /v_quantity := least\(v_quantity, 99\);/);
  assert.match(down, /drop constraint if exists cart_items_quantity_max/);
});

test('replace_customer_cart is atomic, bounded, and reachable by signed-in users only', () => {
  assert.match(up, /jsonb_array_length\(v_items\) > 100/);
  assert.match(up, /revoke all on function public\.replace_customer_cart\(jsonb\) from public, anon;/);
  assert.match(up, /grant execute on function public\.replace_customer_cart\(jsonb\) to authenticated, service_role;/);
  assert.doesNotMatch(up, /grant execute on function public\.replace_customer_cart\(jsonb\) to [^;]*\banon\b/);
  assert.match(down, /revoke execute on function public\.replace_customer_cart\(jsonb\) from public, anon, authenticated;/);
});

test('every customer text column that takes free text has a length ceiling', () => {
  const wanted = [
    'checkout_sessions_tracking_len', 'checkout_sessions_name_len', 'checkout_sessions_phone_len', 'checkout_sessions_email_len',
    'checkout_sessions_address_len', 'checkout_sessions_currency_fmt',
    'store_order_requests_tracking_len', 'store_order_requests_name_len', 'store_order_requests_phone_len',
    'store_order_requests_email_len', 'store_order_requests_address_len', 'store_order_requests_notes_len',
    'contact_messages_name_len', 'contact_messages_email_len', 'contact_messages_phone_len', 'contact_messages_message_len',
    'reviews_comment_len', 'profiles_full_name_len', 'profiles_phone_len', 'profiles_avatar_url_fmt'
  ];
  for (const name of wanted) {
    assert.ok(up.includes(`add constraint ${name} `) || up.includes(`add constraint ${name}\n`), `missing constraint ${name}`);
    assert.ok(down.includes(`drop constraint if exists ${name}`), `rollback does not drop ${name}`);
  }
});

test('sign-up cannot fail on the new name ceiling', () => {
  assert.match(up, /left\(coalesce\(new\.raw_user_meta_data->>'full_name', ''\), 120\)/);
});

test('analytics_events no longer accepts anonymous inserts', () => {
  assert.match(up, /drop policy event_insert on public\.analytics_events;/);
  assert.match(up, /revoke insert on public\.analytics_events from anon;/);
  assert.match(up, /create policy event_insert on public\.analytics_events\s+for insert to authenticated/);
  assert.doesNotMatch(up, /for insert to anon/);
});

test('the avatar pattern stays under the regex repetition limit of PostgreSQL (255)', () => {
  const pattern = up.match(/avatar_url ~ '([^']+)'/);
  assert.ok(pattern, 'avatar pattern found');
  for (const repeat of pattern[1].matchAll(/\{(\d+)(?:,(\d+))?\}/g)) {
    assert.ok(Number(repeat[2] || repeat[1]) <= 255, `repetition ${repeat[0]} is over 255`);
  }
});

test('the real-database test covers every change and rolls back', () => {
  assert.match(dbTest, /^begin;/m);
  assert.match(dbTest, /^rollback;/m);
  for (const needle of ['replace_customer_cart', 'handle_new_user', 'analytics_events', 'checkout_sessions', 'contact_messages', 'avatar_url', 'ALL CHECKS PASSED']) {
    assert.ok(dbTest.includes(needle), `the SQL test does not mention ${needle}`);
  }
  assert.doesNotMatch(dbTest, /\bcommit\b\s*;/i);
});
