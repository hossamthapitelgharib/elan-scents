const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Negative control for tests/customer-best-sellers.test.js: proves that the "every audit field the API reads is
// returned by the newest SQL definition" check really fails when a field is dropped from the SQL, so a green run means something.
// This is the regression that once left the dashboard audit panel at zero: a later migration rewrote the function and dropped fields.

function newestDefinition() {
  const entries = ['migrations', 'pending'].map(dir => path.join(root, 'supabase', dir))
    .filter(dir => fs.existsSync(dir))
    .flatMap(dir => fs.readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => ({ name, file: path.join(dir, name) })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const definers = entries.filter(entry => /create or replace function public\.platform_registered_customer_best_sellers\s*\(/i.test(fs.readFileSync(entry.file, 'utf8')));
  assert.ok(definers.length > 0, 'the best-seller function is defined by a migration');
  const latest = definers[definers.length - 1];
  return { name: latest.name, sql: fs.readFileSync(latest.file, 'utf8') };
}

function auditKeysReadByApi() {
  const api = fs.readFileSync(path.join(root, 'api', 'customer-best-sellers.js'), 'utf8');
  return [...new Set([...api.matchAll(/result\.audit\.(\w+)/g)].map(match => match[1]))];
}

function missingKeys(sql, keys) {
  return keys.filter(key => !new RegExp(`'${key}'\\s*,`).test(sql));
}

test('the audit contract check reports exactly the field that is removed from the newest SQL (negative control)', () => {
  const { name, sql } = newestDefinition();
  const keys = auditKeysReadByApi();
  assert.ok(keys.length >= 14, 'the API reads the whole audit contract');
  assert.deepEqual(missingKeys(sql, keys), [], `baseline: ${name} returns every audit field the API reads`);
  for (const key of keys) {
    const broken = sql.replace(new RegExp(`'${key}'\\s*,`, 'g'), "'dropped_for_test',");
    assert.deepEqual(missingKeys(broken, keys), [key], `removing ${key} must be reported, and only that field`);
  }
});
