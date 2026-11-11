// A security_invoker view checks EXECUTE of the functions it calls as the CALLING role. The migration 20261110081953 left
// private.fn_catalog_coming_soon_announcements() executable by postgres only, so every visitor got "permission denied" on
// public.public_products and the storefront showed no perfumes; 20261111122056_catalog_announcements_function_grants gives the
// three API roles EXECUTE back. The real-database behaviour is tests/catalog-announcements-function-grants.test.sql; this file
// pins the migration text (exactly one grant, to exactly the three API roles, nothing for PUBLIC) and the rollback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const NAME = '20261111122056_catalog_announcements_function_grants.sql';

test('the migration is the single grant, to the three API roles only', () => {
  const m = read('supabase', 'migrations', NAME);
  assert.equal(m, 'grant execute on function private.fn_catalog_coming_soon_announcements() to anon, authenticated, service_role;',
    'the file is the exact statement the ledger recorded (md5 7835f701b85f58f65bf005f6e937d9a6)');
  assert.equal(require('node:crypto').createHash('md5').update(m).digest('hex'), '7835f701b85f58f65bf005f6e937d9a6');
  assert.doesNotMatch(m, /\bpublic\b.*\bgrant\b|to public/i);
});

test('the rollback revokes exactly that grant, with the warning, and the real-database test covers the storefront read', () => {
  const rb = read('supabase', 'rollback', NAME);
  assert.match(rb, /^begin;/m);
  assert.match(rb, /revoke execute on function private\.fn_catalog_coming_soon_announcements\(\) from anon, authenticated, service_role;/);
  assert.match(rb, /commit;\s*$/);
  assert.match(rb, /WARNING/);
  const t = read('tests', 'catalog-announcements-function-grants.test.sql');
  assert.match(t, /^begin;/m);
  assert.match(t, /rollback;\s*$/);
  assert.match(t, /set local role anon;[\s\S]*public\.public_products[\s\S]*set local role authenticated;/);
  assert.match(t, new RegExp(NAME.replace(/\./g, '\\.')));
});
