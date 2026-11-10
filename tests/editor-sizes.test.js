const test = require('node:test');
const assert = require('node:assert/strict');
const ED = require('../design-schema.js');
const G = require('../editor/editor-geometry.js');
const { designBrowser, plain, read } = require('./browser-fixture');

/* The standard sizes: a saved list the owner picks from (before creating an element, or for a chosen one) instead of a random size. */

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

test('every standard size is inside what a saved design accepts, and none is listed twice', () => {
  const seen = new Set();
  assert.ok(G.SIZE_GROUPS.length >= 3);
  G.SIZE_GROUPS.forEach((group) => {
    assert.ok(group.id && group.label && group.sizes.length > 0, 'a named group with sizes: ' + group.id);
    group.sizes.forEach((s) => {
      assert.ok(s.label, 'every size has a name: ' + s.w + 'x' + s.h);
      assert.ok(Number.isInteger(s.w) && Number.isInteger(s.h), 'whole pixels');
      assert.ok(s.w >= G.MIN_WIDTH && s.w <= G.MAX_SIZE && s.h >= G.MIN_HEIGHT && s.h <= G.MAX_SIZE, 'inside the geometry limits: ' + s.w + 'x' + s.h);
      const key = s.w + 'x' + s.h; assert.ok(!seen.has(key), 'listed once: ' + key); seen.add(key);
      const d = { version: ED.VERSION, blocks: [{ id: 'x-a1', type: 'text', text: { ar: 'س' }, style: { align: 'center', size: 'md' } }], edits: { mobile: { 'x-a1': { w: s.w, h: s.h } } } };
      assert.equal(ED.normalize(d, { strict: true }).ok, true, 'the design file accepts ' + key);
    });
  });
  ['728x90', '300x250', '320x50', '1080x1080', '1080x1920', '1200x630', '1920x1080', '794x1123'].forEach((key) => assert.ok(seen.has(key), 'the world standard ' + key + ' is in the list'));
});

test('a size wider than the room is scaled down keeping its shape, and never leaves the limits', () => {
  assert.deepEqual(G.fitSize({ w: 728, h: 90 }, 358), { w: 358, h: 44 }, 'a leaderboard on a phone is a full-width strip');
  assert.deepEqual(G.fitSize({ w: 300, h: 250 }, 1000), { w: 300, h: 250 }, 'enough room: the size is kept');
  assert.deepEqual(G.fitSize({ w: 300, h: 250 }, 0), { w: 300, h: 250 }, 'no room known: the size is kept');
  assert.deepEqual(G.fitSize({ w: 1080, h: 1920 }, 360), { w: 360, h: 640 });
  const tiny = G.fitSize({ w: 970, h: 90 }, 60); assert.ok(tiny.w >= G.MIN_WIDTH && tiny.h >= G.MIN_HEIGHT);
  assert.equal(G.fitSize({ w: 0, h: 90 }, 300), null);
  assert.equal(G.fitSize(null, 300), null);
});

test('the menu hands the groups to the host only for the tools that take a size', async () => {
  const b = await sizedEditor();
  const menu = plain(b.tools.menu(null)), by = (id) => menu.find((t) => t.id === id);
  ['create_text_block', 'create_banner', 'create_text', 'create_image'].forEach((id) => {
    assert.ok(Array.isArray(by(id).sizes) && by(id).sizes.length === G.SIZE_GROUPS.length + 1 && by(id).sizes[0].id === 'ratio', id + ' offers the common shapes first, then the standard sizes');
  });
  ['format', 'create_section', 'copy', 'archive', 'media'].forEach((id) => assert.equal(by(id).sizes, undefined, id + ' has no size list'));
  assert.equal(by('size_preset'), undefined, 'nothing is chosen on an empty page: no size entry');
  const made = await b.mode.execute('tool.run', { id: 'create_text_block' });
  await b.mode.execute('element.select', { elementId: made.elementId });
  const own = plain(b.tools.menu(b.mode.state().selected)).find((t) => t.id === 'size_preset');
  assert.equal(own.ui, 'size'); assert.equal(own.enabled, true); assert.ok(own.sizes.length > 0);
});

test('an element created with a standard size has that size on this screen size, in one undo step', async () => {
  const b = await sizedEditor();
  const made = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { w: 300, h: 250 } })).elementId;
  assert.deepEqual({ w: editOf(b, made).w, h: editOf(b, made).h }, { w: 300, h: 250 });
  assert.equal(plain(b.mode.state().design.blocks).length, 1);
  await b.mode.execute('history.undo', {});
  assert.equal(plain(b.mode.state().design.blocks).length, 0, 'one undo removes the element together with its size');
  const auto = (await b.mode.execute('tool.run', { id: 'create_banner', src: '/assets/a.webp' })).elementId;
  assert.equal(editOf(b, auto).w, undefined, 'no size chosen: the default flow, nothing fixed');
  const withImage = (await b.mode.execute('tool.run', { id: 'create_image', src: '/assets/a.webp', size: { w: 1080, h: 1080 } })).elementId;
  assert.equal(editOf(b, withImage).h <= 4000 && editOf(b, withImage).w > 0, true);
  const free = (await b.mode.execute('tool.run', { id: 'create_text', size: { w: 320, h: 50 } })).elementId;
  assert.equal(editOf(b, free).w, 320);
});

