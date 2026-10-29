const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NAME = '20261029063246_public_read_store_product_coming_soon_flag.sql';
const root = path.join(__dirname, '..', 'supabase');
const up = fs.readFileSync(path.join(root, 'migrations', NAME), 'utf8');
const down = fs.readFileSync(path.join(root, 'rollback', NAME), 'utf8');

test('the migration file is the statement recorded in the live ledger (one trailing newline added)', () => {
  assert.ok(up.endsWith('\n') && !up.endsWith('\n\n'));
  assert.equal(crypto.createHash('md5').update(up.slice(0, -1)).digest('hex'), 'd8fd1de4e112e4f4c4a7704895e4a5b5');
});

test('it grants visitors one column only, never the whole table', () => {
  const sql = up.replace(/^--.*$/gm, '');
  assert.match(sql, /GRANT SELECT \(is_coming_soon\) ON TABLE public\.store_products TO anon, authenticated;/);
  assert.doesNotMatch(sql, /GRANT\s+(ALL|SELECT)\s+ON\s+TABLE/i, 'no table-wide grant');
});

test('the rollback revokes exactly that column grant in one transaction', () => {
  assert.match(down, /^begin;/m);
  assert.match(down, /revoke select \(is_coming_soon\) on table public\.store_products from anon, authenticated;/);
  assert.match(down, /^commit;/m);
});
