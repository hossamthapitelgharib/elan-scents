// The catalog ELIGIBILITY contract (the owner's rules of 2026-11-12) is checked against the real database by
// tests/catalog-eligibility-contract.test.sql (run on the live database as the owner, inside one transaction that ends in ROLLBACK).
// This file pins that the SQL test exists, leaves nothing behind, and still states each rule, so nobody can empty it silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const sql = read('tests', 'catalog-eligibility-contract.test.sql');
const migration = read('supabase', 'migrations', '20261110081953_catalog_offer_stock_and_announcement_contract.sql');

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|view|schema)\b/i, 'it only inserts fixtures and updates them');
  assert.match(sql, /migration 20261110081953/);
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/NULL stock offer \(unconfirmed\) must not be eligible/, 'NULL stock is not a sale offer'],
    [/zero stock offer must not be eligible/, 'zero stock is not a sale offer'],
    [/not the cheaper NULL\/zero-stock rows/, 'the cheapest eligible offer wins, not the cheapest row'],
    [/each size on its own|50 ml is independent/, 'each size is compared separately'],
    [/it stays the offer, with the maximum quantity 2/, 'less stock than wanted does not move the customer to the dearer store'],
    [/A sold out -> B at 200/, 'a sold-out cheapest hands the size to the next-cheapest store'],
    [/A with NULL stock is not eligible either/, 'a NULL-stock store never takes over'],
    [/no eligible offer left/, 'a size can have no sale offer at all'],
    [/never a sale offer, even with price and stock/, 'a coming-soon row is never a sale offer'],
    [/sale row without a price was accepted/, 'a sale row needs a price'],
    [/no price, no stock figure and no offer identifier/, 'the announcements feed carries no price'],
    [/announced, with stock_unknown = true/, 'an announcement needs neither price nor stock'],
    [/once the size has an eligible sale offer the announcement is gone/, 'announcements exist only while no sale offer does'],
    [/the announcement is back/, 'a sold-out sale offer brings the announcement back'],
    [/an inactive store does not announce/, 'only active stores announce'],
    [/anon reads the announcements/, 'a visitor reads the announcements'],
    [/a signed-in customer reads the announcements/, 'a signed-in customer reads them too']
  ];
  for (const [pattern, what] of rules) assert.match(sql, pattern, what);
});

test('the migration it covers still states the same eligibility, so the test and the contract cannot drift apart', () => {
  assert.match(migration, /AND sp\.stock_quantity IS NOT NULL\s+AND sp\.stock_quantity > 0/);
  assert.match(migration, /AND sp\.is_coming_soon IS NOT TRUE/);
  assert.match(migration, /store_products_price_required_unless_coming_soon/);
  assert.match(migration, /NOT EXISTS \(\s*SELECT 1 FROM private\.fn_catalog_eligible_offers\(\) sale/);
  assert.match(migration, /SELECT product_size_id, product_id, store_id, store_name, stock_unknown/);
});

test('the older offer-foundation SQL test agrees with the same rule (NULL stock is not eligible)', () => {
  const old = read('tests', 'catalog-offer-foundation.test.sql');
  assert.match(old, /v_store_null/);
  assert.match(old, /NULL stock \(unconfirmed\) must not be eligible/);
  assert.doesNotMatch(old, /\(v_store_a, v_size, 100, 'EGP', NULL/, 'the cheapest fixture store has stock');
});