test('a size that is not a real size is refused before anything is created', async () => {
  const b = await sizedEditor();
  for (const bad of [{ w: 5, h: 5 }, { w: 99999, h: 100 }, { w: 'x', h: 100 }, {}, 'big']) {
    await assert.rejects(b.mode.execute('tool.run', { id: 'create_text_block', size: bad }), /مقاس غير صالح/);
  }
  assert.equal(plain(b.mode.state().design.blocks).length, 0);
  await assert.rejects(b.mode.execute('tool.run', { id: 'create_text_block', size: { w: 300, h: 5 } }), /مقاس غير صالح/);
});

test('size_preset gives the chosen element a standard size on this screen size only and can give the original back', async () => {
  const b = await sizedEditor();
  const id = (await b.mode.execute('tool.run', { id: 'create_text_block' })).elementId;
  const got = await b.mode.execute('tool.run', { id: 'size_preset', elementId: id, size: { w: 728, h: 90 } });
  assert.deepEqual(plain(got), { w: 728, h: 90 });
  const design = plain(b.mode.state().design), device = b.mode.state().device;
  assert.equal(design.edits[device][id].w, 728);
  Object.keys(design.edits).filter((k) => k !== device).forEach((k) => assert.equal((design.edits[k] || {})[id], undefined, 'the other screen sizes keep the original size: ' + k));
  assert.equal(ED.normalize(design, { strict: true }).ok, true, 'what is saved is a valid design');
  await b.mode.execute('tool.run', { id: 'size_preset', elementId: id });
  assert.equal(editOf(b, id).w, undefined); assert.equal(editOf(b, id).h, undefined);
  await assert.rejects(b.mode.execute('tool.run', { id: 'size_preset', elementId: id, size: { w: 1, h: 1 } }), /مقاس غير صالح/);
  await assert.rejects(b.mode.execute('tool.run', { id: 'size_preset', size: { w: 300, h: 250 } }), /مش متاحة/);   // nothing chosen: the tool is not offered
});

test('element.resize accepts a standard size too (the mouse handle path is unchanged)', async () => {
  const b = await sizedEditor();
  const id = (await b.mode.execute('tool.run', { id: 'create_text_block' })).elementId;
  await b.mode.execute('element.resize', { elementId: id, w: 222, h: 111 });
  assert.deepEqual({ w: editOf(b, id).w, h: editOf(b, id).h }, { w: 222, h: 111 });
  await b.mode.execute('element.resize', { elementId: id, size: { w: 336, h: 280 } });
  assert.deepEqual({ w: editOf(b, id).w, h: editOf(b, id).h }, { w: 336, h: 280 });
});

