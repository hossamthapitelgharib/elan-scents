const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'supabase');
const list = (dir) => (fs.existsSync(path.join(root, dir))
  ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.sql')).sort()
  : []);
const migrations = list('migrations');
const pending = list('pending');
const FORMAT = /^\d{14}_[a-z0-9_]+\.sql$/;

test('migration files follow the <14-digit version>_<name>.sql format', () => {
  assert.ok(migrations.length > 0);
  for (const file of [...migrations, ...pending]) assert.match(file, FORMAT, file);
});

test('migration versions are unique and strictly ascending', () => {
  const versions = migrations.map((f) => f.split('_')[0]);
  assert.deepEqual(versions, [...versions].sort());
  assert.equal(new Set(versions).size, versions.length);
});

test('a migration name never appears twice under different versions', () => {
  const names = [...migrations, ...pending].map((f) => f.slice(f.indexOf('_') + 1));
  const duplicated = names.filter((name, i) => names.indexOf(name) !== i);
  assert.deepEqual(duplicated, []);
});

/* Files recovered verbatim from the live ledger keep the md5 of the ledger statement (recorded in supabase/README.md).
   The Supabase GitHub integration needs a file for every version recorded live, so these must exist and stay unedited. */
test('the files recovered verbatim from the live ledger keep their ledger text', () => {
  const crypto = require('node:crypto');
  const recovered = {
    '20261009230647_harden_order_user_binding_earlier_run.sql': '00be6300a1f9b9a3f308159a25309dc1',
    '20261010001456_guest_browser_identity_analytics_earlier_run.sql': 'b25c1766865869c3fd07609cbccff46e',
    '20261104113824_server_side_customer_rpcs_second_run.sql': 'a57e19a90693c2029e6d471e4a7a0172',
    '20261105090845_normalize_catalog_gender_filters.sql': '065c56c077a63503185b9746dd44cbc7',
    '20261105091817_rollback_normalize_catalog_gender_filters.sql': 'ce68c479f7f582f3fd336a1f13986d4a',
    '20261106122029_commission_watch_on_unified_ledger.sql': '1e0177312f576822e1fd4861139f79fc',
    '20261106122349_commission_watch_shipped_unreported.sql': '15fb5ff41b3b622d86397cff92da64cc',
    '20261107160412_phase1_purchase_core.sql': 'd86d66d20b8c4e77556faac475f049b3'
  };
  for (const [file, md5] of Object.entries(recovered)) {
    assert.ok(migrations.includes(file), file + ' is missing');
    const body = fs.readFileSync(path.join(root, 'migrations', file));
    assert.equal(crypto.createHash('md5').update(body).digest('hex'), md5, file + ' was edited');
  }
});

test('pending migrations are newer than every applied migration', () => {
  if (!pending.length) return;
  const last = migrations[migrations.length - 1].split('_')[0];
  for (const file of pending) assert.ok(file.split('_')[0] > last, `${file} must be newer than ${last}`);
});

test('migration and test SQL contain no secrets', () => {
  const dirs = [path.join(root, 'migrations'), path.join(root, 'pending'), path.join(__dirname)];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{20,}\./, `${file} contains a JWT`);
      assert.doesNotMatch(sql, /sb_secret_|service_role_key\s*[:=]/i, `${file} contains a key`);
    }
  }
});
