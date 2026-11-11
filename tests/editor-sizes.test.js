const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const G = require('../editor/editor-geometry.js');
const { designBrowser, plain, read } = require('./browser-fixture');

/* Dimensions of elements, in relative terms only (owner, 2026-11-10: he does not read pixel sizes): a list of common shapes (1:1, 4:3, 9:16, 16:9…, examples and not a closed list)
   to choose from, before creating an element or for a chosen one. A chosen shape needs a width: an existing element keeps its own, a new one takes the room it has (up to 480). */

async function sizedEditor() {
  const b = designBrowser(); let bridge;
  b.window.ElanEditorGeometry = G;   // the page loads editor-geometry.js before edit-mode.js (edit-boot.js)
  b.window.ElanHostBridge = { install(options) { bridge = options; return { dirty() {}, selection() {}, context() {}, revision() {} }; } };
  b.context.fetch = async (url) => {
    if (url === '/api/editor?action=state') return { ok: true, json: async () => ({ ok: true, design: { version: 1 }, revision: 'initial' }) };
    if (url === '/api/editor-session') return { ok: true };
    throw new Error('Unexpected network in editor test: ' + url);
  };
  b.run(read('edit-mode.js')); await bridge.getState(); b.mode = b.window.ElanEditMode; b.tools = b.window.ElanEditTools; return b;
}
const editOf = (b, id) => { const e = plain(b.mode.state().design).edits || {}, dev = b.mode.state().device; return (e[dev] || {})[id] || {}; };

test('the common shapes include the ones the owner named, each with a name, and none is listed twice', () => {
  const names = G.RATIOS.map((r) => r.w + ':' + r.h);
  ['1:1', '4:3', '9:16', '16:9', '3:2', '4:5'].forEach((n) => assert.ok(names.includes(n), n + ' is there'));
  assert.equal(new Set(names).size, names.length, 'listed once');
  G.RATIOS.forEach((r) => assert.ok(Number.isInteger(r.w) && Number.isInteger(r.h) && r.w >= 1 && r.h >= 1 && r.label, 'whole numbers and a name: ' + r.w + ':' + r.h));
  assert.ok(G.RATIOS.length >= 10, 'a good list of examples');
  assert.equal(G.SIZE_GROUPS, undefined, 'no pixel sizes any more');
});

test('a shape takes a width and gives the size; a size is recognised as a shape when it is one', () => {
  assert.deepEqual(G.sizeFromRatio(16, 9, 390), { w: 390, h: 219 });
  assert.deepEqual(G.sizeFromRatio(9, 16, 360), { w: 360, h: 640 });
  assert.deepEqual(G.sizeFromRatio(1, 1, 300), { w: 300, h: 300 });
  assert.equal(G.sizeFromRatio(16, 9, 0), null, 'no width: nothing to make');
  assert.equal(G.sizeFromRatio(0, 9, 300), null);
  const tall = G.sizeFromRatio(1, 3, 3000); assert.ok(tall.h <= G.MAX_SIZE && Math.abs(tall.h / tall.w - 3) < 0.01, 'a tall shape at a huge width is scaled to stay inside the limits: ' + JSON.stringify(tall));
  const flat = G.sizeFromRatio(21, 9, 40); assert.ok(flat.w >= G.MIN_WIDTH && flat.h >= G.MIN_HEIGHT, 'a flat one at a tiny width too: ' + JSON.stringify(flat));
  assert.equal(G.ratioName(1080, 1080), '1:1'); assert.equal(G.ratioName(1920, 1080), '16:9'); assert.equal(G.ratioName(1080, 1920), '9:16');
  assert.equal(G.ratioName(1024, 768), '4:3'); assert.equal(G.ratioName(390, 219), '16:9', 'a hand-rounded size still has its shape');
  assert.equal(G.ratioName(360, 250), '', 'not a common shape');
  assert.equal(G.ratioName(0, 10), '');
});

test('a size wider than the room is scaled down keeping its shape, and never leaves the limits', () => {
  assert.deepEqual(G.fitSize({ w: 728, h: 90 }, 358), { w: 358, h: 44 });
  assert.deepEqual(G.fitSize({ w: 300, h: 250 }, 1000), { w: 300, h: 250 }, 'enough room: the size is kept');
  assert.deepEqual(G.fitSize({ w: 300, h: 250 }, 0), { w: 300, h: 250 }, 'no room known: the size is kept');
  const tiny = G.fitSize({ w: 970, h: 90 }, 60); assert.ok(tiny.w >= G.MIN_WIDTH && tiny.h >= G.MIN_HEIGHT);
  assert.equal(G.fitSize({ w: 0, h: 90 }, 300), null);
  assert.equal(G.fitSize(null, 300), null);
});

