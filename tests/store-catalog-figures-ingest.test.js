// The server-only writer of the four store ranking tables (migration 20261108061137_store_catalog_figures_ingest).
// The real-database behaviour is checked by tests/store-catalog-figures-ingest.test.sql; this file keeps the files that belong
// together together and pins the rules that must not drift: only the server may call it, nothing is half-written, the offer must
// belong to the store the server names, and an older report never overwrites a newer one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261108061137_store_catalog_figures_ingest.sql';
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');

test('the migration has its rollback and its real-database test, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'store-catalog-figures-ingest.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')));
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  const rollback = read('supabase', 'rollback', NAME);
  assert.match(rollback, /drop function if exists public\.ingest_store_catalog_figures\(uuid, jsonb\);/);
  assert.doesNotMatch(rollback, /drop table|delete from|truncate/i, 'a rollback of the writer never touches what stores reported');
});

test('only the server can call it, and it runs with the caller\'s own rights so the tables\' privileges stay the second lock', () => {
  const m = code();
  assert.match(m, /revoke all on function public\.ingest_store_catalog_figures\(uuid, jsonb\) from public, anon, authenticated;\s*grant execute on function public\.ingest_store_catalog_figures\(uuid, jsonb\) to service_role;/);
  assert.match(m, /revoke all on function private\.ingest_figure_int\(jsonb, text, integer\) from public, anon, authenticated;\s*grant execute on function private\.ingest_figure_int\(jsonb, text, integer\) to service_role;/);
  const fn = m.slice(m.indexOf('create or replace function public.ingest_store_catalog_figures'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('as $function$')), /security definer/i, 'SECURITY INVOKER');
  assert.doesNotMatch(m, /grant execute[^;]* to (anon|authenticated|public)\b/i);
});

test('every figure is validated and nothing is half-written', () => {
  const m = code();
  assert.match(m, /jsonb_array_length\(p_figures\) > 1000/, 'a bounded batch');
  assert.match(m, /give exactly one of store_product_id or product_size_id/);
  assert.match(m, /sp\.store_id = p_store_id and sp\.id = v_by_offer::uuid/, 'an offer is looked up inside the named store only');
  assert.match(m, /sp\.store_id = p_store_id and sp\.product_size_id = v_by_size::uuid/);
  assert.match(m, /n <> trunc\(n\) or n < 0 or n > 2000000000/, 'whole numbers in range');
  assert.match(m, /v_avg < 1 or v_avg > 5/, 'a rating is 1 to 5');
  assert.match(m, /\(v_avg is null\) <> \(v_cnt is null\)/, 'a rating and its count go together');
  assert.match(m, /v_cnt < 1/);
  assert.match(m, /v_at > now\(\) \+ interval '1 day'/, 'no report from the future');
  assert.equal((m.match(/errcode = '22023'/g) || []).length >= 14, true, 'refusals are invalid_parameter_value errors, which abort the whole call');
  assert.doesNotMatch(m, /exception when others then\s*null|exception when [a-z_]+ then\s*null/i, 'no error is swallowed');
});

test('a newer report replaces; an older one never overwrites a newer one', () => {
  const m = code();
  assert.equal((m.match(/on conflict \(store_product_id\) do update/g) || []).length, 4, 'one upsert per ranking table');
  assert.equal((m.match(/where t\.reported_at <= excluded\.reported_at;/g) || []).length, 4, 'each guarded by the report time');
  assert.match(m, /'skipped_older_than_stored', n_stale/);
});
