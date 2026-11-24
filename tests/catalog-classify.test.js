'use strict';
/* The automatic offer / bundle rule (lib/catalog-classify.js) pins the owner's definitions of 17 and 23 Nov 2026.
   The texts below are short, invented lines in the style of real store pages (no customer data, no keys). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProduct: classify, htmlToText, contentsList } = require('../lib/catalog-classify.js');

const sec = (title, handle) => ({ title, handle: handle || title.toLowerCase().replace(/\s+/g, '-') });
const offers = (sections, extra = {}) => classify({ title: 'Plain Perfume', description: 'Eau de Parfum 100 ML', sections, ...extra }).offers;

test('offer: only the merchant\'s own words in a section name make an offer', () => {
  for (const name of ['INSANE DEALS', 'White Friday Sale', 'Black Friday', 'Eid Special Offer', 'عروض رمضان', 'Summer Offers', '11/11 Sale', 'Halloween Sale', 'Weekend Deal'])
    assert.deepEqual(offers([sec(name)]), [name], name);
  // not offers: ordinary sections, and words that merely contain an offer word
  for (const name of ['Best Sellers', 'New Arrivals', 'Wholesale', 'Reid Collection', 'Sunset', 'For Him', 'Lattafa'])
    assert.deepEqual(offers([sec(name)]), [], name);
});

test('offer: the owner\'s occasion words Eid, Ramadan and Christmas count too (23 Nov 2026)', () => {
  for (const name of ['Eid', 'Eid Collection', 'Ramadan', 'Ramadhan Specials', 'Christmas Gifts', 'عيد الأضحى', 'رمضان', 'كريسماس'])
    assert.deepEqual(offers([sec(name)]), [name], name);
});

test('offer: a product shows EVERY offer section it is in, as the merchant wrote them, once each', () => {
  const r = offers([sec('White Friday Sale'), sec('Halloween Sale'), sec('Best Sellers'), sec('White Friday Sale')]);
  assert.deepEqual(r, ['White Friday Sale', 'Halloween Sale']);
});

test('offer: the section handle counts when the title does not say it, and a label (tag) counts like a section', () => {
  assert.deepEqual(offers([{ title: 'Specials', handle: 'white-friday-sale' }]), ['Specials']);
  assert.deepEqual(offers([], { tags: ['best', 'Ramadan Offer'] }), ['Ramadan Offer']);
  assert.deepEqual(offers([], { tags: ['best', 'new'] }), []);
});

test('offer: a single perfume in an offer section stays a plain perfume (the message is only a label; price rules and filters are the platform\'s)', () => {
  const r = classify({ title: 'MARWA EXTRAIT', description: 'MARWA EXTRAIT – Extrait de Parfum – 60 ML – Unisex', sections: [sec('INSANE DEALS')] });
  assert.deepEqual(r.offers, ['INSANE DEALS']);
  assert.equal(r.bundle, 'no');
  assert.deepEqual(r.pieces, []);
});

test('offer: no price word exists; a crossed-out price or a percentage never matters', () => {
  const r = classify({ title: 'Perfume 100 ML', description: 'Was 3000 now 2000, 33% off', sections: [], tags: [] });
  assert.deepEqual(r.offers, []);
  assert.equal(r.bundle, 'no');
});

const head = (name, type, size) => `${name} – ${type} – ${size}\nBy Brand\n━━━━━━━━━━\nDESCRIPTION\nNice.`;

test('bundle: the merchant\'s own word (bundle / set / gift / باقة) in the title is sure', () => {
  for (const title of ['THE ALPHA BUNDLE', 'NEBRAS GIFT SET', 'PRINCESS REEF BOX SET', 'ANGHAM DUO BUNDLE', 'باقة الصيف', 'Genesis Perfume Set'])
    assert.equal(classify({ title, description: 'Eau De Parfum 100 ML', sections: [] }).bundle, 'yes', title);
});

test('bundle: the first description line says it (Gift Set, Bundle) even when the title does not', () => {
  const r = classify({ title: 'THE ARROGATE COLLECTION', description: head('ARROGATE COLLECTION', 'Perfume Gift Set', '75 ML'), sections: [] });
  assert.equal(r.bundle, 'yes');
});

test('bundle: a quantity or a "+" between sizes is sure when a perfume bottle is there (bottle + body care counts)', () => {
  assert.equal(classify({ title: 'CRAZY MUSK COLLECTION', description: head('CRAZY MUSK', 'Eau De Parfum', '3 × 100 ML + 75 G Powder'), sections: [] }).bundle, 'yes');
  const r = classify({ title: 'OUDI + DEODRANT', description: head('OUDI', 'Eau De Parfum 100 ML + Deodorant Spray 50 ML', 'Men'), sections: [] });
  assert.equal(r.bundle, 'yes');
  assert.ok(r.reasons.some((x) => /\+/.test(x)));
});

test('bundle: a bottle described by its notes and a "SIZE : 100 ML" line is a bottle even with no word perfume (store style: Top / Heart / Base)', () => {
  const r = classify({ title: 'PURE OUDI + DEODRANT', description: 'Notes:\nTop: Oud\nHeart: Jasmine\nBase: Amber\nSIZE : 100 ML', sections: [] });
  assert.equal(r.bundle, 'yes');
});

test('bundle: the merchant\'s contents list with two or more lines is sure, and its lines are kept exactly as written', () => {
  const html = '<p>THE LARGE GARDEN – Miniature Perfume Collection – 225 ML</p><p>Set Includes:</p><ul><li><p>Rose Garden – 25 ML</p></li><li><p>Lily Garden – 25 ML</p></li><li><p>Jasmine Garden – 25 ML</p></li></ul><p>Details</p>';
  const r = classify({ title: 'THE LARGE GARDEN', description: html, sections: [] });
  assert.equal(r.bundle, 'yes');
  assert.deepEqual(r.pieces, ['Rose Garden – 25 ML', 'Lily Garden – 25 ML', 'Jasmine Garden – 25 ML']);
});

test('bundle: contents list survives blank lines between items and stops at a ruler or a heading', () => {
  const t = 'The collection includes:\n\n• Mexican Tobacco\n\n• Jamaican Tobacco\n━━━━━━━━\n• not part of it';
  assert.deepEqual(contentsList(t), ['Mexican Tobacco', 'Jamaican Tobacco']);
});

test('bundle: the merchant\'s own bundle section with a bundle word is sure; a gift-set section alone proves nothing', () => {
  const inBundles = classify({ title: 'Zeina\'s Bloom', description: 'MOHRA by LATTAFA\nTop: Rose\nSIZE : 100 ML', sections: [sec('BUNDLES')] });
  assert.equal(inBundles.bundle, 'yes');
  const lone = classify({ title: 'AFNAN 9AM DIVE Perfume SPRAY 250 ML', description: 'A vibrant unisex fragrance.', sections: [sec('GIFT SETS')] });
  assert.equal(lone.bundle, 'review', 'a lone spray in a Gift Sets section waits for the owner');
  assert.ok(/only the merchant's section/.test(lone.reasons[0]));
});

test('bundle: the perfume bottle is the hero - a box of oils alone, or of incense, is NOT a bundle (owner 23 Nov 2026)', () => {
  const oils = classify({ title: 'IBRAQ MUSK OIL SET 5 PCS', description: 'Pure Musk Oil Set – 5 Pieces\nSet Includes:\nPowder Musk – soft\nSpecial Musk – classic\nType: Pure Musk Oil', sections: [] });
  assert.equal(oils.bundle, 'no');
  assert.ok(/oils only/.test(oils.reasons[0]));
  const box = classify({ title: 'MUSK OIL BOX 4 PCS by IBRAQ', description: head('MUSK OIL COLLECTION', '4 × 6 ML', 'Unisex'), sections: [] });
  assert.equal(box.bundle, 'no');
});

test('bundle: musk oil + a perfume sample IS a bundle (a perfume sample with something else)', () => {
  const r = classify({ title: 'SPECIAL MUSK OIL + PERFUME SAMPLE', description: head('SPECIAL MUSK', 'Perfume Oil & Eau De Parfum Sample Set', 'Half Tola + 10 ML'), sections: [] });
  assert.equal(r.bundle, 'yes');
});

test('bundle: a box with no bottle named and no oil named waits for the owner (not silently dropped, not published)', () => {
  const r = classify({ title: 'EID MUSK SET', description: 'A curated bundle of 12 musks.\nMusk Box (20 mL):\nSpecial Musk\nMusk Powder', sections: [] });
  assert.equal(r.bundle, 'review');
});

test('bundle: "Collection" alone is a doubt, never sure, when nothing says how many bottles there are', () => {
  for (const title of ['COFFEE COLLECTION MOCHA', 'THE ROYAL COLLECTION'])
    assert.equal(classify({ title, description: 'A fine scent for every day.', sections: [] }).bundle, 'review', title);
});

test('bundle: "Collection" is only a perfume line when the merchant itself describes ONE bottle (description or its one variant)', () => {
  const mocha = classify({ title: 'COFFEE COLLECTION MOCHA', description: 'MOCHA – Eau De Parfum – 100 ML – Unisex\nBy Fragrance World', sections: [] });
  assert.equal(mocha.bundle, 'no');
  assert.ok(/one bottle \(100 ML\)/.test(mocha.notes[0]));
  const mallow = classify({ title: 'Mallow Madness', description: 'MALLOW MADNESS – LATTAFA (Give Me Gourmand Collection)\nEau de Parfum – 75 ML – Unisex', sections: [] });
  assert.equal(mallow.bundle, 'no');
  const afnan = classify({ title: 'SUPREMACY GALA - LUXURY COLLECTION', description: 'A rich floral.', variants: [{ title: 'Eau De Parfum / 90 ML / Pour Femme' }], sections: [] });
  assert.equal(afnan.bundle, 'no');
  // two different bottle sizes stated, or a "+", is not one bottle
  assert.equal(classify({ title: 'DUO COLLECTION X', description: 'Eau De Parfum – 100 ML\nEau De Parfum – 30 ML', sections: [] }).bundle, 'yes');
});

test('bundle: "Collection" plus the merchant counting the bottles in its description is sure', () => {
  const r = classify({ title: 'IRTH COLLECTION', description: 'Three fragrances weave a timeless journey. Main Perfumes (100 mL).', sections: [] });
  assert.equal(r.bundle, 'yes');
});

test('bundle: a plain single perfume is not a bundle, and "Hair & Body Mist" or "One & Only" is not a plus', () => {
  for (const [title, d] of [['COTTON ROUGE', 'COTTON ROUGE – Eau De Parfum – 100 ML – Women'], ['ONE & ONLY 200ML', 'ONE & ONLY – BY GISSAH\nEau de Parfum – 200 ML'], ['VONTANA', 'VONTANA – Hair & Body Mist – 75 ML'], ['Sunset Rose', 'Sunset Rose – Eau de Parfum – 50 ML']])
    assert.equal(classify({ title, description: d, sections: [] }).bundle, 'no', title);
});

test('bundle: the same rule gives the same answer for every store (a product with the same text and sections)', () => {
  const p = { title: 'X GIFT SET', description: 'Eau De Parfum 100 ML', sections: [sec('Gift Sets')] };
  assert.deepEqual(classify(p), classify({ ...p }));
});

test('htmlToText keeps the merchant\'s words and line breaks and drops markup, scripts and entities', () => {
  assert.equal(htmlToText('<script>alert(1)</script><p>A&amp;B&nbsp;C</p><ul><li>one</li><li>two</li></ul>'), 'A&B C\n\n• one\n• two');
  assert.equal(htmlToText(null), '');
});

test('inputs from a store are never trusted: odd shapes do not throw', () => {
  assert.doesNotThrow(() => classify({}));
  assert.doesNotThrow(() => classify(null));
  assert.doesNotThrow(() => classify({ title: 5, description: 7, sections: [null, 3, {}], tags: [null, 4] }));
  assert.deepEqual(classify({}).offers, []);
});

test('bundle: a description that gives a size to two or more bottles is sure (perfume 100 ml + hair perfume 50 ml; three princesses of 100 ml)', () => {
  const one = classify({ title: 'The One Collection', description: 'It comes with a special hair perfume.\nFragrance type: For her\nPerfume size: 100 ml\nHair perfume size: 50 ml', sections: [] });
  assert.equal(one.bundle, 'yes');
  const three = classify({ title: 'VICTORIAN COLLECTION', description: 'Juliet\nSize: 100 ml\nFragrance type: Women\nCharlotte\nSize: 100 ml\nElizabeth\nSize: 100 ml', sections: [] });
  assert.equal(three.bundle, 'yes');
  // one size line is one bottle
  assert.equal(classify({ title: 'COFFEE COLLECTION MOCHA', description: 'Eau De Parfum\nSIZE : 100 ML', sections: [] }).bundle, 'review');
});
