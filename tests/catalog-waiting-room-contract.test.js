// The WAITING ROOM contract (the owner's agreement of 2026-11-19, and his principle of 2026-11-20: what is done now is not repeated when the
// stores are linked, it runs by itself the moment they are) is checked against the real database by tests/catalog-waiting-room.test.sql
// (run on the live database as the owner, inside one transaction that ends in ROLLBACK).
// This file pins that the SQL test exists, leaves nothing behind, still states each rule, and that the migration
// (20261121193245_catalog_waiting_room) still holds the same rules, so nobody can empty the test or loosen the migration silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const sql = read('tests', 'catalog-waiting-room.test.sql');
const found = (dir) => fs.readdirSync(path.join(root, 'supabase', dir)).filter((name) => name.endsWith('_catalog_waiting_room.sql'));
const migrationName = (() => { const f = found('migrations'); assert.equal(f.length, 1, 'exactly one migration ends with _catalog_waiting_room.sql'); return f[0]; })();
const migration = read('supabase', 'migrations', migrationName);
const rollback = (() => { const f = found('rollback'); assert.deepEqual(f, [migrationName], 'the rollback has the same version as the migration'); return read('supabase', 'rollback', f[0]); })();
const code = (text) => text.replace(/--[^\n]*/g, '');
const body = (text, start) => { const i = text.indexOf(start); assert.ok(i >= 0, `${start} exists`); const j = text.indexOf('$function$;', text.indexOf('$function$', i) + 10); return text.slice(i, j); };

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(table|view|schema)\b/i);
  assert.match(sql, /migration catalog_waiting_room/);
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/three perfumes of an unknown brand wait/, 'a perfume of a brand without a card waits'],
    [/waiting creates no product/, 'waiting never creates a perfume'],
    [/waiting creates no offer/, 'waiting never creates an offer'],
    [/the same perfume spelled differently is the same waiting row/, 'a spelling never splits a waiting perfume'],
    [/the waiting row holds the latest price/, 'the latest price is kept while waiting'],
    [/thirteen refused, the good one waits/, 'a bad item never stops the others'],
    [/a free perfume is refused/, 'no free perfume'],
    [/the stock must be sent as a number, never negative/, 'the stock is a number'],
    [/only EGP/, 'single currency'],
    [/only an http\(s\) link/, 'no script link'],
    [/more than 1000 items in one call are refused/, 'a sane batch cap'],
    [/the brand card brings its four waiting sizes as three perfumes/, 'the card brings the waiting perfumes by itself'],
    [/the rows are kept as history with their release time, not deleted/, 'released rows are kept'],
    [/an ALL-CAPS name is shown in Title Case/, 'the display name rule'],
    [/the offer carries the LATEST price/, 'the offer carries the latest price'],
    [/the visitor sees the two perfumes that have stock/, 'a sold-out perfume stays hidden'],
    [/the same perfume at the second store is the same product/, 'one perfume at two stores is one product'],
    [/size 100: the platform offer is the cheaper store B at 1300/, 'the cheapest store wins a size'],
    [/size 200: only store B sells it, so B is the cheapest by itself/, 'a brand at one store makes that store the cheapest'],
    [/B sold out: the platform offer is A at 1450/, 'a sold-out cheapest hands over to the next store'],
    [/an offer the store marks unavailable is not shown even with stock/, 'available:false hides the offer'],
    [/re-sending creates no product, size or offer/, 'sending the same batch twice creates nothing twice'],
    [/the card X does not take "X Perfumes" by guessing/, 'a brand is never guessed'],
    [/adding the alias releases the waiting perfume/, 'an alias releases the waiting perfumes'],
    [/renaming the card to the store''s brand releases the waiting perfume/, 'a rename releases the waiting perfumes'],
    [/an inactive brand card is not on the platform: the perfume waits/, 'an inactive card is not a card'],
    [/re-activating the card releases it/, 're-activating releases'],
    [/two cards with the same normalized name: the item is held, not guessed/, 'two cards with one name hold the item'],
    [/a held item is never released by itself/, 'a held item waits for a person'],
    [/a store_catalog item never overwrites a trial_catalog offer/, 'one data source never overwrites another'],
    [/three hundred perfumes are placed by one brand insert/, 'a big release does not fail'],
    [/an Arabic name gets a safe slug/, 'an Arabic name is placed'],
    [/only the server receives items/, 'the entry point is server-only'],
    [/a visitor cannot read the waiting room/, 'the waiting room is closed to a visitor'],
    [/a customer cannot write the waiting room/, 'the waiting room is closed to a customer'],
    [/a visitor cannot add a brand alias/, 'aliases are closed to a visitor'],
    [/a card created by the server role releases the waiting perfumes by itself/, 'the editor path (service_role) releases too'],
    [/the visitor sees both perfumes of the new card/, 'what the card brings is visible']
  ];
  for (const [pattern, what] of rules) assert.match(sql, pattern, what);
});