test('the menu hands the shapes to the host: a dialog for the tools without a panel, the panel itself for the ones that have one', async () => {
  const b = await sizedEditor();
  const menu = plain(b.tools.menu(null)), by = (id) => menu.find((t) => t.id === id);
  ['create_text_block', 'create_text'].forEach((id) => assert.equal(by(id).sizeUi, 'dialog', id + ' has no panel of its own: the dimensions dialog opens'));
  ['create_banner', 'create_image', 'create_section', 'create_brand', 'create_store', 'create_perfume', 'create_occasion', 'create_note'].forEach((id) => assert.equal(by(id).sizeUi, 'panel', id + ' has a panel: the dimensions are a field in it'));
  ['create_text_block', 'create_text', 'create_banner', 'create_image', 'create_section', 'create_brand'].forEach((id) => {
    assert.ok(Array.isArray(by(id).sizes) && by(id).sizes.length === 1 && by(id).sizes[0].id === 'ratio' && by(id).sizes[0].sizes.length === G.RATIOS.length, id + ' offers the common shapes only');
    by(id).sizes[0].sizes.forEach((s) => assert.ok(Array.isArray(s.ratio) && s.label && s.w === undefined, 'a shape, never pixels'));
  });
  ['format', 'copy', 'archive', 'media'].forEach((id) => assert.equal(by(id).sizes, undefined, id + ' has no dimensions list'));
  assert.equal(by('size_preset'), undefined, 'nothing is chosen on an empty page: no dimensions entry');
  const made = await b.mode.execute('tool.run', { id: 'create_text_block' });
  await b.mode.execute('element.select', { elementId: made.elementId });
  const own = plain(b.tools.menu(b.mode.state().selected)).find((t) => t.id === 'size_preset');
  assert.equal(own.label, 'أبعاد العناصر', 'the right-click item is called «أبعاد العناصر»');
  assert.equal(own.ui, 'size'); assert.equal(own.enabled, true); assert.equal(own.sizeUi, 'dialog'); assert.ok(own.sizes.length > 0);
});

test('a shape chosen before creating makes a block at the room it has (up to 480) with the height the shape gives; one undo step', async () => {
  const b = await sizedEditor();
  const before = plain(b.mode.state().design).blocks.length;
  const made = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [16, 9] } })).elementId;
  const e = editOf(b, made);
  assert.ok(e.w >= G.MIN_WIDTH && e.w <= 480, 'width: ' + e.w);
  assert.equal(e.h, Math.round(e.w * 9 / 16), '16:9: ' + JSON.stringify(e));
  const sq = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [1, 1] } })).elementId;
  assert.equal(editOf(b, sq).w, editOf(b, sq).h, 'a square');
  const tall = (await b.mode.execute('tool.run', { id: 'create_text', size: { ratio: [9, 16] } })).elementId;
  assert.ok(editOf(b, tall).h > editOf(b, tall).w, 'a tall one');
  await b.mode.execute('history.undo', {}); await b.mode.execute('history.undo', {}); await b.mode.execute('history.undo', {});
  assert.equal(plain(b.mode.state().design).blocks.length, before, 'one undo step each');
  const auto = (await b.mode.execute('tool.run', { id: 'create_banner', src: '/assets/a.webp' })).elementId;
  assert.equal(editOf(b, auto).w, undefined, 'nothing chosen (automatic): the default flow, nothing fixed');
  const withImage = (await b.mode.execute('tool.run', { id: 'create_image', src: '/assets/a.webp', size: { ratio: [4, 3] } })).elementId;
  assert.equal(editOf(b, withImage).h, Math.round(editOf(b, withImage).w * 3 / 4), 'an image in 4:3');
});

test('the panels create with a shape too: a smart block (section or card) through element.create', async () => {
  const b = await sizedEditor();
  const made = plain(await b.mode.execute('element.create', { kind: 'smart', ref: 'sec-1', semanticKind: 'section', size: { ratio: [1, 1] } }));
  const id = made.elementId || made.id;
  assert.ok(id, 'created: ' + JSON.stringify(made));
  assert.equal(editOf(b, id).w, editOf(b, id).h, 'a square section');
  const plainOne = plain(await b.mode.execute('element.create', { kind: 'smart', ref: 'sec-2', semanticKind: 'brand' }));
  assert.equal(editOf(b, plainOne.elementId || plainOne.id).w, undefined, 'automatic keeps the default');
});

