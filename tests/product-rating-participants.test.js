// The rating of a perfume is built from its PARTICIPANTS (migration 20261111122138_product_rating_participants_mean, the owner's
// decision of 2026-11-10). The real-database behaviour is checked by tests/product-rating-participants.test.sql (and the rankings /
// ratings / final-stats tests); this file pins what must not drift:
//   * participants = the customers (approved reviews) and each ACTIVE store that rated the perfume - nobody else;
//   * stars = the plain mean of the participants' own averages, count = round(all ratings / 2), no minimum for the figures to exist;
//   * «الأكثر تقييمًا» needs >= 3 ratings at ONE participant AND stored stars >= 3.00, ordered by stars then count, ties share a rank;
//   * the new column is written by both writers, tied to the rating by a check, and the migration deletes nothing;
//   * the rollback brings the previous weighted rule back and recomputes before it drops the column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261111122138_product_rating_participants_mean.sql';
const code = () => read('supabase', 'migrations', NAME).replace(/--.*$/gm, '');
const section = (m, from, to) => m.slice(m.indexOf(from), to ? m.indexOf(to, m.indexOf(from)) : undefined);

test('the migration has its rollback and the real-database tests that cover it, under the version the database recorded', () => {
  assert.ok(fs.existsSync(path.join(root, 'supabase', 'rollback', NAME)), 'rollback file');
  const sqlTest = read('tests', 'product-rating-participants.test.sql');
  assert.match(sqlTest, new RegExp(NAME.replace(/\./g, '\\.')), 'the test names the migration');
  assert.match(sqlTest, /^begin;/m);
  assert.match(sqlTest, /rollback;\s*$/, 'the test leaves no row behind');
  for (const file of ['final-product-stats.test.sql', 'storefront-rankings.test.sql', 'storefront-ratings-single-source.test.sql']) {
    assert.match(read('tests', file), new RegExp(NAME.replace(/\./g, '\\.')), file + ' names the migration');
  }
  // 10 / 100 / 500 ratings from the customers and two stores: 4.00 stars and round(610 / 2) = 305 ratings
  assert.match(sqlTest, /4\.00/);
  assert.match(sqlTest, /305/);
});

test('participants: the approved customer reviews and every ACTIVE store, one row per store, nobody else', () => {
  const m = code();
  const fn = section(m, 'create function private.fn_product_rating_sources()', 'revoke all on function private.fn_product_rating_sources()');
  assert.match(fn, /where r\.is_approved\s+group by r\.product_id/);
  assert.match(fn, /join public\.stores st on st\.id = t\.store_id and st\.status = 'active'/);
  assert.match(fn, /group by ps\.product_id, t\.store_id/, 'a store with several sizes of one perfume is ONE participant');
  assert.match(fn, /sum\(t\.average_rating \* t\.ratings_count\) \/ sum\(t\.ratings_count\)/, 'a store\'s own average over its sizes is weighted by its ratings');
  assert.match(fn, /security definer\s+set search_path to 'public', 'pg_temp'/);
  assert.match(m, /drop function private\.fn_product_rating_sources\(\);/);
});

test('stars = mean of the participants\' averages (2 decimals), count = round(all ratings / 2), no minimum here', () => {
  const m = code();
  const fn = section(m, 'create function private.fn_product_rating_sources()', 'revoke all on function private.fn_product_rating_sources()');
  assert.match(fn, /round\(avg\(p\.avg_rating\), 2\)/);
  assert.match(fn, /least\(round\(sum\(p\.n\) \/ 2\.0\), 2147483647\)::integer/);
  assert.match(fn, /least\(max\(p\.n\), 2147483647\)::integer/, 'the biggest single participant');
  assert.match(fn, /bool_and\(p\.kind = 'customers'\) then 'customers'/);
  assert.match(fn, /bool_and\(p\.kind = 'store'\) then 'store_catalog'/);
  assert.match(fn, /else 'combined'/);
  assert.doesNotMatch(fn, /having\b|>= 3/, 'the 3-ratings rule belongs to the ranking, not to the figures');
  assert.match(m, /grant execute on function private\.fn_product_rating_sources\(\) to anon, authenticated, service_role;/,
    'a security_invoker view chain checks EXECUTE as the calling role');
});

