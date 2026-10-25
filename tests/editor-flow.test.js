const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../editor/editor-geometry.js');
const ED = require('../design-schema.js');
const { designBrowser } = require('./browser-fixture');

const root = path.resolve(__dirname, '..');
const card = (id, left, top, width = 300, height = 240) => ({ id, left, top, width, height });

/* The original editor (reflowAt): the nearest centre wins; the dragged element goes after it when the pointer is in the
   lower quarter of the target or, on the target's own row, on its far side. */
test('dropSlot picks the nearest sibling and the side the pointer is on (left-to-right row)', () => {
  const row = [card('a', 40, 340), card('b', 364, 340), card('c', 688, 340)];
  assert.deepEqual(G.dropSlot(row, { x: 380, y: 400 }), { id: 'b', after: false });
  assert.deepEqual(G.dropSlot(row, { x: 600, y: 400 }), { id: 'b', after: true });
  assert.deepEqual(G.dropSlot(row, { x: 700, y: 330 }), { id: 'c', after: false }, 'above the target row: before it');
  assert.deepEqual(G.dropSlot(row, { x: 700, y: 330 + 240 }), { id: 'c', after: true }, 'below the target: after it');
  assert.deepEqual(G.dropSlot(row, { x: 60, y: 340 + 240 * 0.76 }), { id: 'a', after: true }, 'lower quarter always means after');
});

test('dropSlot flips the far side in a right-to-left row, where the next card sits on the left', () => {
  const row = [card('a', 1000, 100), card('b', 676, 100), card('c', 352, 100)];
  assert.deepEqual(G.dropSlot(row, { x: 700, y: 200 }, { rtl: true }), { id: 'b', after: true }, 'left half of b: it comes after b');
  assert.deepEqual(G.dropSlot(row, { x: 960, y: 200 }, { rtl: true }), { id: 'b', after: false }, 'right half of b: before it');
});

test('dropSlot on a vertical stack of sections decides by the middle line', () => {
  const stack = [card('s1', 0, 0, 1000, 200), card('s2', 0, 200, 1000, 300), card('s3', 0, 500, 1000, 100)];
  assert.deepEqual(G.dropSlot(stack, { x: 900, y: 260 }, { axis: 'y' }), { id: 's2', after: false });
  assert.deepEqual(G.dropSlot(stack, { x: 10, y: 400 }, { axis: 'y' }), { id: 's2', after: true });
  assert.deepEqual(G.dropSlot(stack, { x: 10, y: 590 }, { axis: 'y' }), { id: 's3', after: true });
});

test('dropSlot has nothing to say without siblings or with boxes that are not on the page', () => {
  assert.equal(G.dropSlot([], { x: 1, y: 1 }), null);
  assert.equal(G.dropSlot([card('hidden', 0, 0, 0, 0)], { x: 1, y: 1 }), null);
  assert.equal(G.dropSlot(null, { x: 1, y: 1 }), null);
});

