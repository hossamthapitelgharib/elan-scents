const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261107013025_catalog_public_offer_views.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261107013025_catalog_public_offer_views.sql'), 'utf8');

test('public catalog views use fixed-search-path security-definer wrappers', () => {
  assert.equal((migration.match(/SECURITY DEFINER/g) || []).length, 2);
  assert.equal((migration.match(/SET search_path TO pg_catalog, public, private, pg_temp/g) || []).length, 2);
  assert.match(migration, /fn_catalog_public_eligible_offers\(\)/);
  assert.match(migration, /fn_catalog_public_platform_offers\(\)/);
  assert.match(migration, /GRANT SELECT ON public\.catalog_eligible_offers, public\.catalog_platform_offers/);
  assert.doesNotMatch(migration, /commission_rate\s*,\s*priority_rank\s+FROM|SELECT .*commission_rate/);
});

test('public catalog view rollback restores the old views and removes only wrappers', () => {
  assert.match(rollback, /CREATE OR REPLACE VIEW public\.catalog_eligible_offers/);
  assert.match(rollback, /CREATE OR REPLACE VIEW public\.catalog_platform_offers/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS private\.fn_catalog_public_eligible_offers/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS private\.fn_catalog_public_platform_offers/);
});