test('«الأكثر تقييمًا»: >= 3 ratings at one participant AND stored stars >= 3.00, stars then count, ties share a rank', () => {
  const m = code();
  const rank = section(m, 'create or replace function private.fn_storefront_product_rankings()', 'comment on function private.fn_storefront_product_rankings()');
  assert.match(rank, /join public\.product_stats s on s\.product_id = f\.product_id/, 'reads the stored figures');
  assert.match(rank, /coalesce\(s\.average_rating >= 3\.00 and s\.rating_top_source_count >= 3, false\) as rated/);
  assert.match(rank, /rank\(\) over \(partition by rated order by ar desc nulls last, rn desc nulls last\) as rating_r/);
  assert.match(rank, /case when r\.rated then r\.rating_r::integer end, case when r\.rated then r\.rsrc end/);
  assert.match(rank, /where r\.ssrc is not null or r\.vsrc is not null or r\.qsrc is not null or r\.rated/);
  assert.doesNotMatch(rank, /\(ssrc = 'customers'\)|\(vsrc = 'customers'\)|\(qsrc = 'customers'\)/, 'customers do not jump the queue');
  assert.match(rank, /security definer\s+set search_path to 'public', 'pg_temp'/);
});

test('both writers carry rating_top_source_count; the column is non-negative and tied to the rating', () => {
  const m = code();
  const one = section(m, 'create or replace function private.refresh_product_ratings(', 'create or replace function private.refresh_product_stats(');
  const all = section(m, 'create or replace function private.refresh_product_stats(', 'comment on function private.refresh_product_stats(');
  for (const fn of [one, all]) {
    assert.match(fn, /rating_top_source_count = excluded\.rating_top_source_count/);
    assert.match(fn, /t\.rating_top_source_count/, 'part of the "only changed rows are written" comparison');
    assert.match(fn, /coalesce\(r\.top_source_count, 0\)/);
    assert.match(fn, /security definer\s+set search_path to 'public', 'pg_temp'/);
  }
  assert.match(all, /round\(\(coalesce\(a\.sales, 0\) \+ coalesce\(ss\.v, 0\)\) \/ 2\.0\)::bigint as sales/, 'the sales rule of the previous migration is kept');
  assert.equal((all.match(/and st\.status = 'active'/g) || []).length, 3, 'inactive stores never count');
  assert.match(m, /add column rating_top_source_count integer not null default 0/);
  assert.match(m, /add constraint product_stats_rating_top_nonnegative check \(rating_top_source_count >= 0\)/);
  assert.match(m, /select private\.refresh_product_stats\(\);\s*alter table public\.product_stats\s+add constraint product_stats_rating_top_matches check \(\(rating_top_source_count > 0\) = \(average_rating is not null\)\);\s*$/,
    'recompute first, then add the check that needs the recomputed column');
});

test('it deletes nothing, does not touch the public view, and the 5-minute job is left as it is', () => {
  const m = code();
  assert.doesNotMatch(m, /\bdelete\s+from\b|\btruncate\b|\bdrop\s+(table|column|view|schema)\b/i);
  assert.doesNotMatch(m, /comment on view public\.public_products|create or replace view public\.public_products/, 'the view belongs to the catalog work');
  assert.doesNotMatch(m, /cron\.(un)?schedule/);
  assert.equal((m.match(/\bdrop\s+function\b/gi) || []).length, 1, 'only the old rating function, whose column list changes');
});

test('the rollback restores the weighted rule, recomputes, then drops the column and its checks', () => {
  const rb = read('supabase', 'rollback', NAME);
  assert.match(rb, /^begin;/m);
  assert.match(rb, /commit;\s*$/);
  const dropCheck = rb.indexOf('drop constraint product_stats_rating_top_matches');
  const refresh = rb.indexOf('select private.refresh_product_stats();');
  const dropColumn = rb.indexOf('drop column rating_top_source_count');
  assert.ok(dropCheck > 0 && dropCheck < refresh, 'the check goes before the recompute (the old writers do not know the column)');
  assert.ok(refresh > 0 && dropColumn > refresh, 'recompute with the old rule, then drop the column');
  assert.match(rb, /having count\(\*\) >= 3|>= 3/, 'the 3-ratings minimum of the weighted rule comes back');
  assert.match(rb, /join private\.fn_product_final_stats\(\) s on s\.product_id = f\.product_id/, 'the old ranking reads the final stats again');
  assert.match(rb, /partition by \(ar is not null\) order by ar desc nulls last, rn desc nulls last/);
});