test('the host dialog and its wiring are in the editor files the page loads', () => {
  const media = read('editor/editor-media.js'), host = read('editor/elan-editor.html'), mode = read('edit-mode.js');
  assert.match(media, /window\.elanPickSize = function/);
  assert.match(media, /elanLiveMediaNew = async function \(tool, at, size\)/);
  assert.match(host, /window\.elanPickSize\(t\.sizes/);
  assert.match(host, /window\.elanLiveMediaNew\(t,at,size\)/);
  assert.match(host, /runLive\('tool\.run',\{id:t\.id,elementId:el&&el\.id,at,size:size\|\|undefined\}\)/);
  assert.match(mode, /id: 'size_preset'/);
  assert.match(read('edit-boot.js'), /editor-geometry\.js/, 'the page loads the list together with the editor code');
});

/* The owner's own sizes ("مقاساتي"): saved next to the standard ones, kept in the design file so they follow him to every device. */
test('the design file accepts the owner\'s own sizes and refuses what is not a size', () => {
  const base = { version: ED.VERSION, blocks: [], order: [] };
  const ok = ED.normalize({ ...base, mySizes: [{ w: 600, h: 400, name: 'بانر العروض' }, { w: 1000, h: 500 }] }, { strict: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.design.mySizes, [{ w: 600, h: 400, name: 'بانر العروض' }, { w: 1000, h: 500 }]);
  assert.equal(ED.isEmpty(ok.design), false, 'a design holding only saved sizes is not empty');
  assert.equal(ED.serialize({ ...base, mySizes: [{ w: 40, h: 30 }, { w: 4000, h: 4000 }] }).includes('"mySizes"'), true);
  const bad = [
    [{ w: 39, h: 400 }], [{ w: 600, h: 29 }], [{ w: 4001, h: 400 }], [{ w: 600.5, h: 400 }], [{ w: '600', h: 400 }], [{}], ['600x400'],
    [{ w: 600, h: 400 }, { w: 600, h: 400, name: 'تاني' }],
    Array.from({ length: ED.MY_SIZES.count + 1 }, (_, i) => ({ w: 100 + i, h: 100 }))
  ];
  bad.forEach((list) => assert.equal(ED.normalize({ ...base, mySizes: list }, { strict: true }).ok, false, 'refused: ' + JSON.stringify(list).slice(0, 60)));
  assert.equal(ED.normalize({ ...base, mySizes: 'big' }, { strict: true }).ok, false);
  const lenient = ED.normalize({ ...base, mySizes: [{ w: 600, h: 400 }, { w: 5, h: 5 }, { w: 600, h: 400 }] });
  assert.deepEqual(lenient.design.mySizes, [{ w: 600, h: 400 }], 'an older reader keeps the good ones and drops the rest');
  const named = ED.normalize({ ...base, mySizes: [{ w: 600, h: 400, name: '  <b>x</b>\u0000' + 'ا'.repeat(80) }] }).design.mySizes[0].name;
  assert.ok(named.length <= ED.MY_SIZES.name && !/\u0000/.test(named), 'the name is trimmed, cleaned and cut');
});

test('size.save keeps an own size, shows it first in the chooser and creates with it; size.remove takes it away; undo goes back', async () => {
  const b = await sizedEditor();
  const groupsOf = () => plain(b.tools.menu(null)).find((t) => t.id === 'create_text_block').sizes;
  assert.equal(groupsOf()[0].id, 'ratio', 'nothing saved yet: the common shapes come first');
  const saved = plain(await b.mode.execute('size.save', { w: 600, h: 400, name: 'بانر العروض' }));
  assert.equal(saved.groups[0].id, 'mine'); assert.equal(saved.groups[0].label, 'مقاساتي');
  assert.deepEqual(saved.groups[0].sizes, [{ w: 600, h: 400, label: 'بانر العروض', mine: true }]);
  assert.equal(saved.groups.length, G.SIZE_GROUPS.length + 2, 'mine, the common shapes, the standard sizes');
  assert.equal(groupsOf()[0].id, 'mine', 'the menu hands the host the same list');
  assert.deepEqual(plain(b.mode.state().design.mySizes), [{ w: 600, h: 400, name: 'بانر العروض' }], 'part of the design that is saved');
  assert.equal(ED.normalize(plain(b.mode.state().design), { strict: true }).ok, true);
  const made = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { w: 600, h: 400 } })).elementId;
  assert.deepEqual({ w: editOf(b, made).w, h: editOf(b, made).h }, { w: 600, h: 400 });
  // the same size again changes its name instead of listing it twice
  const renamed = plain(await b.mode.execute('size.save', { w: 600, h: 400, name: 'بانر الشتاء' }));
  assert.deepEqual(renamed.groups[0].sizes.map((s) => s.label), ['بانر الشتاء']);
  const second = plain(await b.mode.execute('size.save', { w: 320, h: 180 }));
  assert.equal(second.groups[0].sizes.length, 2);
  assert.equal(second.groups[0].sizes[1].label, '', 'a size without a name');
  const removed = plain(await b.mode.execute('size.remove', { w: 600, h: 400 }));
  assert.deepEqual(removed.groups[0].sizes.map((s) => s.w), [320]);
  const last = plain(await b.mode.execute('size.remove', { w: 320, h: 180 }));
  assert.equal(last.groups[0].id, 'ratio', 'the group is gone with its last size');
  assert.equal(plain(b.mode.state().design).mySizes, undefined);
  await b.mode.execute('history.undo', {});
  assert.deepEqual(plain(b.mode.state().design.mySizes).map((s) => s.w), [320], 'undo brings the removed size back');
});

test('size.save and size.remove refuse what makes no sense', async () => {
  const b = await sizedEditor();
  for (const bad of [{ w: 5, h: 5 }, { w: 99999, h: 100 }, { w: 'x', h: 100 }, {}, null]) {
    await assert.rejects(b.mode.execute('size.save', bad), /مقاس غير صالح|اكتب العرض/);
  }
  await assert.rejects(b.mode.execute('size.remove', { w: 600, h: 400 }), /مش في مقاساتك/);
  for (let i = 0; i < ED.MY_SIZES.count; i++) await b.mode.execute('size.save', { w: 100 + i, h: 100 });
  await assert.rejects(b.mode.execute('size.save', { w: 900, h: 900 }), /للحد الأقصى/);
  await b.mode.execute('size.save', { w: 100, h: 100, name: 'بدّل الاسم' });   // an existing size can still be renamed when the list is full
  assert.equal(plain(b.mode.state().design.mySizes).length, ED.MY_SIZES.count);
});

