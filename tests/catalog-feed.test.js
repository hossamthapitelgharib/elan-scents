'use strict';
// The bridge between the automatic rule (lib/catalog-classify.js) and the ONE entry point public.catalog_receive_items (lib/catalog-feed.js).
// No database here: what the entry point DOES with these items is proved on the real database by tests/catalog-rule-link.test.sql.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyProduct } = require('../lib/catalog-classify.js');
const { finalKind, perfumeOffers, bundleItem, chunk } = require('../lib/catalog-feed.js');

const variant = (price, available = true, title = 'Default Title') => ({ title, price: String(price), available });

test('finalKind: the rule\'s answer decides when the owner has said nothing', () => {
  assert.equal(finalKind({ bundle: 'yes' }), 'bundle');
  assert.equal(finalKind({ bundle: 'review' }), 'doubtful');
  assert.equal(finalKind({ bundle: 'no' }), 'plain');
  assert.equal(finalKind(undefined), 'plain');
});

test('finalKind: the owner\'s answer wins over the rule, both ways', () => {
  assert.equal(finalKind({ bundle: 'review' }, 'bundle'), 'bundle');     // EID MUSK SET (24 Nov)
  assert.equal(finalKind({ bundle: 'review' }, 'not_bundle'), 'plain');
  assert.equal(finalKind({ bundle: 'yes' }, 'not_bundle'), 'plain');
  assert.equal(finalKind({ bundle: 'no' }, 'bundle'), 'bundle');
  assert.equal(finalKind({ bundle: 'yes' }, undefined), 'bundle');
  assert.equal(finalKind({ bundle: 'yes' }, null), 'bundle');
});

test('perfumeOffers: the merchant\'s offer sections of a plain perfume, as a copy', () => {
  const c = { offers: ['INSANE DEALS', 'Black Friday'] };
  const o = perfumeOffers(c);
  assert.deepEqual(o, ['INSANE DEALS', 'Black Friday']);
  o.push('x');
  assert.deepEqual(c.offers, ['INSANE DEALS', 'Black Friday']);
  assert.deepEqual(perfumeOffers({}), []);
  assert.deepEqual(perfumeOffers(null), []);
});

test('bundleItem: a sure bundle carries the merchant\'s title, FULL text, contents lines, price, availability and offer sections', () => {
  const product = {
    handle: 'vintage-tobacco-box', title: '  VINTAGE TOBACCO Box ',
    body_html: '<p>Set includes:</p><ul><li>Pure Oudi Eau de Parfum 100 ML</li><li>Deodorant 150 ML</li></ul><p>The box says "عود &amp; مسك".</p>',
    variants: [variant(3500)],
  };
  const classification = classifyProduct({ title: product.title, description: product.body_html, sections: [{ title: 'Black Friday', handle: 'black-friday' }] });
  assert.equal(classification.bundle, 'yes');
  const item = bundleItem({ product, classification, base: 'https://shop.example/products/' });
  assert.equal(item.kind, 'bundle');
  assert.equal(item.source_key, 'vintage-tobacco-box');
  assert.equal(item.title, 'VINTAGE TOBACCO Box');
  assert.match(item.description, /Set includes:/);
  assert.match(item.description, /• Pure Oudi Eau de Parfum 100 ML/);
  assert.match(item.description, /عود & مسك/);
  assert.doesNotMatch(item.description, /<|&amp;/);
  assert.equal(item.price, 3500);
  assert.equal(item.available, true);
  assert.equal(item.stock_quantity, 10);
  assert.equal(item.bundle, 'yes');
  assert.deepEqual(item.offers, ['Black Friday']);
  assert.deepEqual(item.pieces, ['Pure Oudi Eau de Parfum 100 ML', 'Deodorant 150 ML']);
  assert.ok(item.reasons.length >= 1);
  assert.equal(item.product_url, 'https://shop.example/products/vintage-tobacco-box');
});

test('bundleItem: a doubtful product travels as review, with the rule\'s reasons, so the owner can judge it in one look', () => {
  const product = { handle: 'eid-musk-set', title: 'EID MUSK SET', body_html: '12 musks<br>20 ML each', variants: [variant(5450)] };
  const classification = { bundle: 'review', offers: [], reasons: ['it looks like a box but no perfume bottle is named in it (oils? incense?)'], pieces: [] };
  const item = bundleItem({ product, classification });
  assert.equal(item.bundle, 'review');
  assert.deepEqual(item.reasons, classification.reasons);
  assert.equal(item.price, 5450);
  assert.equal('product_url' in item, false, 'no link when the caller gave no base');
});

test('bundleItem: the price is the lowest of the variants that can be bought; sold out is shown as sold out, never guessed in stock', () => {
  const base = { handle: 'h', title: 'T Set', body_html: '' };
  const sure = { bundle: 'yes', offers: [], reasons: ['x'], pieces: [] };
  assert.equal(bundleItem({ product: { ...base, variants: [variant(900, false), variant(1200), variant(1000)] }, classification: sure }).price, 1000);
  const out = bundleItem({ product: { ...base, variants: [variant(900, false), variant(1200, false)] }, classification: sure });
  assert.equal(out.price, 900);
  assert.equal(out.available, false);
  assert.equal(out.stock_quantity, 0);
});

test('bundleItem: a linked store passes its real stock number; the trial placeholder is only the default', () => {
  const product = { handle: 'h', title: 'T Set', body_html: '', variants: [variant(10)] };
  const item = bundleItem({ product, classification: { bundle: 'yes' }, stock: (p, v) => 7 });
  assert.equal(item.stock_quantity, 7);
});

test('bundleItem: nothing is guessed - no handle or no usable price gives null', () => {
  const sure = { bundle: 'yes' };
  assert.equal(bundleItem({ product: { title: 'x', variants: [variant(10)] }, classification: sure }), null);
  assert.equal(bundleItem({ product: { handle: 'h', title: 'x', variants: [] }, classification: sure }), null);
  assert.equal(bundleItem({ product: { handle: 'h', title: 'x', variants: [variant(0)] }, classification: sure }), null);
  assert.equal(bundleItem({ product: { handle: 'h', title: 'x', variants: [variant('free')] }, classification: sure }), null);
  assert.equal(bundleItem({ product: null, classification: sure }), null);
  assert.equal(bundleItem(), null);
});

test('chunk: at most the entry point\'s limit per call', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.equal(chunk(new Array(1200).fill(0)).length, 3);
  assert.ok(chunk(new Array(1200).fill(0)).every((c) => c.length <= 500));
});

test('every field the bridge sends is one the entry point reads (the migration names them)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261125122045_catalog_rule_link.sql'), 'utf8');
  const bundleFn = sql.slice(sql.indexOf('function private.catalog_bundle_problem'), sql.indexOf('function private.catalog_receive_bundle'));
  const item = bundleItem({ product: { handle: 'h', title: 'T Set', body_html: 'x', variants: [variant(10)] }, classification: { bundle: 'yes', offers: ['a'], reasons: ['r'], pieces: ['p'] }, base: 'https://a.example/' });
  for (const key of Object.keys(item)) {
    if (key === 'kind') assert.match(sql, /v_kind = 'bundle'/);
    else assert.match(bundleFn + sql, new RegExp(`'${key}'`), `the entry point reads ${key}`);
  }
});
