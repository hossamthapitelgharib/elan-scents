// The BUNDLES contract (the owner's rules of 2026-11-14) is checked against the real database by
// tests/catalog-bundles-contract.test.sql (run on the live database as the owner, inside one transaction that ends in ROLLBACK).
// This file pins that the SQL test exists, leaves nothing behind, still states each rule, and that the migration it covers
// still holds the same rules, so nobody can empty the test or loosen the migration silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const sql = read('tests', 'catalog-bundles-contract.test.sql');
const migration = read('supabase', 'migrations', '20261115074256_catalog_bundles.sql');
const rollback = read('supabase', 'rollback', '20261115074256_catalog_bundles.sql');

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(table|view|schema)\b/i);
  assert.match(sql, /migration 20261115074256/);
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/a single piece never gets a composition key/, 'one piece is a perfume, not a package'],
    [/two catalog sizes give a composition key/, 'a package of catalog sizes is identified by its composition'],
    [/the same sizes and quantities must not exist as two bundles/, 'the same package never exists twice'],
    [/other quantities make another package with another key/, 'other quantities are another package'],
    [/a package with an extra piece never gets a key, even with the same sizes/, 'an extra piece means it can never be proven identical'],
    [/raising has_extra_items drops the key/, 'the key follows the flag'],
    [/a bundle offer without a stock NUMBER is refused/, 'the store must send the stock as a number'],
    [/a negative stock is refused/, 'no negative stock'],
    [/a bundle priced 0 is refused/, 'no free bundle'],
    [/only EGP is accepted/, 'single currency'],
    [/a store has one offer per bundle/, 'one offer per store and bundle'],
    [/zero stock, unsynced, inactive store and unavailable rows are never eligible, whatever their price/, 'eligibility'],
    [/the platform offer is A at 300, not the cheaper ineligible rows/, 'the cheapest ELIGIBLE offer wins'],
    [/A sold out: the offer is B at 320/, 'a sold-out cheapest hands over to the next store'],
    [/equal prices: the higher commission \(B, 20\) wins the tie-break/, 'deterministic tie-break'],
    [/a solo package is the platform offer/, 'a bundle only one store sells is the cheapest by itself'],
    [/a second store on the same package takes over when it is cheaper/, 'the same package is compared across stores'],
    [/the pure package and the package with an extra piece both appear/, 'different packages all appear'],
    [/a package that holds an unpublished perfume is hidden/, 'a package follows its perfumes'],
    [/a package without an eligible offer is not public/, 'no offer, not public'],
    [/a draft package never appears/, 'a draft never appears'],
    [/carries no commission, no priority and no claimed old price/, 'the public offer leaks nothing'],
    [/a store cannot claim an old price or a discount on a bundle/, 'no claimed old price on a bundle'],
    [/neither the visitor nor the customer can read the bundle tables/, 'the tables are server-only for reading'],
    [/neither the visitor nor the customer can write the bundle tables/, 'the tables are server-only for writing']
  ];
  for (const [pattern, what] of rules) assert.match(sql, pattern, what);
});

test('the migration still states the same rules, so the test and the contract cannot drift apart', () => {
  assert.match(migration, /stock_quantity integer NOT NULL,/, 'the stock is a required number');
  assert.match(migration, /AND sb\.stock_quantity > 0/);
  assert.match(migration, /AND sb\.sync_status = 'synced'/);
  assert.match(migration, /AND sb\.is_available/);
  assert.match(migration, /s\.status = 'active'/);
  assert.match(migration, /b\.status = 'published'/);
  assert.match(migration, /CONSTRAINT store_bundles_price_check CHECK \(price > 0\)/);
  assert.match(migration, /CONSTRAINT store_bundles_currency_check CHECK \(currency = 'EGP'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX bundles_composition_key_uq ON public\.bundles \(composition_key\) WHERE composition_key IS NOT NULL/);
  assert.match(migration, /WHEN p_has_extra_items THEN NULL/);
  assert.match(migration, /sum\(bi\.quantity\)/);
  assert.match(migration, /, 0\) < 2 THEN NULL/, 'a package of fewer than 2 pieces has no key');
  assert.match(migration, /ORDER BY o\.bundle_id,\s+o\.price ASC,\s+o\.commission_rate DESC,\s+o\.priority_rank ASC,\s+o\.store_id ASC,\s+o\.store_bundle_id ASC/);
  assert.match(migration, /REVOKE ALL ON public\.bundles, public\.bundle_items, public\.store_bundles FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration.replace(/--[^\n]*/g, ''), /original_price|discount_percentage|discount_value/, 'no claimed old price or discount on a bundle');
});

test('the rollback removes every object the migration creates', () => {
  const created = [...migration.matchAll(/^CREATE (?:TABLE|VIEW|FUNCTION) ((?:public|private)\.[a-z_]+)/gm)].map((m) => m[1]);
  assert.ok(created.length >= 12, 'the migration creates the tables, views and functions');
  for (const name of created) assert.ok(rollback.includes(name), `the rollback drops ${name}`);
});
