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