test('a shape that is not a shape is refused before anything is created', async () => {
  const b = await sizedEditor();
  for (const bad of [{ ratio: [0, 9] }, { ratio: [16] }, { ratio: 'wide' }, { ratio: [500, 1] }, { ratio: null }, { w: 300, h: 250 }, {}, 'big']) {
    await assert.rejects(b.mode.execute('tool.run', { id: 'create_text_block', size: bad }), /أبعاد غير صالحة/);
  }
  assert.equal(plain(b.mode.state().design.blocks).length, 0, 'nothing was created');
});

test('a shape given to an element that exists keeps its width and changes only the height; on this screen size only; the original size comes back', async () => {
  const b = await sizedEditor();
  const id = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [4, 3] } })).elementId;
  await b.mode.execute('element.select', { elementId: id });
  const before = { w: editOf(b, id).w, h: editOf(b, id).h };
  const done = plain(await b.mode.execute('tool.run', { id: 'size_preset', elementId: id, size: { ratio: [1, 1] } }));
  assert.equal(done.w, before.w, 'the width is kept: ' + JSON.stringify([before, done]));
  assert.equal(done.h, before.w, 'and the height follows the shape: ' + JSON.stringify(done));
  assert.deepEqual({ w: editOf(b, id).w, h: editOf(b, id).h }, { w: done.w, h: done.h }, 'saved');
  const design = plain(b.mode.state().design), device = b.mode.state().device;
  Object.keys(design.edits).filter((k) => k !== device).forEach((k) => assert.equal((design.edits[k] || {})[id], undefined, 'the other screen sizes keep the original size: ' + k));
  assert.equal(ED.normalize(design, { strict: true }).ok, true, 'what is saved is a valid design');
  await b.mode.execute('element.resize', { elementId: id, size: { ratio: [2, 1] } });
  assert.equal(editOf(b, id).h * 2, editOf(b, id).w, '2:1 through element.resize too');
  await b.mode.execute('tool.run', { id: 'size_preset', elementId: id });
  assert.equal(editOf(b, id).w, undefined); assert.equal(editOf(b, id).h, undefined, 'the original size is back');
  await assert.rejects(b.mode.execute('tool.run', { id: 'size_preset', elementId: id, size: { ratio: [0, 0] } }), /أبعاد غير صالحة/);
  await assert.rejects(b.mode.execute('tool.run', { id: 'size_preset', size: { ratio: [1, 1] } }), /مش متاحة/);   // nothing chosen: the tool is not offered
});

test('what the host opens: the dimensions dialog, the field inside a panel, no pixel sizes and no saved pixel sizes', () => {
  const media = read('editor/editor-media.js'), host = read('editor/elan-editor.html'), mode = read('edit-mode.js'), create = read('editor/editor-live-create.js');
  assert.match(media, /window\.elanPickSize = function/);
  assert.match(media, /window\.elanRatioField = function/);
  assert.match(media, /className: 'shape'/); assert.match(media, /\{ ratio: \[ratio\[0\], ratio\[1\]\] \}/);
  assert.match(media, /elanLiveMediaNew = async function \(tool, at\)/);
  assert.match(media, /أبعاد البانر/); assert.match(media, /أبعاد الصورة/);
  assert.match(host, /t\.sizes&&t\.sizeUi!=='panel'&&window\.elanPickSize/);
  assert.match(host, /window\.elanLiveMediaNew\(t,at\)/);
  assert.match(mode, /id: 'size_preset'/);
  assert.match(create, /أبعاد السيكشن/); assert.match(create, /أبعاد كروت العطور/); assert.match(create, /أبعاد كارت البراند/);
  assert.match(create, /elanRatioField\(ratios/); assert.match(create, /size: size \|\| undefined/);
  assert.match(read('edit-boot.js'), /editor-geometry\.js/, 'the page loads the list together with the editor code');
  assert.doesNotMatch(media + host + mode + create, /mine-add|size\.save|size\.remove|mySizes/, 'the saved pixel sizes of the first version are gone');
});

test('a design file that still carries the old saved pixel sizes stays valid; they are simply not kept', () => {
  const d = { version: ED.VERSION, blocks: [], order: [], mySizes: [{ w: 600, h: 400 }] };
  const out = ED.normalize(d, { strict: true });
  assert.equal(out.ok, true); assert.equal(out.design.mySizes, undefined);
  assert.equal(ED.serialize(d).includes('mySizes'), false);
});
