// The favourites saved in the customer's account (migration 20261104160507_favorites_by_size).
// The real-database behaviour is checked by tests/favorites-by-size.test.sql; this file keeps the files that belong together together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const VERSION = '20261104160507';

test('the favourites migration has its rollback and its real-database test, under the version the database recorded', () => {
  const migration = read('supabase', 'migrations', VERSION + '_favorites_by_size.sql');
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', VERSION + '_favorites_by_size.sql')), 'rollback file');
  const sqlTest = read('tests', 'favorites-by-size.test.sql');
  assert.match(sqlTest, new RegExp(VERSION + '_favorites_by_size\\.sql'));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  assert.match(migration, /unique \(user_id, product_size_id\)/);
  assert.match(migration, /references public\.product_sizes \(id\) on delete cascade/);
  assert.match(migration, /alter column product_size_id set not null/);
});

test('the trigger fills the product from the size, so a row cannot name a size together with another product', () => {
  const migration = read('supabase', 'migrations', VERSION + '_favorites_by_size.sql');
  assert.match(migration, /security definer\s+set search_path to ''/, 'a definer function with an empty search path');
  assert.match(migration, /select ps\.product_id into new\.product_id from public\.product_sizes ps where ps\.id = new\.product_size_id/);
  assert.match(migration, /before insert or update of product_size_id, product_id on public\.favorites/);
});

test('the migration widens no access: no grant, no policy, no revoke, nothing for the visitor roles', () => {
  const migration = read('supabase', 'migrations', VERSION + '_favorites_by_size.sql').replace(/--.*$/gm, '');
  assert.doesNotMatch(migration, /\bgrant\b|\bcreate policy\b|\bdisable row level security\b|\bto anon\b/i);
});

test('the storefront saves a heart under the size id of the card, the same id the cart uses', () => {
  const core = read('app-core.js');
  assert.match(core, /\{user_id:uid,product_size_id:String\(sid\)\}/);
  assert.match(core, /'\?on_conflict=user_id,product_size_id'/);
  assert.match(core, /\{id:o\.product_size_id,pid:o\.product_id/, 'a card id is the size id');
  assert.doesNotMatch(core, /rest\/v1\/favorites\?[^']*product_id=/, 'never keyed by the product');
});
