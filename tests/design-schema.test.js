const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ED = require('../design-schema.js');

const root = path.join(__dirname, '..');
const MEDIA = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/a1b2.webp';
const base = () => ({ version: 1, sections: {}, order: [], blocks: [], texts: {} });

test('the committed design file is valid and empty, so the page is unchanged', () => {
  const file = JSON.parse(fs.readFileSync(path.join(root, 'design', 'home.json'), 'utf8'));
  const n = ED.normalize(file, { strict: true });
  assert.equal(n.ok, true, n.errors.join('; '));
  assert.equal(ED.isEmpty(n.design), true);
});

test('an empty design produces an empty plan (zero DOM changes)', () => {
  const p = ED.plan(base(), ED.BUILTIN.slice(), 'ar');
  assert.deepEqual(p, { hide: [], titles: {}, blocks: [], order: [] });
});

test('strict mode rejects anything that is not a version-1 object', () => {
  for (const bad of [null, [], 'x', 5, { version: 2 }, {}]) {
    assert.equal(ED.normalize(bad, { strict: true }).ok, false);
  }
});

test('unknown sections, texts keys and ids are rejected in strict mode and dropped in lenient mode', () => {
  const d = base();
  d.sections.evil = { hidden: true };
  d.texts.ar = { magic: 'ok', cartTotal: 'x' };
  d.order = ['brands', 'nope'];
  assert.equal(ED.normalize(d, { strict: true }).ok, false);
  const lenient = ED.normalize(d, { strict: false });
  assert.equal(lenient.ok, true);
  assert.deepEqual(lenient.design.sections, {});
  assert.deepEqual(lenient.design.texts, { ar: { magic: 'ok' } });
  assert.deepEqual(lenient.design.order, ['brands']);
});

test('blocks only accept safe media URLs, links and colors', () => {
  const mk = (patch) => Object.assign(base(), { blocks: [Object.assign({ id: 'x-a', type: 'image', src: MEDIA }, patch)] });
  assert.equal(ED.normalize(mk({}), { strict: true }).ok, true);
  for (const src of ['javascript:alert(1)', 'http://evil.test/a.png', '//evil.test/a.png', '/assets/../secret', MEDIA + '"onerror="x', 'data:image/png;base64,AAAA']) {
    assert.equal(ED.normalize(mk({ src }), { strict: true }).ok, false, src);
  }
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', 'ftp://x']) {
    assert.equal(ED.normalize(mk({ href }), { strict: true }).ok, false, href);
  }
  assert.equal(ED.normalize(mk({ href: '/account.html' }), { strict: true }).ok, true);
  assert.equal(ED.normalize(mk({ style: { color: 'red;background:url(x)' } }), { strict: true }).ok, false);
  assert.equal(ED.normalize(mk({ style: { color: '#c9a45c' } }), { strict: true }).ok, true);
});

test('block ids are namespaced (x-...) and unique, so they can never collide with page elements', () => {
  const t = (id) => ({ id, type: 'text', text: { ar: 'مرحبا' } });
  assert.equal(ED.normalize(Object.assign(base(), { blocks: [t('main')] }), { strict: true }).ok, false);
  assert.equal(ED.normalize(Object.assign(base(), { blocks: [t('x-one'), t('x-one')] }), { strict: true }).ok, false);
  assert.equal(ED.normalize(Object.assign(base(), { blocks: [t('x-one'), t('x-two')] }), { strict: true }).ok, true);
});

test('text is plain text only: control characters are stripped and length is capped', () => {
  const d = Object.assign(base(), { blocks: [{ id: 'x-t', type: 'text', text: { ar: '\u0000a\u0007b' + 'z'.repeat(5000) } }] });
  const n = ED.normalize(d, { strict: true });
  assert.equal(n.ok, true);
  assert.equal(n.design.blocks[0].text.ar.startsWith('ab'), true);
  assert.equal(n.design.blocks[0].text.ar.length <= ED.LIMITS.text, true);
});

test('plan: hide, retitle, add blocks and reorder', () => {
  const d = base();
  d.sections.offers = { hidden: true };
  d.sections.brands = { title: { ar: 'ماركات مختارة', en: 'Selected brands' } };
  d.blocks = [{ id: 'x-promo', type: 'text', text: { ar: 'عرض' } }];
  d.order = ['x-promo', 'stores', 'brands'];
  const present = ED.BUILTIN.slice();
  const ar = ED.plan(d, present, 'ar');
  assert.deepEqual(ar.hide, ['offers']);
  assert.equal(ar.titles.brands, 'ماركات مختارة');
  assert.equal(ED.plan(d, present, 'en').titles.brands, 'Selected brands');
  assert.deepEqual(ar.order.slice(0, 3), ['x-promo', 'stores', 'brands']);
  assert.equal(ar.order.length, present.length + 1);
  assert.equal(new Set(ar.order).size, ar.order.length);
});

test('plan ignores sections that are not on the page', () => {
  const d = base();
  d.sections.soon = { hidden: true };
  assert.deepEqual(ED.plan(d, ['brands'], 'ar').hide, []);
});

test('serialize refuses invalid or oversized designs and is canonical', () => {
  assert.throws(() => ED.serialize({ version: 1, sections: { nope: {} } }));
  assert.throws(() => ED.serialize(null));
  const big = base();
  big.blocks = Array.from({ length: ED.LIMITS.blocks }, (_, i) => ({ id: 'x-b' + i, type: 'text', text: { ar: 'م'.repeat(ED.LIMITS.text), en: 'm'.repeat(ED.LIMITS.text) } }));
  // A maximal valid design must fit under the real limit...
  assert.doesNotThrow(() => ED.serialize(big));
  // ...and the guard must still refuse anything over it.
  const saved = ED.LIMITS.bytes;
  ED.LIMITS.bytes = 1000;
  try { assert.throws(() => ED.serialize(big), /too large/); } finally { ED.LIMITS.bytes = saved; }
  const text = ED.serialize(base());
  assert.equal(text, ED.serialize(JSON.parse(text)));
  assert.equal(text.endsWith('\n'), true);
});

test('applyTexts only touches whitelisted keys', () => {
  const texts = { ar: { magic: 'old', cart: 'سلة' }, en: { magic: 'old' } };
  const d = ED.normalize({ version: 1, texts: { ar: { magic: 'جديد' } } }).design;
  assert.equal(ED.applyTexts(texts, d), 1);
  assert.equal(texts.ar.magic, 'جديد');
  assert.equal(texts.ar.cart, 'سلة');
  assert.equal(texts.en.magic, 'old');
});

test('the storefront loads the design layer after the core and keeps the cache-busting version', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const v = html.match(/\/app\.js\?v=([\w-]+)/)[1];
  assert.match(html, new RegExp('/design-schema\\.js\\?v=' + v));
  assert.match(html, new RegExp('/design-layer\\.js\\?v=' + v));
  assert.ok(html.indexOf('/design-layer.js') > html.indexOf('/design-schema.js'));
  assert.ok(html.indexOf('/design-schema.js') > html.indexOf('/app.js'));
});

test('design files are served without caching', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const noStore = (src) => cfg.headers.some((h) => h.source === src && h.headers.some((x) => /no-store/.test(x.value)));
  assert.ok(noStore('/design/(.*)'));
  assert.ok(cfg.headers.some((h) => /design-layer\.js/.test(h.source) && /design-schema\.js/.test(h.source)));
});
