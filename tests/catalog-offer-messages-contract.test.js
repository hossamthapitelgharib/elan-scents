// The OFFER MESSAGES and DISCOUNT DECLARATION contract (owner rules of 2026-11-14/15) and the move of the bundle views to
// security_invoker are checked against the real database by tests/catalog-offer-messages-contract.test.sql (run on the live database
// as the owner, inside one transaction that ends in ROLLBACK). This file pins that the SQL test exists, leaves nothing behind,
// still states each rule, and that the migration it covers still holds the same rules, so nobody can empty the test or loosen
// the migration silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const SUFFIX = '_catalog_bundle_views_and_offer_messages.sql';
const find = (dir) => {
  const found = fs.readdirSync(path.join(root, 'supabase', dir)).filter((name) => name.endsWith(SUFFIX));
  assert.equal(found.length, 1, `exactly one ${dir} file ends with ${SUFFIX}`);
  return found[0];
};
const migrationName = find('migrations');
const sql = read('tests', 'catalog-offer-messages-contract.test.sql');
const migration = read('supabase', 'migrations', migrationName);
const rollback = read('supabase', 'rollback', find('rollback'));

test('the rollback has the same version as the migration', () => {
  assert.equal(find('rollback'), migrationName);
});

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(table|view|schema)\b/i);
  assert.match(sql, /migration \d{14} catalog_bundle_views_and_offer_messages/);
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/every bundle view and the offer-message view is a security_invoker view/, 'no definer view is added'],
    [/public_bundle_items lists each piece as the store wrote it/, 'a piece the catalog does not hold is named by the bundle\'s own text'],
    [/a package piece carries its quantity, name, brand and size as the store wrote them/, 'the pieces are readable'],
    [/a package naming an unpublished perfume still shows with its items \(the perfumes are never consulted\)/, 'a package does not follow the perfume catalog'],
    [/the platform bundle offer still works through the invoker view/, 'the platform bundle offer keeps working'],
    [/the internal bundle offers \(with commission and priority\) are not callable by the browser roles/, 'commission never leaks'],
    [/an offer is a plain message unless the server says otherwise/, 'an offer is the default kind'],
    [/only offer and discount are valid kinds/, 'two kinds only'],
    [/the table itself refuses a blank title/, 'no blank message'],
    [/inactive, not-yet-started, ended, inactive-store and unpublished-perfume messages are never public/, 'the same visibility as the offers policy'],
    [/a store-wide message has no size and keeps its end date/, 'store-wide messages'],
    [/an explicit discount declaration is public as kind = discount/, 'a declared discount is visible as a discount'],
    [/the title is capped at 120 characters and the description at 500/, 'display caps'],
    [/the public message carries no discount type and no discount value/, 'no number from the store is exposed'],
    [/the message of a perfume appears when the perfume is published/, 'a message follows its perfume'],
    [/the cheapest real price wins even when the dearer store claims a huge old price and declares a discount/, 'a claimed old price or a declared discount never changes the price'],
    [/a claimed old price or a discount declaration neither adds nor removes an eligible offer/, 'nor the eligibility'],
    [/the platform offer view carries no claimed old price and no discount/, 'nor the public columns'],
    [/the browser role holds no table-wide write on offers/, 'only column grants'],
    [/control: a store member can still write all twelve columns it could write before/, 'nothing a store could write is lost'],
    [/control: deleting an own offer is unchanged/, 'delete is unchanged'],
    [/control: the column-level SELECT of the browser roles is unchanged/, 'reads are unchanged'],
    [/a store member cannot label its own message a discount/, 'the store cannot declare its own discount'],
    [/the visitor cannot write offers\.kind/, 'nor the visitor'],
    [/the server can declare a discount/, 'the server can'],
    [/the visitor reads the five live messages/, 'the visitor reads the messages'],
    [/the signed-in customer reads them too/, 'the customer too'],
    [/the visitor cannot read the offers table directly/, 'the view is the only public door']
  ];
  for (const [pattern, what] of rules) assert.match(sql, pattern, what);
});

test('the migration still states the same rules, so the test and the contract cannot drift apart', () => {
  const code = migration.replace(/--[^\n]*/g, '');
  assert.equal((code.match(/WITH \(security_invoker = true\)/g) || []).length, 3, 'three views are created as invoker views');
  assert.match(code, /ALTER VIEW public\.catalog_eligible_bundle_offers SET \(security_invoker = true\)/);
  assert.match(code, /ALTER VIEW public\.catalog_platform_bundle_offers SET \(security_invoker = true\)/);
  assert.match(code, /kind text NOT NULL DEFAULT 'offer'/);
  assert.match(code, /CHECK \(kind IN \('offer', 'discount'\)\)/);
  assert.match(code, /REVOKE INSERT, UPDATE ON public\.offers FROM authenticated/, 'the table-wide write is replaced by column grants');
  const grant = code.match(/GRANT INSERT \(([^)]*)\),\s*UPDATE \(([^)]*)\)\s*ON public\.offers TO authenticated/);
  assert.ok(grant, 'the column grants exist');
  assert.equal(grant[1], grant[2], 'insert and update cover the same columns');
  assert.equal(grant[1].split(',').length, 12, 'the twelve columns that existed before');
  assert.doesNotMatch(grant[1], /\bkind\b/, 'kind is never granted to the browser role');
  assert.match(code, /private\.store_is_active\(o\.store_id\)/, 'the same active-store rule as the offers policy');
  assert.match(code, /left\(btrim\(o\.title\), 120\)/);
  assert.match(code, /NULLIF\(left\(btrim\(o\.description\), 500\), ''\)/);
  const messages = code.slice(code.indexOf('CREATE FUNCTION private.fn_catalog_public_offer_messages'), code.indexOf('REVOKE ALL ON FUNCTION private.fn_catalog_public_offer_messages'));
  assert.doesNotMatch(messages, /discount_type|discount_value|original_price|discount_percentage/, 'the public message never selects a number the store typed');
  assert.match(code, /GRANT EXECUTE ON FUNCTION private\.fn_catalog_public_offer_messages\(\) TO anon, authenticated, service_role/);
  assert.match(code, /REVOKE ALL ON FUNCTION private\.fn_catalog_public_bundles\(\) FROM PUBLIC/);
  assert.match(code, /REVOKE ALL ON FUNCTION private\.fn_catalog_public_bundle_items\(\) FROM PUBLIC/);
  assert.doesNotMatch(code, /fn_catalog_eligible_bundle_offers\(\)\s+TO\b/, 'the internal offers (commission, priority) are never granted');
});

test('the rollback removes every object the migration creates and restores the previous grants', () => {
  const created = [...migration.matchAll(/^CREATE (?:VIEW|FUNCTION) ((?:public|private)\.[a-z_]+)/gm)].map((m) => m[1]);
  assert.ok(created.length >= 5, 'the migration creates functions and views');
  for (const name of created) assert.ok(rollback.includes(name), `the rollback handles ${name}`);
  assert.match(rollback, /drop column if exists kind/);
  assert.match(rollback, /grant insert, update on public\.offers to authenticated/, 'the table-wide write comes back');
  assert.match(rollback, /create view public\.public_bundles as/);
  assert.match(rollback, /create view public\.public_bundle_items as/);
  assert.match(rollback, /reset \(security_invoker\)/);
});
