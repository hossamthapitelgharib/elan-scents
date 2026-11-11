const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../editor/editor-geometry.js');
const { designBrowser, plain, read } = require('./browser-fixture');

/* Owner, 2026-11-11: a size chosen for an element (menu or corner) is its size whatever the stylesheet says (the hero too); a picture or a video in it is shown whole and fills it
   (never cut, never stretched), and «نفس شكل الصورة» gives the frame the picture's own shape. The real layout (grids, strips, the blurred copy) is in tests/browser/editor-fit.chromium.js. */

async function editor() {
  const b = designBrowser(); let bridge;
  b.window.ElanEditorGeometry = G;
  b.window.ElanHostBridge = { install(options) { bridge = options; return { dirty() {}, selection() {}, context() {}, revision() {} }; } };
  b.context.fetch = async (url) => {
    if (url === '/api/editor?action=state') return { ok: true, json: async () => ({ ok: true, design: { version: 1 }, revision: 'initial' }) };
    if (url === '/api/editor-session') return { ok: true };
    throw new Error('Unexpected network in editor test: ' + url);
  };
  b.run(read('edit-mode.js')); await bridge.getState(); b.mode = b.window.ElanEditMode; b.tools = b.window.ElanEditTools; b.layer = b.window.ElanDesignLayer;
  return b;
}
const pixels = (node, w, h) => { Object.defineProperty(node, 'naturalWidth', { value: w, configurable: true }); Object.defineProperty(node, 'naturalHeight', { value: h, configurable: true }); Object.defineProperty(node, 'complete', { value: true, configurable: true }); };
/* a block is rebuilt on every repaint: every picture the page makes from now on has these pixels, as if it had loaded */
const alwaysPixels = (b, w, h) => { const make = b.document.createElement.bind(b.document); b.document.createElement = (tag) => { const n = make(tag); if (String(tag).toLowerCase() === 'img') pixels(n, w, h); return n; }; };
const sizeEntry = (b, id) => plain(b.tools.menu(b.mode.state().selected)).find((t) => t.id === 'size_preset');

test('an element that has a picture gets «نفس شكل الصورة» first in its dimensions window, one without does not; it makes the frame the picture\'s own shape at the width the element has', async () => {
  const b = await editor();
  const text = (await b.mode.execute('element.create', { kind: 'text_block' })).elementId;
  await b.mode.execute('element.select', { elementId: text });
  assert.ok(!sizeEntry(b).sizes[0].sizes.some((s) => s.media), 'a text block has no picture: only the common shapes');
  await assert.rejects(() => b.mode.execute('element.resize', { elementId: text, size: { media: true } }), /مفيهوش صورة/);

  alwaysPixels(b, 1200, 800);
  const made = (await b.mode.execute('element.create', { kind: 'image', src: '/assets/cards/a.webp' })).elementId;
  await b.mode.execute('element.select', { elementId: made });
  const first = sizeEntry(b).sizes[0].sizes[0];
  assert.deepEqual(plain(first), { media: true, ratio: [1200, 800], label: 'نفس شكل الصورة' });
  assert.equal(sizeEntry(b).sizes[0].sizes.length, G.RATIOS.length + 1, 'and the common shapes after it');
  const got = await b.mode.execute('element.resize', { elementId: made, size: { media: true } });
  assert.ok(Math.abs(got.w / got.h - 1200 / 800) < 0.01, 'the picture\'s shape: ' + JSON.stringify(got));
  const again = await b.mode.execute('element.resize', { elementId: made, size: { media: true } });
  assert.equal(again.w, got.w, 'and the same width again: it only follows the shape');
});

test('a saved size is the element\'s size whatever the stylesheet says: width, height, minimum and maximum are written with !important', async () => {
  const b = await editor();
  const made = (await b.mode.execute('element.create', { kind: 'text_block' })).elementId;
  await b.mode.execute('element.resize', { elementId: made, size: { ratio: [1, 1] } });
  const node = b.document.querySelector('[data-elan-id="' + made + '"]'), st = node.style;
  ['width', 'height', 'max-width', 'min-height', 'max-height', 'flex'].forEach((k) => assert.equal(st.getPropertyPriority(k), 'important', k + ' wins over the sheet'));
  assert.match(st.getPropertyValue('min-height'), /^0(px)?$/, 'a short element is not held by a minimum height (the hero\'s is 420px)');
  assert.equal(st.getPropertyValue('max-width'), 'none');
});

