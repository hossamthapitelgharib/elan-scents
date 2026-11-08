const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261108082647_catalog_gender_relation_cleanup.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261108082647_catalog_gender_relation_cleanup.sql'), 'utf8');

test('gender relation cleanup backs up and removes only conflicting legacy links', () => {
  assert.match(migration, /private\.catalog_gender_relation_backup/);
  assert.match(migration, /c\.key IN \('men', 'women', 'unisex'\)/);
  assert.match(migration, /c\.key <> p\.gender/);
  assert.match(migration, /ON CONFLICT \(product_id, category_id\) DO NOTHING/);
  assert.match(migration, /DELETE FROM public\.product_categories/);
  assert.doesNotMatch(migration, /DROP TABLE|TRUNCATE/);
});

test('gender relation cleanup rollback restores exactly the backed-up relation keys', () => {
  assert.match(rollback, /INSERT INTO public\.product_categories/);
  assert.match(rollback, /FROM private\.catalog_gender_relation_backup/);
  assert.match(rollback, /ON CONFLICT \(product_id, category_id\) DO NOTHING/);
});
