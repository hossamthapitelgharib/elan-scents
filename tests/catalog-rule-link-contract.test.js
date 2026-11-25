// The CATALOG RULE LINK contract (owner's decisions of 23-24 Nov 2026: the sorting into offers and bundles is automatic, one rule, applied through
// the ONE entry point; a doubtful product waits for him and his answer is kept once and honoured on every sync) is checked against the real database by
// tests/catalog-rule-link.test.sql (run on the live database as the owner, inside one transaction that ends in ROLLBACK).
// This file pins that the SQL test exists, leaves nothing behind, still states each rule, and that the migration
// (supabase/migrations/20261125122045_catalog_rule_link.sql, applied on the live database on 2026-11-25) and its rollback still hold the same rules,
// so nobody can empty the test or loosen the migration silently (a migration that was applied is never edited: a change is a new migration, and then this file is updated with it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const found = (dir) => (fs.existsSync(path.join(root, 'supabase', dir)) ? fs.readdirSync(path.join(root, 'supabase', dir)) : []).filter((name) => name.endsWith('_catalog_rule_link.sql'));
const applied = found('migrations');
const undo = found('rollback');
const migration = applied.length === 1 ? read('supabase', 'migrations', applied[0]) : '';
const rollback = undo.length === 1 ? read('supabase', 'rollback', undo[0]) : '';
const sql = read('tests', 'catalog-rule-link.test.sql');
const code = (text) => text.replace(/--[^\n]*/g, '');
const fn = (text, start) => { const i = text.indexOf(start); assert.ok(i >= 0, `${start} exists`); const j = text.indexOf('$function$;', text.indexOf('$function$', i) + 10); return text.slice(i, j); };

test('the real-database test runs in one transaction and leaves no row behind', () => {
  assert.match(sql, /^begin;/m);
  assert.match(sql, /rollback;\s*$/);
  assert.doesNotMatch(sql, /\bcommit\b/i);
  assert.doesNotMatch(sql, /\btruncate\b|\bdrop\s+(table|view|schema)\b/i);
  assert.match(sql, /20261125122045_catalog_rule_link/);
  assert.equal(applied.length, 1, 'exactly one migration file named catalog_rule_link');
  assert.equal(undo.length, 1, 'and exactly one rollback for it');
  assert.equal(applied[0], undo[0], 'the rollback has the same name and version as the migration');
});

test('every owner rule has its assertion', () => {
  const rules = [
    [/two offer messages \(the repeated section name is written once\)/, 'every offer section of a perfume, once each'],
    [/the offer carries the merchant''s own words/, 'the merchant\'s own words'],
    [/no price was touched by the offer message/, 'an offer never touches a price'],
    [/the perfume still shows by the normal visibility rules/, 'a single perfume in an offer stays a plain perfume under the platform\'s rules'],
    [/no offer row was deleted/, 'nothing is deleted when the merchant leaves a section'],
    [/the section the merchant left goes quiet/, 'a left section goes quiet'],
    [/no offers field = the messages are left as they are/, 'an older caller does not silence offers'],
    [/an empty offers list silences/, 'an empty list silences'],
    [/the by-hand message was adopted/, 'a by-hand message is adopted'],
    [/an offer of another data source is never overwritten/, 'another source is never overwritten'],
    [/four bad offers fields refused/, 'bad offers refused'],
    [/an unknown kind is refused/, 'unknown kind refused'],
    [/the waiting row holds the offer sections/, 'a waiting perfume keeps its sections'],
    [/the offer sections were written when it was released/, 'written at release'],
    [/the merchant''s title and FULL text are stored exactly as sent/, 'the merchant\'s full text'],
    [/never gets a composition key/, 'a rule-written bundle is never merged across stores'],
    [/a sure bundle is published/, 'sure = published'],
    [/a doubtful bundle is a draft/, 'doubtful = draft'],
    [/a draft is hidden from the visitor/, 'a draft is hidden'],
    [/the owner''s review queue/, 'the review queue'],
    [/after the owner says bundle the visitor sees it/, 'the owner\'s yes shows it at once'],
    [/the owner''s answer wins over the rule on the next sync/, 'the owner\'s yes is honoured on every sync'],
    [/not_bundle is honoured even when the rule says yes/, 'the owner\'s no is honoured on every sync'],
    [/no duplicate was created for a declined product/, 'a declined product creates nothing twice'],
    [/adopting creates no new bundle/, 'an older bundle is adopted, not duplicated'],
    [/its structured pieces are untouched/, 'adoption keeps the structured pieces'],
    [/a bundle of another data source is held, not overwritten/, 'another source\'s bundle is held'],
    [/nine bad bundle items refused/, 'a bad bundle never stops the others'],
    [/each refusal names its reason/, 'each refusal has its reason'],
    [/re-sending creates no second bundle/, 're-sending is idempotent'],
    [/sold out = hidden from the visitor/, 'sold out is hidden'],
    [/a mixed batch is counted by kind/, 'a mixed batch'],
    [/a visitor cannot read the owner''s decisions/, 'decisions are server-only'],
    [/a customer cannot write a decision/, 'no customer write'],
    [/a customer calling the entry point is refused/, 'the entry point is server-only'],
    [/a customer calling the bundle path directly is refused/, 'the bundle path is server-only'],
  ];
  for (const [re, what] of rules) assert.match(sql, re, what);
});

