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
  assert.doesNotMatch(sql, /delete from public\.(guest_analytics_visits|guest_product_analytics|guest_conversions)/, 'aggregate counters are a separate decision');
  assert.match(sql, /status = 'guest'/, 'converted rows are not touched');
  assert.match(sql, /revoke all on function public\.purge_expired_guest_fingerprints\(interval\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.purge_expired_guest_fingerprints\(interval\) to service_role/);
});
