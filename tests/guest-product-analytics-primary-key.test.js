const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The migration waits in supabase/pending/ until it is applied, then lives in supabase/migrations/ under the
// version the database recorded; the rollback follows it. Find the files by name so the test survives the move.
const NAME = '_guest_product_analytics_primary_key.sql';
const root = path.join(__dirname, '..', 'supabase');
function find(dir) {
  const dirPath = path.join(root, dir);
  if (!fs.existsSync(dirPath)) return null;
  const file = fs.readdirSync(dirPath).find((f) => f.endsWith(NAME));
  return file ? fs.readFileSync(path.join(dirPath, file), 'utf8') : null;
}
const up = find('migrations') || find('pending');
const down = find('rollback');

test('the primary key migration exists and is transactional', () => {
  assert.ok(up, 'migration file is present in migrations/ or pending/');
  assert.match(up, /^begin;/m);
  assert.match(up, /^commit;/m);
});

test('the natural key becomes the primary key and the old unique constraint is replaced', () => {
  assert.match(up, /drop constraint guest_product_analytics_visitor_hash_product_id_activity_da_key;/);
  assert.match(up, /add constraint guest_product_analytics_pkey\s+primary key \(visitor_hash, product_id, activity_date, event_type\);/);
});

test('the rollback restores the unique constraint under its original name', () => {
  assert.ok(down, 'rollback file is present');
  assert.match(down, /drop constraint guest_product_analytics_pkey;/);
  assert.match(down, /add constraint guest_product_analytics_visitor_hash_product_id_activity_da_key\s+unique \(visitor_hash, product_id, activity_date, event_type\);/);
});

test('every upsert on guest_product_analytics infers its target from the column list, never the constraint name', () => {
  const dir = path.join(root, 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(sql, /on conflict on constraint guest_product_analytics/i, `${file} names the constraint`);
  }
});
