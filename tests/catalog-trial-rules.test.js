// The rules of docs/catalog-ingestion.ar.md, pinned on the real pages that hit each pitfall while the two trial catalogs were built (owner, 2026-11-17):
// the Python pipeline in tools/catalog-trial runs on tools/catalog-trial/fixtures and must still produce the same perfumes and hold back the same records.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const hasPython = !py.error && py.status === 0;

test('the trial pipeline still handles every pitfall met while building the two catalogs', { skip: hasPython ? false : 'python3 is not installed here' }, () => {
  const r = spawnSync('python3', ['-I', path.join(root, 'tools', 'catalog-trial', 'check_pitfalls.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all rules hold/);
});

test('the catalog constitution keeps the owner\'s vocabulary: «باقات وعروض», offer as the umbrella word, and «خصم» cancelled', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'catalog-ingestion.ar.md'), 'utf8');
  assert.match(doc, /قسم «باقات وعروض»/);
  assert.match(doc, /\*\*كلمة «خصم» ملغاة من قاموس المنصة\.\*\*/);
  assert.match(doc, /\*\*العرض\*\* = الكلمة الشاملة/);
  assert.match(doc, /\*\*المخزون رقم\*\*/);
  const readme = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', 'README.md'), 'utf8');
  assert.match(readme, /docs\/catalog-ingestion\.ar\.md/);
  assert.ok(fs.readdirSync(path.join(root, 'tools', 'catalog-trial', 'fixtures')).length >= 2, 'the pitfall fixtures are kept');
});

test('no trial script carries a machine path or a secret', () => {
  for (const f of fs.readdirSync(path.join(root, 'tools', 'catalog-trial')).filter((n) => /\.(py|md)$/.test(n))) {
    const text = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', f), 'utf8');
    assert.doesNotMatch(text, /\/tmp\/claude|\/root\/|service_role|eyJ[A-Za-z0-9_-]{20,}/, f + ' has a machine path or a key');
  }
});
