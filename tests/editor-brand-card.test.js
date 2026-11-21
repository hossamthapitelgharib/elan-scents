const test = require('node:test');
const assert = require('node:assert/strict');
const { designBrowser, plain, read } = require('./browser-fixture');

/* Owner, 2026-11-19: creating a brand card in the editor made a deformed block (a name with a gold line under it) under the brand strip, and the card itself reached the strip a long time later.
   A brand card is the brand's own card in the strip: no block is made, and the strip shows it at once, selected. (Stores, occasions and notes keep their block: nothing else shows them.) */

async function liveEditor() {
  const b = designBrowser();
  b.window.ElanHostBridge = { install(options) { b.options = options; return { dirty() {}, selection() {}, revision() {}, context() {}, menuClose() {} }; } };
  b.context.fetch = async (url) => {
    if (url === '/api/editor?action=state') return { ok: true, json: async () => ({ ok: true, design: { version: 1 }, revision: 'initial' }) };
    if (url === '/api/editor-session') return { ok: true };
    throw new Error('Unexpected network in editor test: ' + url);
  };
  b.run(read('edit-mode.js')); await b.options.getState();
  b.mode = b.window.ElanEditMode; b.document.elementsFromPoint = () => [];
  return b;
}
const strip = (brands) => '<section id="brands"><div class="strip">' + brands.map((n) => '<div class="card brandc" data-go="brand|' + n + '"><div class="bcap"><h4>' + n + '</h4></div></div>').join('') + '</div></section>';

test('catalog.show redraws the page with the catalog as it is now, selects the new brand card, and makes no block under the strip', async () => {
  const b = await liveEditor(), main = b.document.getElementById('main');
  main.innerHTML = strip(['ARMAF']);
  let loads = 0;
  b.window.DSIG = 'what the page last drew';
  b.window.loadData = async () => { loads++; assert.equal(b.window.DSIG, '', 'a refresh that brings nothing new would be skipped by the page: it is told to redraw'); main.innerHTML = strip(['ARMAF', 'LAVERNE']); };
  const got = await b.mode.execute('catalog.show', { brand: 'LAVERNE' });
  assert.equal(loads, 1);
  assert.ok(got.elementId, 'the card is an element of the editor');
  assert.equal(b.mode.state().selected.id, got.elementId, 'and it is the selected one');
  const blocks = (b.mode.state().design || {}).blocks || [];
  assert.deepEqual(plain(blocks), [], 'no block is made for a brand card');
});

test('a brand the page does not show yet is reported, not ignored; a missing name is refused', async () => {
  const b = await liveEditor();
  b.document.getElementById('main').innerHTML = strip(['ARMAF']);
  b.window.loadData = async () => {};
  await assert.rejects(b.mode.execute('catalog.show', { brand: 'NOWHERE' }), /ما ظهرش/);
  await assert.rejects(b.mode.execute('catalog.show', { brand: '  ' }), /اسم البراند/);
});

test('the create-brand panel creates the catalog record and shows its card in the strip (no section.create, no element.create), and has no shape field', () => {
  const src = read('editor/editor-live-create.js');
  const open = src.slice(src.indexOf('function openName('), src.indexOf('/* ---------- section and perfume-card panel'));
  assert.match(open, /kind !== 'brand' && ratios/, 'a brand card takes the shape of its own picture: the panel has no shape field for it');
  assert.match(open, /if \(kind === 'brand'\) return showInPage\('catalog\.show', \{ brand: String\(catalog\.record\.name\) \}\);/);
  assert.ok(open.indexOf("kind === 'brand'") < open.indexOf('return commit('), 'the brand path leaves before the block is committed');
  assert.match(src, /function showInPage\(action, payload\)[\s\S]*live\.request\(action, payload\)/);
  assert.match(read('elan-host-bridge.js'), /'element\.edit','catalog\.show'\]/, 'the page accepts the new action from the editor');
});

test('the saved home design no longer carries the blocks the brand panel used to leave under the brand strip', () => {
  const design = JSON.parse(read('design/home.json'));
  const order = design.order, after = order.slice(order.indexOf('brands') + 1);
  const smart = design.blocks.filter((x) => x.type === 'smart').map((x) => x.id);
  assert.deepEqual(after.filter((id) => smart.includes(id)), [], 'nothing of the brand panel sits between the brand strip and the next section');
});
