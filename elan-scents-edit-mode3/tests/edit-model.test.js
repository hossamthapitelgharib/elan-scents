const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const EM = require('../edit-model.js');

test('draft starts clean and every edit stays valid for the server schema', () => {
  const m = EM.create({});
  assert.equal(m.dirty(), false);
  assert.ok(m.move('offers', 1));
  assert.deepEqual(m.sequence().slice(0, 3), ['brands', 'new', 'offers']);
  const id = m.createText('brands', 'مرحبا');
  assert.equal(m.kind(id), 'text');
  m.resize(id, 'bigger'); m.setText(id, 'en', 'Hello'); m.setText('offers', 'ar', 'عروضنا'); m.format(id, { align: 'end' });
  assert.equal(m.dirty(), true);
  const n = ED.normalize(m.design(), { strict: true });
  assert.ok(n.ok, JSON.stringify(n.errors));
});

test('undo, redo, archive and restore keep the page recoverable', () => {
  const m = EM.create({});
  m.archive('stores');
  assert.ok(m.design().sections.stores.hidden);
  assert.ok(m.undo()); assert.equal(m.dirty(), false);
  assert.ok(m.redo()); assert.ok(m.restore('stores'));
  assert.equal(m.design().sections && m.design().sections.stores, undefined);
  const id = m.createText(); m.archive(id);
  assert.equal(m.kind(id), null);
  assert.ok(m.restore(id)); assert.equal(m.kind(id), 'text');
});

test('the model refuses edits the schema does not allow', () => {
  const m = EM.create({});
  assert.throws(() => m.format('brands', { size: 'sm' }));
  const id = m.createText();
  assert.throws(() => m.format(id, { size: 'huge' }));
  assert.throws(() => m.format(id, { align: 'left' }));
  assert.equal(m.dirty(), true);
});

test('banners and images only accept the allowed media host and safe links', () => {
  const ok = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/uploads/2026/a.png';
  const m = EM.create({});
  const b = m.createBanner('brands', { title: 'خصم' });
  m.setMedia(b, ok); m.setSubtitle(b, 'ar', 'لفترة محدودة'); m.setHref(b, '/#offers'); m.format(b, { background: '#112233', color: '#fff' });
  const i = m.createImage(b, ok);
  assert.ok(ED.normalize(m.design(), { strict: true }).ok);
  assert.throws(() => m.setHref(b, 'javascript:alert(1)'));
  assert.throws(() => m.format(b, { color: 'red' }));
  m.setMedia(b, 'https://evil.example/x.png');
  assert.equal(ED.normalize(m.design(), { strict: true }).ok, false);
  assert.equal(m.kind(i), 'image');
});

test('inner-page blocks stay on their page, keep top/bottom placement, and survive undo and archive', () => {
  const ok = 'https://sbgdtuqfrnfeggkwqtrw.supabase.co/storage/v1/object/public/site-media/u/a.png';
  const m = EM.create({});
  m.setPage('sec:brands');
  const a = m.createText(null, 'أول'), b = m.createBanner(a, { title: 'بانر' });
  m.setMedia(b, ok); m.setSlot(a, 'bottom');
  assert.deepEqual(m.sequence(), [b, a]);
  assert.equal(m.pageOf(a), 'sec:brands');
  m.setPage('home');
  assert.equal(m.sequence().length, 9);
  assert.deepEqual(Object.keys(m.design().pages), ['sec:brands']);
  assert.ok(ED.normalize(m.design(), { strict: true }).ok);
  m.setPage('sec:brands'); m.archive(b); assert.deepEqual(m.sequence(), [a]);
  assert.ok(m.restore(b)); assert.equal(m.sequence().length, 2);
  assert.throws(() => EM.create({}).setSlot('brands', 'bottom'));
});