test('the migration keeps the rules the test proves', () => {
  const c = code(migration);
  // nothing the visitor sees changes until a caller sends the new fields: the new table and functions are server-only
  assert.ok(migration.length > 0, 'the migration file exists');
  assert.match(c, /alter table public\.catalog_owner_decisions enable row level security;/);
  assert.match(c, /revoke all on table public\.catalog_owner_decisions from public, anon, authenticated;/);
  for (const f of ['catalog_receive_items(uuid, jsonb, text)', 'catalog_record_decision(uuid, text, text, text)', 'catalog_review_queue()', 'catalog_receive_bundle(uuid, jsonb, text)', 'catalog_bundle_problem(jsonb)', 'catalog_apply_offers(uuid, uuid, text, text[])'])
    assert.ok(c.includes(f + ' from public, anon, authenticated;'), `${f} is not executable by clients`);
  for (const f of ['public.catalog_receive_items(uuid, jsonb, text)', 'public.catalog_record_decision(uuid, text, text, text)', 'public.catalog_review_queue()'])
    assert.ok(c.includes(`grant execute on function ${f} to service_role;`), `${f} is for the server role`);
  assert.doesNotMatch(c, /grant [^;]*\b(anon|authenticated)\b/i, 'no grant to a client role');
  // offers are never deleted: a section the merchant leaves makes the message go quiet
  assert.doesNotMatch(c, /delete\s+from\s+public\.offers/i);
  assert.match(fn(c, 'function private.catalog_apply_offers'), /set is_active = false/);
  // another source is never overwritten
  assert.match(fn(c, 'function private.catalog_apply_offers'), /o\.catalog_source is null or o\.catalog_source = p_source/);
  assert.match(fn(c, 'function private.catalog_receive_bundle'), /v_ex\.data_source <> p_source then return jsonb_build_object\('status', 'held', 'reason', 'source_conflict'\)/);
  // a bundle written from the merchant's text has no composition key, so it is never merged with another store's
  assert.match(fn(c, 'function private.catalog_receive_bundle'), /insert into public\.bundles \(brand_id, name, slug, has_extra_items, status, is_active\)\s+values \(v_brand_id, left\(v_title, 200\), v_slug, true,/);
  // the owner's answer decides before the rule
  const rb = fn(c, 'function private.catalog_receive_bundle');
  assert.match(rb, /when 'bundle' then 'published'\s+when 'not_bundle' then 'declined'\s+else case when v_rule = 'yes' then 'published' else 'draft' end/);
  assert.match(rb, /case when v_final = 'published' then 'published' else 'draft' end/);
  // the rule may only say yes or review; 'no' is a perfume and never travels as a bundle
  assert.match(fn(c, 'function private.catalog_bundle_problem'), /not in \('yes', 'review'\)/);
  // the merchant's text is stored as sent (trimmed only), never rewritten
  assert.match(rb, /v_desc := nullif\(btrim\(coalesce\(p_item ->> 'description', ''\)\), ''\)/);
  // the entry point still caps a call, still only knows the two data sources and still refuses a non-array
  const re = fn(c, 'function public.catalog_receive_items');
  assert.match(re, /jsonb_array_length\(p_items\) > 1000/);
  assert.match(re, /p_data_source not in \('store_catalog', 'trial_catalog'\)/);
  assert.match(re, /v_kind <> 'perfume' then\s+v_status := 'rejected';\s+v_reason := 'kind_invalid'/);
  // an item without the offers field never touches the messages
  assert.match(re, /v_has_offers := jsonb_typeof\(v_item -> 'offers'\) = 'array'/);
  assert.match(re, /if v_status = 'placed' and v_has_offers then/);
  // a perfume released from the waiting room writes its offer sections
  assert.match(fn(c, 'function private.catalog_release_waiting'), /perform private\.catalog_apply_offers\(r\.store_id, v_size, r\.data_source/);
});

test('the rollback restores the previous entry point and removes everything the link added', () => {
  const c = code(rollback);
  assert.match(c, /create or replace function public\.catalog_receive_items/);
  assert.match(c, /create or replace function private\.catalog_release_waiting/);
  assert.doesNotMatch(c, /n_bundles_published|catalog_apply_offers\(r\./, 'the restored bodies are the waiting room\'s own');
  for (const what of ['drop table if exists public.catalog_owner_decisions', 'drop column if exists offers', 'drop column if exists catalog_source', 'drop function if exists public.catalog_record_decision', 'drop function if exists public.catalog_review_queue', 'drop function if exists private.catalog_receive_bundle'])
    assert.ok(c.includes(what), what);
  assert.match(rollback, /WARNING: this loses data/);
});
