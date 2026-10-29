const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261015033601_customer_search_retention_365_days.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261015033601_customer_search_retention_365_days.sql'), 'utf8');
const transactionalTest = fs.readFileSync(path.join(root, 'tests/customer-activity-transactional.test.sql'), 'utf8');

test('customer search retention keeps rows for 365 days and schedules a protected daily purge', () => {
  assert.match(migration, /create extension if not exists pg_cron/i);
  assert.match(migration, /now\(\)\s*-\s*interval\s+'365 days'/i);
  assert.match(migration, /limit 1000/i);
  assert.match(migration, /customer-searches-retention-365d/);
  assert.match(migration, /'17 3 \* \* \*'/);
  assert.match(migration, /revoke all on function public\.purge_expired_customer_searches\(\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.purge_expired_customer_searches\(\) to service_role/i);
  assert.match(transactionalTest, /now\(\) - interval '366 days'/i);
  assert.match(transactionalTest, /now\(\) - interval '364 days'/i);
  assert.match(transactionalTest, /365-day retention did not delete only the expired search row/i);
  assert.match(rollback, /cron\.unschedule/i);
  assert.match(rollback, /Already-deleted rows cannot be restored/i);
});

// Owner decision of 2026-10-28: nothing that belongs to a registered customer is deleted automatically.
const keepName = '20261028105801_customer_searches_keep_registered_customers.sql';

test('the search purge deletes only unregistered visitors, never a registered customer', () => {
  const keep = fs.readFileSync(path.join(root, 'supabase/migrations', keepName), 'utf8');
  const undo = fs.readFileSync(path.join(root, 'supabase/rollback', keepName), 'utf8');
  assert.match(keep, /create or replace function public\.purge_expired_customer_searches\(\)/i);
  assert.match(keep, /and cs\.user_id is null/i, 'only rows with no registered owner');
  assert.match(keep, /interval '365 days'/i);
  assert.doesNotMatch(keep, /select\s+cron\.|^\s*(revoke|grant)\s/im, 'schedule and privileges stay as they were');
  assert.doesNotMatch(undo, /user_id is null/i, 'the rollback brings back the old, wider purge');
  assert.match(transactionalTest, /registered customer search row/i);
  assert.match(transactionalTest, /interval '800 days'/);
});

test('no database job or function deletes rows that belong to a registered customer', () => {
  // the only automatic purges are for unregistered visitors; a new one must be added here on purpose
  const dir = path.join(root, 'supabase/migrations');
  const sql = fs.readdirSync(dir).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const jobs = [...sql.matchAll(/cron\.schedule\(\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  const allowed = ['customer-searches-retention-365d', 'guest-fingerprint-retention-400d', 'expire-editor-sections', 'archive-expired-editor-sections', 'order-idempotency-retention-7d'];
  for (const job of new Set(jobs)) assert.ok(allowed.includes(job), 'unreviewed scheduled job: ' + job + ' (registered customer data is never deleted automatically)');
});