test('the migration keeps the agreement: one entry point, waiting by brand, release by itself, nothing guessed', () => {
  const m = code(migration);
  // the two tables are server-only
  for (const table of ['catalog_brand_aliases', 'catalog_waiting_items']) {
    assert.match(m, new RegExp(`alter table public\\.${table} enable row level security`), `${table} has row level security`);
    assert.match(m, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`), `${table} is closed to the browser roles`);
  }
  assert.doesNotMatch(m, /grant\s+(select|insert|update|delete)[^;]*\bto\s+(anon|authenticated)/i, 'nothing in this migration opens a table to the browser roles');
  // one entry point, for the server alone
  assert.match(m, /create or replace function public\.catalog_receive_items\(p_store_id uuid, p_items jsonb, p_data_source text default 'store_catalog'\)/);
  assert.match(m, /revoke all on function public\.catalog_receive_items\(uuid, jsonb, text\) from public, anon, authenticated/);
  assert.match(m, /grant execute on function public\.catalog_receive_items\(uuid, jsonb, text\) to service_role/);
  assert.doesNotMatch(m, /grant execute on function[^;]*\bto\s+(anon|authenticated|public)\b/i, 'no function is opened to the browser roles');
  assert.match(m, /data_source in \('store_catalog', 'trial_catalog'\)/, 'every item declares where it came from');
  assert.match(m, /at most 1000 items per call/);
  // a bad item is refused with its reason, field by field, and nothing is completed or guessed
  const problem = body(m, 'create or replace function private.catalog_item_problem');
  for (const reason of ['brand_missing', 'name_missing', 'size_invalid', 'price_invalid', 'stock_invalid', 'currency_not_egp', 'gender_invalid', 'available_invalid', 'url_invalid']) {
    assert.match(problem, new RegExp(`'${reason}'`), reason);
  }
  assert.match(problem, /'unisex'/);
  assert.match(problem, /\^https\?:\/\//, 'only an http(s) link is accepted');
  // the brand: by name first, then by alias, never between two cards
  const brand = body(m, 'create or replace function private.catalog_resolve_brand');
  assert.match(brand, /b\.is_active and private\.bundle_norm\(b\.name\) = p_brand_norm/, 'only an active card counts');
  assert.match(brand, /raise exception 'ambiguous_brand'/, 'two cards with one name are never guessed between');
  assert.match(brand, /a\.alias_norm = p_brand_norm/, 'an alias is matched on the normalized text');
  // placing: the product by brand + normalized name, the offer of one data source is never overwritten by another
  const place = body(m, 'create or replace function private.catalog_place_item');
  assert.match(place, /private\.bundle_norm\(p\.name\) = v_norm/, 'the same perfume at two stores is one product');
  assert.match(place, /where sp\.data_source = excluded\.data_source/, 'an offer of another source is never overwritten');
  assert.match(place, /'source_conflict'/);
  assert.match(place, /status, is_active\)\s+values \(p_brand, private\.catalog_display_name\(p_name\), v_slug, p_gender, 'published', true\)/, 'a placed perfume is published');
  assert.match(place, /'EGP'/, 'EGP only');
  // the release runs from the brand card and the alias by themselves, and never fails the card
  const brandTrigger = body(m, 'create or replace function private.brands_release_waiting');
  assert.match(brandTrigger, /exception when others then\s+raise warning/, 'creating a brand card never fails because of the waiting room');
  assert.match(m, /create trigger brands_release_waiting\s+after insert or update of name, is_active on public\.brands/);
  assert.match(m, /create trigger catalog_brand_aliases_release_waiting\s+after insert or update of alias_text, brand_id on public\.catalog_brand_aliases/);
  // no automatic deletion of anything
  assert.doesNotMatch(m, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column)\b/i, 'the migration deletes nothing');
});

test('the waiting room is the ONE door: the trial loader sends through it and writes no table directly', () => {
  const loader = read('tools', 'catalog-trial', 'gen_receive.py');
  assert.match(loader, /public\.catalog_receive_items\(v_store, v_items, 'trial_catalog'\)/);
  assert.doesNotMatch(loader, /insert into public\.(products|product_sizes|store_products)/i, 'the loader decides nothing and writes nothing but through the entry point');
  assert.ok(!fs.existsSync(path.join(root, 'tools', 'catalog-trial', 'gen_sql2.py')), 'the old direct-write loader is gone, so nobody has two ways in');
});

test('the rollback drops every object the migration creates and warns what it cannot restore', () => {
  const created = [...migration.matchAll(/^create (?:or replace )?function ((?:public|private)\.[a-z_]+)/gm)].map((m) => m[1]);
  assert.deepEqual([...created].sort(), [
    'private.aliases_release_waiting', 'private.brands_release_waiting', 'private.catalog_display_name', 'private.catalog_item_problem',
    'private.catalog_place_item', 'private.catalog_release_waiting', 'private.catalog_resolve_brand',
    'public.catalog_receive_items', 'public.catalog_release_waiting'
  ], 'the migration creates exactly these nine functions (a new one must be added here and dropped by the rollback)');
  for (const name of created) assert.ok(rollback.includes(name), `the rollback drops ${name}`);
  for (const table of ['catalog_brand_aliases', 'catalog_waiting_items']) assert.match(rollback, new RegExp(`drop table if exists public\\.${table}`));
  for (const trigger of ['brands_release_waiting', 'catalog_brand_aliases_release_waiting']) assert.match(rollback, new RegExp(`drop trigger if exists ${trigger}`));
  assert.match(rollback, /^begin;/m);
  assert.match(rollback, /commit;\s*$/);
  assert.match(rollback, /WARNING/, 'the rollback says what it cannot restore');
});

test('the attack test lists both tables as server-only, so a grant added later fails there', () => {
  const attack = read('tests', 'rls-attack-surface.test.sql');
  assert.match(attack, /'catalog_waiting_items', 'catalog_brand_aliases'\]/);
});
