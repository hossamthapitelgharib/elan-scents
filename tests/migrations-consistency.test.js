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