test('the host may ask the page to save and remove an own size', () => {
  const bridge = read('elan-host-bridge.js');
  assert.match(bridge, /'size\.save'/); assert.match(bridge, /'size\.remove'/);
  const media = read('editor/editor-media.js'), host = read('editor/elan-editor.html');
  assert.match(media, /opts\.save\(\{ w: w, h: h, name: nBox\.value \}\)/);
  assert.match(media, /opts\.remove\(\{ w: size\.w, h: size\.h \}\)/);
  assert.match(host, /save:s=>runLive\('size\.save',s\),remove:s=>runLive\('size\.remove',s\)/);
});

/* Shapes (ratios) for an owner who does not think in pixels: 1:1, 4:3, 9:16 and the others are examples, listed first, drawn as little shapes in the chooser. */
test('the common shapes include the ones the owner named, each with a name, and none is listed twice', () => {
  const names = G.RATIOS.map((r) => r.w + ':' + r.h);
  ['1:1', '4:3', '9:16', '16:9', '3:2', '4:5'].forEach((n) => assert.ok(names.includes(n), n + ' is there'));
  assert.equal(new Set(names).size, names.length, 'listed once');
  G.RATIOS.forEach((r) => { assert.ok(Number.isInteger(r.w) && Number.isInteger(r.h) && r.w >= 1 && r.h >= 1 && r.label, 'whole numbers and a name: ' + r.w + ':' + r.h); });
  assert.ok(G.RATIOS.length >= 10, 'a good list of examples');
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

test('a shape chosen before creating makes a block at the room it has (up to 480) with the height the shape gives; one undo step', async () => {
  const b = await sizedEditor();
  const before = plain(b.mode.state().design).blocks.length;
  const made = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [16, 9] } })).elementId;
  const e = editOf(b, made);
  assert.ok(e.w >= G.MIN_WIDTH && e.w <= 480, 'width: ' + e.w);
  assert.equal(e.h, Math.round(e.w * 9 / 16), '16:9: ' + JSON.stringify(e));
  const sq = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [1, 1] } })).elementId;
  assert.equal(editOf(b, sq).w, editOf(b, sq).h, 'a square');
  const tall = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { ratio: [9, 16] } })).elementId;
  assert.ok(editOf(b, tall).h > editOf(b, tall).w, 'a tall one');
  await b.mode.execute('history.undo', {}); await b.mode.execute('history.undo', {}); await b.mode.execute('history.undo', {});
  assert.equal(plain(b.mode.state().design).blocks.length, before, 'one undo step each');
});

test('a shape given to an element that exists keeps its width and changes only the height; "original size" still clears it', async () => {
  const b = await sizedEditor();
  const id = (await b.mode.execute('tool.run', { id: 'create_text_block', size: { w: 300, h: 250 } })).elementId;
  await b.mode.execute('element.select', { elementId: id });
  const before = { w: editOf(b, id).w, h: editOf(b, id).h };
  const done = plain(await b.mode.execute('tool.run', { id: 'size_preset', elementId: id, size: { ratio: [1, 1] } }));
  assert.equal(done.w, before.w, 'the width is kept: ' + JSON.stringify([before, done]));
  assert.equal(done.h, before.w, 'and the height follows the shape: ' + JSON.stringify(done));
  assert.deepEqual({ w: editOf(b, id).w, h: editOf(b, id).h }, { w: done.w, h: done.h }, 'saved');
  await b.mode.execute('element.resize', { elementId: id, size: { ratio: [2, 1] } });
  assert.equal(editOf(b, id).h * 2, editOf(b, id).w, '2:1 through element.resize too');
  await b.mode.execute('tool.run', { id: 'size_preset', elementId: id });
  assert.equal(editOf(b, id).w, undefined, 'the original size is back');
});

test('a shape that is not a shape is refused', async () => {
  const b = await sizedEditor();
  for (const bad of [{ ratio: [0, 9] }, { ratio: [16] }, { ratio: 'wide' }, { ratio: [500, 1] }, { ratio: null }]) {
    await assert.rejects(b.mode.execute('tool.run', { id: 'create_text_block', size: bad }), /نسبة غير صالحة|مقاس غير صالح/);
  }
});

test('the chooser draws a little shape with every size and takes a shape as an answer', () => {
  const media = read('editor/editor-media.js');
  assert.match(media, /className: 'shape'/); assert.match(media, /\{ ratio: \[ratio\[0\], ratio\[1\]\] \}/);
  assert.match(media, /النسب هنا أمثلة/);
});
