const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// customer_product_events and customer_sessions reference guest_visitors with ON DELETE SET NULL, but both
// tables require exactly one owner (guest XOR customer). Deleting an idle guest that still has events or sessions
// would therefore fail on the check rule and abort the whole daily job. The job must delete those rows first.
function retentionMigration() {
  for (const dir of ['supabase/pending', 'supabase/migrations']) {
    const folder = path.join(root, dir);
    if (!fs.existsSync(folder)) continue;
    const file = fs.readdirSync(folder).find((f) => f.endsWith('_guest_fingerprint_retention_400_days.sql'));
    if (file) return fs.readFileSync(path.join(folder, file), 'utf8');
  }
  return null;
}

test('the retention job deletes an idle guest\'s events and sessions before the guest row', () => {
  const sql = retentionMigration();
  assert.ok(sql, 'the guest_fingerprint_retention_400_days migration must exist');
  const events = sql.indexOf('delete from public.customer_product_events where guest_id = any(v_ids)');
  const sessions = sql.indexOf('delete from public.customer_sessions where guest_id = any(v_ids)');
  const visitors = sql.indexOf('delete from public.guest_visitors where id = any(v_ids)');
  assert.ok(events > 0 && sessions > 0 && visitors > 0, 'all three deletes must be present');
  assert.ok(events < visitors && sessions < visitors, 'events and sessions must go before the guest row');
  assert.doesNotMatch(sql, /delete from public\.guest_visitors v using expired/, 'the guest row must not be deleted without its events and sessions');
});

test('the owner-less event and session rule is still what the database enforces', () => {
  const folder = path.join(root, 'supabase/migrations');
  const text = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), 'utf8')).join('\n');
  assert.match(text, /customer_product_events_exactly_one_actor/);
  assert.match(text, /customer_sessions_exactly_one_actor/);
});
