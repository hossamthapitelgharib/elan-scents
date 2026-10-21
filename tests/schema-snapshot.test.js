const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'supabase', 'schema-snapshot');
const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

// Rows of the form: | `tables-1.txt` | `<md5>` | description |
const recorded = [...readme.matchAll(/^\|\s*`([a-z0-9-]+\.txt)`\s*\|\s*`([0-9a-f]{32})`\s*\|/gm)]
  .map((m) => ({ file: m[1], md5: m[2] }));

const md5 = (text) => crypto.createHash('md5').update(text, 'utf8').digest('hex');

test('schema snapshot README records every snapshot file exactly once', () => {
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  assert.deepEqual(recorded.map((r) => r.file).sort(), onDisk);
  assert.equal(new Set(recorded.map((r) => r.file)).size, recorded.length);
});

test('each snapshot file matches the md5 recorded in the README (text without its final newline)', () => {
  assert.ok(recorded.length >= 6);
  for (const { file, md5: expected } of recorded) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(content.endsWith('\n') && !content.endsWith('\n\n'), `${file} must end with exactly one newline`);
    assert.equal(md5(content.slice(0, -1)), expected, `${file} differs from the md5 in README.md; regenerate it with generate.sql and update the table together`);
  }
});

test('snapshot files are plain ASCII with no carriage returns', () => {
  for (const { file } of recorded) {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(content), `${file} contains a non-ASCII or control character`);
  }
});

test('snapshot is structure only: no row data, secrets or function bodies', () => {
  const text = recorded.map(({ file }) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{20,}/, 'looks like a JWT');
  assert.doesNotMatch(text, /sb_(secret|publishable)_[A-Za-z0-9_-]+/, 'looks like a Supabase key');
  assert.doesNotMatch(text, /\bINSERT INTO\b/i, 'must not contain row data');
  assert.doesNotMatch(text, /\$\$|\$function\$/, 'must not contain function bodies');
});

test('table blocks are well formed and cover every table once', () => {
  const blocks = ['tables-1.txt', 'tables-2.txt', 'tables-3.txt', 'tables-4.txt']
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trimEnd().split('\n\n'));
  const names = blocks.map((b) => {
    const m = /^TABLE ([a-z0-9_]+)  rls=(on|off)  grants: anon=\S+ authenticated=\S+ service_role=\S+$/m.exec(b.split('\n')[0]);
    assert.ok(m, `bad table header: ${b.split('\n')[0]}`);
    return m[1];
  });
  assert.equal(new Set(names).size, names.length, 'a table appears twice');
  assert.ok(names.length >= 52);
});

test('every public table in the snapshot has row level security on', () => {
  const text = ['tables-1.txt', 'tables-2.txt', 'tables-3.txt', 'tables-4.txt']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.deepEqual(text.match(/^TABLE .*  rls=off  /gm) || [], []);
});

test('generate.sql is read-only', () => {
  const sql = fs.readFileSync(path.join(dir, 'generate.sql'), 'utf8');
  assert.doesNotMatch(sql, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s|alter\s|create\s+(table|function|index|policy|extension)|grant\s|revoke\s|truncate\s)/i);
  assert.match(sql, /^with tb as \(/m);
});
