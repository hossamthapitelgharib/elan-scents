// The BUNDLES contract (the owner's rules of 2026-11-14 and 2026-11-17) is checked against the real database by
// tests/catalog-bundles-contract.test.sql (run on the live database as the owner, inside one transaction that ends in ROLLBACK).
// This file pins that the SQL test exists, leaves nothing behind, still states each rule, and that the migrations it covers
// still hold the same rules, so nobody can empty the test or loosen a migration silently.
//   20261115074256_catalog_bundles            the tables, the stock/price/currency rules, the unique composition key, the platform offer
//   20261119112905_catalog_bundles_standalone the pieces are written as the store lists them (no link to the perfume catalog), the
//                                             store's own title and full description, the key from the pieces only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const sql = read('tests', 'catalog-bundles-contract.test.sql');
const migration = read('supabase', 'migrations', '20261115074256_catalog_bundles.sql');
const rollback = read('supabase', 'rollback', '20261115074256_catalog_bundles.sql');
const found = (dir) => fs.readdirSync(path.join(root, 'supabase', dir)).filter((name) => name.endsWith('_catalog_bundles_standalone.sql'));
const standaloneName = (() => { const f = found('migrations'); assert.equal(f.length, 1, 'exactly one migration ends with _catalog_bundles_standalone.sql'); return f[0]; })();
const standalone = read('supabase', 'migrations', standaloneName);
const standaloneRollback = (() => { const f = found('rollback'); assert.deepEqual(f, [standaloneName], 'the rollback has the same version as the migration'); return read('supabase', 'rollback', f[0]); })();
const code = (text) => text.replace(/--[^\n]*/g, '');
const body = (text, start) => { const i = text.indexOf(start); assert.ok(i >= 0, `${start} exists`); const j = text.indexOf('$function$;', text.indexOf('$function$', i) + 10); return text.slice(i, j); };

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(table|view|schema)\b/i);
  assert.match(sql, /migration 20261115074256/);
  assert.match(sql, /migration 20261119112905/);
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/a single piece never gets a composition key/, 'one piece is a perfume, not a package'],
    [/two pieces give a composition key/, 'a package is identified by its pieces'],
    [/the same pieces and quantities must not exist as two bundles, whatever the case, spacing, punctuation or accents/, 'the same package never exists twice, however it is spelled'],
    [/other quantities make another package with another key/, 'other quantities are another package'],
    [/the same perfume in another size is another package/, 'the size is part of the identity'],
    [/the same name under another brand is another package/, 'the brand is part of the identity'],
    [/a package with an extra piece never gets a key, even with the same pieces/, 'an extra piece means it can never be proven identical'],
    [/raising has_extra_items drops the key/, 'the key follows the flag'],
    [/the same piece twice in one bundle is refused/, 'no duplicated piece'],
    [/a bundle offer without a stock NUMBER is refused/, 'the store must send the stock as a number'],
    [/a negative stock is refused/, 'no negative stock'],
    [/a bundle priced 0 is refused/, 'no free bundle'],
    [/only EGP is accepted/, 'single currency'],
    [/a bundle offer must carry the store''s own title/, 'the store always names its bundle'],
    [/a description over 20000 characters is refused/, 'a sane cap on the store text'],
    [/a store has one offer per bundle/, 'one offer per store and bundle'],
    [/zero stock, unsynced, inactive store and unavailable rows are never eligible, whatever their price/, 'eligibility'],
    [/two stores with different words on the same package are one bundle/, 'wording never splits a bundle'],
    [/the platform offer is A at 300, not the cheaper ineligible rows/, 'the cheapest ELIGIBLE offer wins'],
    [/the platform offer carries the cheapest store''s own title and its full description, untouched/, 'the stores own words, in full'],
    [/A sold out: the offer is B at 320 and shows B''s own words/, 'a sold-out cheapest hands over to the next store, with its own words'],
    [/equal prices: the higher commission \(B, 20\) wins the tie-break/, 'deterministic tie-break'],
    [/rewording the store''s text never changes which store wins or whether the bundle shows/, 'wording never decides the winner'],
    [/a solo package is the platform offer/, 'a bundle only one store sells is the cheapest by itself'],
    [/a second store on the same package takes over when it is cheaper/, 'the same package is compared across stores'],
    [/the pure package and the package with an extra piece both appear/, 'different packages all appear'],
    [/a package naming a hidden perfume, an exclusive size and a perfume the platform never lists still shows with all its pieces/, 'the perfumes are never consulted'],
    [/publishing or deactivating a perfume never changes whether a bundle shows/, 'a perfume never hides a bundle'],
    [/a bundle piece is not tied to a catalog size/, 'no link to the perfume catalog'],
    [/a perfume can be deleted whatever the bundles say/, 'a bundle never blocks deleting a perfume'],
    [/a package without an eligible offer is not public/, 'no offer, not public'],
    [/a draft package never appears/, 'a draft never appears'],
    [/a piece is listed exactly as the store wrote it/, 'pieces are shown as the store wrote them'],
    [/carries no commission, no priority and no claimed old price/, 'the public offer leaks nothing'],
    [/a store cannot claim an old price or a discount on a bundle/, 'no claimed old price on a bundle'],
    [/the platform proposes no description of a bundle/, 'the platform writes no description'],
    [/neither the visitor nor the customer can read the bundle tables/, 'the tables are server-only for reading'],
    [/neither the visitor nor the customer can write the bundle tables/, 'the tables are server-only for writing'],
    [/the server role can write bundle pieces/, 'the server writes the pieces']
  ];
  for (const [pattern, what] of rules) assert.match(sql, pattern, what);
});

