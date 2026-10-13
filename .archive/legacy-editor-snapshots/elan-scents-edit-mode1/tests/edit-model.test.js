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