test('reorder moves one id before or after another and never touches its input', () => {
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(G.reorder(ids, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  assert.deepEqual(G.reorder(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(G.reorder(ids, 'b', 'c', false), ['a', 'b', 'c', 'd'], 'dropping where it already is changes nothing');
  assert.deepEqual(G.reorder(ids, 'x', 'a', true), ids, 'an unknown id leaves the list alone');
  assert.deepEqual(G.reorder(ids, 'a', 'x', true), ids, 'an unknown target leaves the list alone');
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('the design schema keeps and validates the saved card order', () => {
  const ok = ED.normalize({ version: 1, cardOrder: { notes: ['card:b', 'card:a', 'card:c'], cats: ['card:z'] } }, { strict: true });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.deepEqual(ok.design.cardOrder, { notes: ['card:b', 'card:a', 'card:c'] }, 'a one-card list says nothing and is dropped');
  assert.equal(ED.isEmpty(ok.design), false);
  assert.equal(ED.isEmpty(ED.normalize({ version: 1, cardOrder: { notes: ['card:a'] } }).design), true);

  const page = ED.normalize({ version: 1, pages: { 'sec:brands': { blocks: [], cardOrder: { view: ['pcard:b', 'pcard:a'] } } } }, { strict: true });
  assert.ok(page.ok, JSON.stringify(page.errors));
  assert.deepEqual(page.design.pages['sec:brands'].cardOrder, { view: ['pcard:b', 'pcard:a'] });

  const text = ED.serialize({ version: 1, cardOrder: { occ: ['card:2', 'card:1'] } });
  assert.deepEqual(JSON.parse(text).cardOrder, { occ: ['card:2', 'card:1'] });
});

test('the server refuses a card order that is not a plain list of element ids', () => {
  const bad = (cardOrder) => ED.normalize({ version: 1, cardOrder }, { strict: true });
  assert.equal(bad({ notes: ['card:a', 'card:a'] }).ok, false, 'duplicate ids');
  assert.equal(bad({ notes: ['card:a', '<script>'] }).ok, false, 'an id that could never be an element');
  assert.equal(bad({ 'Not A Container': ['a', 'b'] }).ok, false, 'container names are plain words');
  assert.equal(bad({ notes: 'card:a' }).ok, false, 'must be a list');
  assert.equal(bad([]).ok, false, 'must be an object');
  const many = Array.from({ length: 101 }, (_, i) => 'card:' + i);
  assert.equal(bad({ notes: many }).ok, false, 'at most 100 cards in one container');
  // the storefront never breaks on it: lenient mode skips what is wrong
  const lenient = ED.normalize({ version: 1, cardOrder: { notes: ['card:a', '<x>', 'card:b'] } });
  assert.deepEqual(lenient.design.cardOrder, { notes: ['card:a', 'card:b'] });
});

test('the editor uses the tested flow functions, saves the order, and keeps Alt for free placement', () => {
  const editMode = fs.readFileSync(path.join(root, 'edit-mode.js'), 'utf8');
  const layer = fs.readFileSync(path.join(root, 'design-layer.js'), 'utf8');
  assert.match(editMode, /Geometry\.dropSlot\(rects/);
  assert.match(editMode, /Geometry\.reorder\(order, moved, target, slot\.after\)/);
  assert.match(editMode, /Geometry\.reorder\(listed, g\.id, slot\.id, slot\.after\)/);
  assert.match(editMode, /!ev\.altKey/);
  assert.match(editMode, /scope\.cardOrder\[key\] = next/);
  assert.match(layer, /function applyCardOrder\(\)/);
  assert.ok(layer.indexOf('applyCardOrder(); // the cards') < layer.indexOf('applyEdits(); // free-form'), 'order first, then the free offsets');
  assert.match(layer, /applyPage\(\); applyCardOrder\(\); applyEdits\(\)/, 'inner pages too');
});

function notesPage(b) {
  const main = b.document.getElementById('main');
  main.innerHTML = '<section id="notes"><h3>نوتات</h3><div class="strip">' +
    ['a', 'b', 'c', 'd'].map((n, i) => '<div class="card" data-go="col|notes|' + i + '"><h4>' + n + '</h4></div>').join('') + '</div></section>';
  return b.layer.elements().filter((e) => e.kind === 'card');
}
const names = (b) => b.document.getElementById('main').querySelectorAll('.card').map((c) => c.querySelector('h4').textContent).join('');

test('the storefront puts the saved cards in the saved order', () => {
  const b = designBrowser();
  const cards = notesPage(b);
  assert.equal(names(b), 'abcd');
  const id = (n) => cards[n.charCodeAt(0) - 97].id;
  b.layer.set({ version: 1, cardOrder: { notes: [id('c'), id('a'), id('d'), id('b')] } });
  assert.equal(names(b), 'cadb');
  assert.deepEqual(b.layer.elements().filter((e) => e.kind === 'card').map((e) => e.id).sort(), cards.map((c) => c.id).sort(), 'ids do not change when cards move');
  b.layer.set({ version: 1, cardOrder: { notes: [id('c'), id('a'), id('d'), id('b')] } });
  assert.equal(names(b), 'cadb', 'applying twice changes nothing more');
});

test('a card the saved order does not know keeps its natural place after the listed ones', () => {
  const b = designBrowser();
  const cards = notesPage(b);
  b.layer.set({ version: 1, cardOrder: { notes: [cards[2].id, cards[0].id] } });
  assert.equal(names(b), 'cabd');
});

test('other things between the cards stay where they are when the cards swap places', () => {
  const b = designBrowser();
  const main = b.document.getElementById('main');
  main.innerHTML = '<section id="occ"><div class="strip"><div class="card" data-go="col|occ|0"><h4>a</h4></div><i class="gap"></i><div class="card" data-go="col|occ|1"><h4>b</h4></div></div></section>';
  const cards = b.layer.elements().filter((e) => e.kind === 'card');
  b.layer.set({ version: 1, cardOrder: { occ: [cards[1].id, cards[0].id] } });
  const strip = main.querySelector('.strip');
  assert.deepEqual(strip.children.filter((c) => c.tagName !== '#COMMENT').map((c) => c.tagName === 'I' ? 'gap' : c.querySelector('h4').textContent), ['b', 'gap', 'a']);
});
