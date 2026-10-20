const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// The owner approved keeping guest fingerprint data for 400 days (2026-10-18). Two places must agree on that number:
// the lifetime of the guest cookie and the database job that deletes by age.
const DAY = 24 * 60 * 60;

function retentionMigration() {
  for (const dir of ['supabase/pending', 'supabase/migrations']) {
    const folder = path.join(root, dir);
    if (!fs.existsSync(folder)) continue;
    const file = fs.readdirSync(folder).find((f) => f.endsWith('_guest_fingerprint_retention_400_days.sql'));
    if (file) return fs.readFileSync(path.join(folder, file), 'utf8');
  }
  return null;
}

test('the guest cookie lives 400 days', () => {
  const source = fs.readFileSync(path.join(root, 'api', 'guest-cart.js'), 'utf8');
  const maxAge = /elan_gid=\$\{key\}; Max-Age=(\d+)/.exec(source);
  assert.ok(maxAge, 'the guest cookie must set Max-Age');
  assert.equal(Number(maxAge[1]), 400 * DAY);
});

test('a daily database job deletes guest fingerprint data after 400 days, and refuses anything shorter than 30', () => {
  const sql = retentionMigration();
  assert.ok(sql, 'supabase/pending (or migrations) must hold the guest_fingerprint_retention_400_days migration');
  assert.match(sql, /p_retention interval default interval '400 days'/);
  assert.match(sql, /p_retention < interval '30 days'/);
  assert.match(sql, /cron\.schedule\(\s*'guest-fingerprint-retention-400d'/);
  for (const table of ['guest_fingerprints', 'guest_identity_links', 'guest_visitors']) assert.match(sql, new RegExp('delete from public\\.' + table));
  assert.doesNotMatch(sql, /delete from public\.(guest_analytics_visits|guest_product_analytics|guest_conversions)/, 'the first retention migration left the counters alone; the guest counters go with a guest in the later guest_retention_delete_expired_guest_counters migration');
  assert.match(sql, /status = 'guest'/, 'converted rows are not touched');
  assert.match(sql, /revoke all on function public\.purge_expired_guest_fingerprints\(interval\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.purge_expired_guest_fingerprints\(interval\) to service_role/);
});

function countersMigration() {
  for (const dir of ['supabase/pending', 'supabase/migrations']) {
    const folder = path.join(root, dir);
    if (!fs.existsSync(folder)) continue;
    const file = fs.readdirSync(folder).find((f) => f.endsWith('_guest_retention_delete_expired_guest_counters.sql'));
    if (file) return fs.readFileSync(path.join(folder, file), 'utf8');
  }
  return null;
}

// Owner decision (2026-10-20): a guest's counters end with the guest. After 400 days without registering the guest is
// deleted with every event, and the guest's counter rows go too, so the combined numbers fall with the guest numbers.
test('the retention job also deletes the counter rows of a browser that has been idle for the whole period', () => {
  const sql = countersMigration();
  assert.ok(sql, 'supabase/pending (or migrations) must hold the guest_retention_delete_expired_guest_counters migration');
  assert.match(sql, /p_retention interval default interval '400 days'/);
  assert.match(sql, /p_retention < interval '30 days'/);
  for (const table of ['guest_analytics_visits', 'guest_product_analytics', 'guest_fingerprints', 'guest_identity_links', 'guest_visitors', 'customer_sessions', 'customer_product_events'])
    assert.match(sql, new RegExp('delete from public\\.' + table));
  assert.match(sql, /status = 'guest'/, 'converted rows are not touched');
  assert.doesNotMatch(sql, /delete from public\.guest_conversions/, 'the conversion funnel keeps its record');
  assert.match(sql, /last_seen_at >= v_cutoff/, 'a browser with any recent sign of life keeps all of its days');
  assert.match(sql, /revoke all on function public\.purge_expired_guest_fingerprints\(interval\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.purge_expired_guest_fingerprints\(interval\) to service_role/);
});

test('registering moves the guest events to the account and removes the guest counters (combined numbers unchanged)', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261017062830_customer_activity_totals_and_guest_cleanup_on_claim.sql'), 'utf8');
  for (const table of ['customer_sessions', 'customer_product_events', 'customer_searches']) assert.match(sql, new RegExp('update public\\.' + table + ' set guest_id = null, user_id = p_user_id where guest_id = v_guest\\.id'));
  for (const table of ['guest_analytics_visits', 'guest_product_analytics']) assert.match(sql, new RegExp('delete from public\\.' + table + ' where visitor_hash = p_analytics_hash'));
});