test('the hero is resized like any element: a saved size is painted on it (so the stylesheet\'s own height no longer holds it) and removing the size gives it back', async () => {
  const b = await editor();
  const hero = b.document.createElement('section'); hero.id = 'hero'; b.document.body.insertBefore(hero, b.document.body.firstChild);
  assert.ok(b.layer.elements().some((e) => e.id === 'hero'), 'the hero is an element of the editor');
  await b.mode.execute('element.select', { elementId: 'hero' });
  const entry = sizeEntry(b); assert.equal(entry.enabled, true, 'its dimensions entry is on');
  const got = await b.mode.execute('element.resize', { elementId: 'hero', size: { ratio: [16, 9] } });
  assert.ok(Math.abs(got.w / got.h - 16 / 9) < 0.02, JSON.stringify(got));
  assert.equal(hero.style.getPropertyValue('height'), got.h + 'px'); assert.equal(hero.style.getPropertyPriority('height'), 'important'); assert.match(hero.style.getPropertyValue('min-height'), /^0(px)?$/);
  await b.mode.execute('tool.run', { id: 'size_preset', elementId: 'hero' });
  assert.equal(hero.style.getPropertyValue('height'), '', 'automatic: nothing of it is left on the hero');
});

test('a picture in a resized element is made to fill it whole: contain (never cut, never stretched), and it is all taken off again with the size', async () => {
  const b = await editor();
  alwaysPixels(b, 400, 200);
  const made = (await b.mode.execute('element.create', { kind: 'image', src: '/assets/cards/a.webp' })).elementId;
  assert.equal(b.document.querySelector('[data-elan-id="' + made + '"]').querySelector('.elan-fit-back'), null, 'nothing changes for an element that was not resized');
  await b.mode.execute('element.resize', { elementId: made, size: { ratio: [1, 1] } });
  const root = b.document.querySelector('[data-elan-id="' + made + '"]');
  assert.equal(root.hasAttribute('data-elan-fit'), true);
  const now = root.querySelector('img');
  assert.equal(now.style.getPropertyValue('object-fit'), 'contain'); assert.equal(now.style.getPropertyPriority('object-fit'), 'important');
  assert.equal(now.style.getPropertyValue('width'), '100%'); assert.equal(now.style.getPropertyValue('height'), '100%');
  assert.match(root.style.getPropertyValue('padding'), /^0(px)?$/, 'the block\'s side gutter would leave a strip beside the picture');
  assert.equal(root.querySelectorAll('.elan-fit-back').length, 1, 'the room a 1:1 frame leaves around a 2:1 picture is its own blurred copy');
  await b.mode.execute('history.undo', {});
  const back = b.document.querySelector('[data-elan-id="' + made + '"]');
  assert.equal(back.querySelector('.elan-fit-back'), null); assert.equal(back.hasAttribute('data-elan-fit'), false);
  assert.equal(back.querySelector('img').style.getPropertyValue('object-fit'), '', 'the picture is as it was');
});

test('the stylesheet keeps the picture whole and the blurred copy inside the frame, and the corner drag no longer pins the opposite edge', () => {
  const css = read('design-layer.js'), mode = read('edit-mode.js');
  assert.match(css, /\.elan-fit-back\{[^}]*filter:blur\([^}]*clip-path:inset\(40px\)/, 'blurred copy clipped to the frame');
  assert.match(css, /\.elan-fit-front\{[^}]*background-size:contain/);
  assert.match(css, /video\.elan-fit-back\{[^}]*object-fit:cover/);
  const step = mode.slice(mode.indexOf('function stepResize'), mode.indexOf('function showSize'));
  assert.ok(!/translate\(/.test(step) && !/g\.dx =|g\.dy =/.test(step), 'the element stays where the page put it and everything around it makes room (no compensating offset)');
  assert.match(mode, /handleEl\.setAttribute\('data-h', rtl \? 'sw' : 'se'\)/, 'the handle is on the corner that moves');
  assert.match(mode, /layer\.liveSize\(en, w, h\)/, 'the picture follows the size while the corner is dragged');
});
