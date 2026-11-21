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

test('the constitution pins the owner\'s bundle rules of 2026-11-17: standalone pieces, the store\'s own words, comparison by content', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'catalog-ingestion.ar.md'), 'utf8');
  assert.match(doc, /\*\*الباقة قائمة بذاتها/, 'a bundle is separate from the single perfumes');
  assert.match(doc, /نصًا كما كتبها المتجر/, 'the pieces are the store\'s own text');
  assert.match(doc, /عطر مخفي أو محذوف أو غير مدرج لا يُخفي باقة/, 'a perfume never hides a bundle');
  assert.match(doc, /\*\*الباقة تظهر بكلام المتجر كاملًا/, 'the store\'s own title and full description');
  assert.match(doc, /المقارنة \*\*بالمحتوى وحده\*\*/, 'comparison by content only');
});

test('gen_bundles.py writes pieces as text and carries the store\'s own title and description', () => {
  const src = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', 'gen_bundles.py'), 'utf8');
  const code = src.replace(/#[^\n]*/g, '');
  // (the 11/11 Sale offer MESSAGES legitimately sit on perfume sizes; only the bundle pieces must never touch the catalog)
  assert.doesNotMatch(code, /public\.product_sizes|public\.products\b|bundle_items\([^)]*product_size_id/, 'the loader never looks a bundle piece up in the perfume catalog');
  assert.match(code, /insert into public\.bundle_items\(bundle_id,item_brand,item_name,size_ml,quantity\)/);
  assert.match(code, /on conflict \(bundle_id, private\.bundle_norm\(item_brand\), private\.bundle_norm\(item_name\), coalesce\(size_ml,0\)\)/);
  assert.match(code, /insert into public\.store_bundles\(store_id,bundle_id,title,description,/);
  assert.match(code, /page\['title'\]/, 'the title is the store\'s');
  assert.doesNotMatch(code, /insert into public\.bundles\([^)]*description/, 'the platform writes no bundle description');
});

test('gen_bundles.py: the second group of bundles is dry-run only until approved, availability is the store\'s, a capped text is never committed', () => {
  const src = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', 'gen_bundles.py'), 'utf8');
  const code = src.replace(/#[^\n]*/g, '');
  assert.match(code, /B2 = \[/, 'the second group is a separate list');
  assert.match(code, /if os\.environ\.get\('CATALOG_BUNDLES'\) == 'all':\s*\n\s*B = B \+ B2/, 'it joins the load only when asked for explicitly');
  assert.match(code, /'available': avail/, 'availability is read from the store page');
  assert.match(code, /case when \(b->>'available'\)::boolean then 10 else 0 end, \(b->>'available'\)::boolean/, 'a sold-out bundle is stored sold out (hidden by eligibility), never as available');
  assert.match(code, /assert not \(DESC_CAP and mode == 'commit'\)/, 'a shortened text is never written for real');
});

test('the html-to-text step keeps the store\'s words, line breaks and bullets and nothing else', { skip: hasPython ? false : 'python3 is not installed here' }, () => {
  const src = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', 'gen_bundles.py'), 'utf8');
  const start = src.indexOf('def text(h):');
  const end = src.indexOf('feed = {}');
  assert.ok(start > 0 && end > start, 'the converter is found');
  const html = '<p><strong>Top Notes:</strong><br data-start="1" data-end="2">• Blackcurrant<br data-start="3">• Green Tangerine</p>\n<ul><li>Vanilla</li><li>Musk &amp; Amber</li></ul><p>A&nbsp;B</p><script>x</script>';
  const prog = 'import html, re\n' + src.slice(start, end) + 'print(text(' + JSON.stringify(html) + '))\n';
  const r = spawnSync('python3', ['-I', '-c', prog], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Top Notes:\n• Blackcurrant\n• Green Tangerine\n\n• Vanilla\n• Musk & Amber\n\nA B\n', 'lines, bullets and entities survive');
});

test('no trial script carries a machine path or a secret', () => {
  for (const f of fs.readdirSync(path.join(root, 'tools', 'catalog-trial')).filter((n) => /\.(py|md)$/.test(n))) {
    const text = fs.readFileSync(path.join(root, 'tools', 'catalog-trial', f), 'utf8');
    assert.doesNotMatch(text, /\/tmp\/claude|\/root\/|service_role|eyJ[A-Za-z0-9_-]{20,}/, f + ' has a machine path or a key');
  }
});