test('the first migration still states the table rules, so the test and the contract cannot drift apart', () => {
  assert.match(migration, /stock_quantity integer NOT NULL,/, 'the stock is a required number');
  assert.match(migration, /CONSTRAINT store_bundles_price_check CHECK \(price > 0\)/);
  assert.match(migration, /CONSTRAINT store_bundles_currency_check CHECK \(currency = 'EGP'\)/);
  assert.match(migration, /CREATE UNIQUE INDEX bundles_composition_key_uq ON public\.bundles \(composition_key\) WHERE composition_key IS NOT NULL/);
  assert.match(migration, /REVOKE ALL ON public\.bundles, public\.bundle_items, public\.store_bundles FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(code(migration), /original_price|discount_percentage|discount_value/, 'no claimed old price or discount on a bundle');
});

test('the standalone migration states the owner rules of 2026-11-17', () => {
  const sqlCode = code(standalone);
  // eligibility: the same rules as before, and the perfumes are NOT consulted
  const eligible = body(sqlCode, 'CREATE FUNCTION private.fn_catalog_eligible_bundle_offers()');
  assert.match(eligible, /AND sb\.stock_quantity > 0/);
  assert.match(eligible, /AND sb\.sync_status = 'synced'/);
  assert.match(eligible, /AND sb\.is_available/);
  assert.match(eligible, /s\.status = 'active'/);
  assert.match(eligible, /b\.status = 'published'/);
  assert.doesNotMatch(eligible, /\bproducts?\b|\bproduct_sizes\b/, 'a bundle never reads the perfume catalog');
  assert.match(sqlCode, /ORDER BY o\.bundle_id,\s+o\.price ASC,\s+o\.commission_rate DESC,\s+o\.priority_rank ASC,\s+o\.store_id ASC,\s+o\.store_bundle_id ASC/);
  // the store's own words travel with the platform offer
  assert.match(eligible, /sb\.title,\s+sb\.description/);
  assert.match(sqlCode, /ALTER TABLE public\.store_bundles ALTER COLUMN title SET NOT NULL/);
  assert.match(sqlCode, /ALTER TABLE public\.bundles DROP COLUMN description/, 'the platform keeps no description of its own');
  // the composition key reads the pieces only: never a title, a description or a catalog id
  const key = body(sqlCode, 'CREATE OR REPLACE FUNCTION private.bundle_compute_key');
  assert.match(key, /private\.bundle_norm\(bi\.item_brand\)/);
  assert.match(key, /private\.bundle_norm\(bi\.item_name\)/);
  assert.match(key, /WHEN p_has_extra_items THEN NULL/);
  assert.match(key, /, 0\) < 2 THEN NULL/, 'a package of fewer than 2 pieces has no key');
  assert.doesNotMatch(key, /title|description|product_size_id|store_bundles/, 'no wording and no catalog row can change a key');
  // the pieces are standalone
  assert.match(sqlCode, /ALTER TABLE public\.bundle_items DROP COLUMN product_size_id/);
  assert.match(sqlCode, /CREATE UNIQUE INDEX bundle_items_piece_uq/);
  assert.doesNotMatch(sqlCode, /REFERENCES public\.product_sizes|REFERENCES public\.products/, 'no foreign key to the perfume catalog');
  // nothing public leaks, and the browser roles still read only the views
  assert.doesNotMatch(sqlCode, /original_price|discount_percentage|discount_value/);
  assert.match(sqlCode, /REVOKE ALL ON FUNCTION private\.fn_catalog_eligible_bundle_offers\(\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sqlCode, /fn_catalog_eligible_bundle_offers\(\)\s+TO\b/, 'the internal offers (commission, priority) are never granted');
  for (const view of ['catalog_eligible_bundle_offers', 'catalog_platform_bundle_offers', 'public_bundles', 'public_bundle_items']) {
    assert.match(sqlCode, new RegExp(`CREATE VIEW public\\.${view} WITH \\(security_invoker = true\\)`), `${view} is an invoker view`);
  }
});

test('the rollbacks remove or restore every object the migrations create', () => {
  const created = [...migration.matchAll(/^CREATE (?:TABLE|VIEW|FUNCTION) ((?:public|private)\.[a-z_]+)/gm)].map((m) => m[1]);
  assert.ok(created.length >= 12, 'the first migration creates the tables, views and functions');
  for (const name of created) assert.ok(rollback.includes(name), `the first rollback drops ${name}`);
  const created2 = [...standalone.matchAll(/^CREATE (?:UNIQUE INDEX|VIEW|FUNCTION) ((?:public|private)\.[a-z_]+|[a-z_]+)/gm)].map((m) => m[1]);
  assert.ok(created2.length >= 10, 'the standalone migration creates its function and views');
  for (const name of created2) assert.ok(standaloneRollback.includes(name.replace(/^public\./, '')) || standaloneRollback.includes(name), `the standalone rollback handles ${name}`);
  assert.match(standaloneRollback, /^begin;/m);
  assert.match(standaloneRollback, /commit;\s*$/);
  assert.match(standaloneRollback, /WARNING: this loses data/, 'the rollback says what it cannot restore');
});

