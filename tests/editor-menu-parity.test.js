const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ED = require('../design-schema.js');
const { designBrowser, plain, read } = require('./browser-fixture');

/* The right-click menu of the live editor against the original editor's golden menu
   (tests/fixtures/elan-original-tools-golden.json): same tools, same order, same enablement. */
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'elan-original-tools-golden.json'), 'utf8'));
const GOLDEN_IDS = ['format', 'create_section', 'create_brand', 'create_store', 'create_perfume', 'create_occasion', 'create_note', 'create_text_block', 'create_banner', 'create_text', 'media', 'media_delete', 'edit_text', 'copy', 'archive', 'library_save', 'library_download'];
const EXTRA_IDS = ['create_image', 'size_preset', 'row_join', 'row_split', 'open', 'go_back', 'go_home'];   // size_preset: standard sizes, shown only when an element is chosen; row_join / row_split: only on a section or block of the page
const SCOPE_IDS = ['scope_toggle', 'scope_reset'];   // default pages: they show only on a product, brand or store page
const flags = (rows) => rows.map((r) => r.startsWith('[ok]'));
/* The right-click menu order the owner asked for (2026-11-11): text first, then pictures and videos, the banner, the section, the perfume card, the brand, the store, then the rest. */
const OWNER_ORDER = ['edit_text', 'format', 'create_text_block', 'create_text', 'media', 'media_delete', 'create_image', 'create_banner', 'create_section', 'create_perfume', 'create_brand', 'create_store'];

async function liveEditor() {
  const b = designBrowser(), events = [];
  b.window.ElanHostBridge = { install(options) { b.options = options; return { dirty() {}, selection() {}, revision() {}, context(info) { events.push(['context', info]); }, menuClose() { events.push(['close']); } }; } };
  b.context.fetch = async (url) => {
    if (url === '/api/editor?action=state') return { ok: true, json: async () => ({ ok: true, design: { version: 1 }, revision: 'initial' }) };
    if (url === '/api/editor-session') return { ok: true };
    throw new Error('Unexpected network in editor test: ' + url);
  };
  b.run(read('edit-mode.js')); await b.options.getState();
  b.mode = b.window.ElanEditMode; b.tools = b.window.ElanEditTools; b.events = events;
  b.document.elementsFromPoint = () => [];
  return b;
}
function stack(b) {
  const main = b.document.getElementById('main');
  main.innerHTML = '<section id="brands"><h3>براندات</h3><div class="strip"><div class="card" data-go="col|brands|0"><img src="/assets/cards/a.webp"><h4>شانيل</h4><p>وصف قصير</p></div><div class="card" data-go="col|brands|1"><h4>ديور</h4></div></div></section>' +
    '<section id="offers"><h3>عروض</h3></section><section id="new"><h3>جديد</h3></section>';
  const rects = [['brands', 0, 200], ['offers', 200, 300], ['new', 500, 100]];
  rects.forEach(([id, top, height]) => { b.document.getElementById(id).getBoundingClientRect = () => ({ left: 0, top, right: 1000, bottom: top + height, width: 1000, height }); });
  return b.layer.elements();
}
const menuFor = (b, id) => { if (id) b.mode.execute('element.select', { elementId: id }); else b.mode.execute('element.select', { elementId: null }).catch(() => {}); const i = id ? b.mode.state().selected : null; return b.tools.menu(i); };
const row = (menu) => Object.fromEntries(menu.map((t) => [t.id, t.enabled]));

test('the menu keeps the original editor tools in the original order, new ones after them', async () => {
  const b = await liveEditor();
  const ids = plain(b.tools.list().map((t) => t.id));
  assert.deepEqual(ids.slice(0, 17), GOLDEN_IDS);
  assert.deepEqual(ids.slice(17), EXTRA_IDS.concat(SCOPE_IDS));
  assert.equal(golden.menu_by_element.card.length, 17, 'the golden menu still has the 17 original tools');
  // contextual extras only appear where they make sense
  stack(b);
  const idsOn = (el) => plain(b.tools.menu(el).map((t) => t.id));
  /* the menu SHOWS them in the owner's order (see the next test); the registered order above stays the original editor's */
  const after = (ids) => ids.slice(OWNER_ORDER.length);
  assert.deepEqual(after(idsOn(null)), ['create_occasion', 'create_note', 'copy', 'archive', 'library_save', 'library_download', 'open'], 'an empty page: "دخول لصفحة" is listed (the owner asked for it in the menu) but no back / home');
  assert.deepEqual(after(idsOn({ dynamic: true })), ['create_occasion', 'create_note', 'copy', 'archive', 'library_save', 'library_download', 'size_preset', 'open']);
  const open = (el) => plain(b.tools.menu(el).find((t) => t.id === 'open'));
  assert.equal(open(null).label, 'دخول لصفحة');
  assert.equal(open(null).enabled, false, 'nothing to enter on an empty area');
  assert.equal(open({ dynamic: false }).enabled, false, 'a plain element has no page of its own');
  assert.equal(open({ dynamic: true }).enabled, true, 'a card, brand or store opens its page');
});

test('the menu shows text items first, then picture and video, banner, section, perfume card, brand, store, and the rest after them (owner, 2026-11-11)', async () => {
  const b = await liveEditor(); const els = stack(b);
  const card = els.find((e) => e.kind === 'card');
  const ids = (el) => plain(b.tools.menu(el).map((t) => t.id));
  for (const el of [null, menuFor(b, card.id) && b.mode.state().selected]) {
    const got = ids(el);
    assert.deepEqual(got.slice(0, OWNER_ORDER.length), OWNER_ORDER, 'the first twelve are the owner\'s order');
    const rest = got.slice(OWNER_ORDER.length), registered = plain(b.tools.list().map((t) => t.id)).filter((id) => !OWNER_ORDER.includes(id) && rest.includes(id));
    assert.deepEqual(rest, registered, 'the rest keep the order they were registered in');
  }
  const labels = plain(b.tools.menu(null).map((t) => t.label));
  assert.match(labels[0], /تعديل النص/); assert.match(labels[1], /تنسيق النص/);
  assert.match(labels[4], /رفع صورة/); assert.match(labels[6], /إنشاء صورة/); assert.match(labels[7], /بانر/);
  assert.match(labels[8], /سيكشن/); assert.match(labels[9], /كارت عطر/); assert.match(labels[10], /براند/); assert.match(labels[11], /متجر/);
  assert.equal(plain(b.tools.list().map((t) => t.id)).slice(0, 17).join(), GOLDEN_IDS.join(), 'the registered (original) order is untouched');
});

test('the mouse menu has no back / home entries even on an inner page: the header button replaced them, and still runs go_back', async () => {
  const b = await liveEditor(); stack(b);
  b.document.body.classList.add('inner');
  const labels = (el) => plain(b.tools.menu(el).map((t) => t.label));
  [null, { dynamic: true }, { dynamic: false }].forEach((el) => {
    const ids = plain(b.tools.menu(el).map((t) => t.id));
    assert.ok(!ids.includes('go_back') && !ids.includes('go_home'), 'no back / home id in the menu for ' + JSON.stringify(el));
    assert.ok(!labels(el).some((l) => /رجوع للصفحة/.test(l)), 'no back / home label in the menu for ' + JSON.stringify(el));
  });
  const registered = plain(b.tools.list().map((t) => t.id));
  assert.ok(registered.includes('go_back') && registered.includes('go_home'), 'the tools stay registered: the header button runs go_back through tool.run');
});

test('on a card, a title and the empty page the tools are enabled exactly as in the original editor', async () => {
  const b = await liveEditor(); const els = stack(b);
  const card = els.find((e) => e.kind === 'card'), title = els.find((e) => e.id === 'sec:brands:title');
  for (const [name, id, golden_type] of [['card', card.id, 'card'], ['title', title.id, 'text']]) {
    const got = GOLDEN_IDS.map((tid) => row(menuFor(b, id))[tid]);
    assert.deepEqual(got, flags(golden.menu_by_element[golden_type]), name + ' menu');
  }
  const empty = GOLDEN_IDS.map((tid) => row(b.tools.menu(null))[tid]);
  assert.deepEqual(empty, flags(golden.mouse.empty_area_menu), 'empty area menu: only the creation tools');
  assert.equal(row(b.tools.menu(null)).create_image, true);
});

test('a section is as in the original, except that it cannot be copied yet (its content comes from the catalogue)', async () => {
  const b = await liveEditor(); stack(b);
  const got = row(menuFor(b, 'sec:brands'));
  const want = flags(golden.menu_by_element.section);
  GOLDEN_IDS.forEach((tid, i) => { if (tid !== 'copy') assert.equal(got[tid], want[i], tid); });
  assert.equal(got.copy, false);
  assert.equal(got.edit_text, true, 'a section edits the text it owns: its title');
  assert.equal(b.mode.state().selected.textId, 'sec:brands:title');
});

test('text blocks, banners and images created by the editor follow the original rows', async () => {
  const b = await liveEditor(); stack(b);
  const made = {};
  for (const [name, opts] of [['text_block', { kind: 'text_block' }], ['banner', { kind: 'banner' }], ['image', { kind: 'image', src: '/assets/cards/a.webp' }]]) {
    made[name] = (await b.mode.execute('element.create', opts)).elementId;
    const got = GOLDEN_IDS.map((tid) => row(menuFor(b, made[name]))[tid]);
    assert.deepEqual(got, flags(golden.menu_by_element[name]), name);
  }
});

test('copying a card gives a banner with its title, text and picture right after its section, and undo removes it', async () => {
  const b = await liveEditor(); const els = stack(b);
  const card = els.find((e) => e.kind === 'card');
  const { elementId } = await b.mode.execute('element.duplicate', { elementId: card.id });
  const design = b.mode.state().design, copy = design.blocks.find((x) => x.id === elementId);
  assert.equal(copy.type, 'banner'); assert.equal(copy.title.ar, 'شانيل'); assert.equal(copy.subtitle.ar, 'وصف قصير'); assert.equal(copy.image, '/assets/cards/a.webp');
  assert.deepEqual(plain(design.order).slice(0, 3), ['brands', elementId, 'offers']);
  await b.mode.execute('history.undo');
  assert.equal(b.mode.state().design.blocks.length, 0);
  assert.ok(!b.mode.state().design.order || !b.mode.state().design.order.includes(elementId));
});

test('copying a title makes a text block with the same words; a section has nothing to copy', async () => {
  const b = await liveEditor(); stack(b);
  const { elementId } = await b.mode.execute('element.duplicate', { elementId: 'sec:offers:title' });
  const copy = b.mode.state().design.blocks.find((x) => x.id === elementId);
  assert.equal(copy.type, 'text'); assert.equal(copy.text.ar, 'عروض'); assert.ok(!copy.float);
  await assert.rejects(b.mode.execute('element.duplicate', { elementId: 'sec:offers' }), /نسخ العنصر ده مش متاح/);
});

test('"create text" is a free text and "create text block" is a block in the flow', async () => {
  const b = await liveEditor(); stack(b);
  const free = (await b.mode.execute('ui.openCreatePanel', { kind: 'text', at: { x: 40, y: 380 } })).elementId;
  const flow = (await b.mode.execute('ui.openCreatePanel', { kind: 'text_block', at: { x: 40, y: 380 } })).elementId;
  const blocks = b.mode.state().design.blocks, f = blocks.find((x) => x.id === free), l = blocks.find((x) => x.id === flow);
  assert.equal(f.type, 'text'); assert.equal(f.float, true);
  assert.equal(l.type, 'text'); assert.ok(!l.float);
  assert.ok(ED.normalize({ version: 1, blocks }, { strict: true }).ok, 'both are valid designs the server accepts');
  assert.equal(JSON.parse(ED.serialize(b.mode.state().design)).blocks.find((x) => x.id === free).float, true, 'the free text survives saving');
});

test('a block made at a click goes between the sections nearest to that point and the rest make room', async () => {
  const b = await liveEditor(); stack(b);
  const first = (await b.mode.execute('ui.openCreatePanel', { kind: 'text_block', at: { x: 40, y: 220 } })).elementId;   // top half of "offers"
  assert.deepEqual(plain(b.mode.state().design.order), ['brands', first, 'offers', 'new']);
  const second = (await b.mode.execute('ui.openCreatePanel', { kind: 'banner', at: { x: 40, y: 590 } })).elementId;        // bottom half of "new"
  assert.deepEqual(plain(b.mode.state().design.order), ['brands', first, 'offers', 'new', second]);
});

test('only a free text sits exactly where it was created', async () => {
  const b = await liveEditor(); stack(b);
  const free = (await b.mode.execute('ui.openCreatePanel', { kind: 'text', at: { x: 120, y: 420 } })).elementId;
  const flow = (await b.mode.execute('ui.openCreatePanel', { kind: 'text_block', at: { x: 120, y: 420 } })).elementId;
  const edits = b.mode.state().design.edits || {};
  const has = (id) => Object.values(edits).some((dev) => dev && dev[id] && (dev[id].dx !== undefined || dev[id].dy !== undefined));
  assert.equal(has(free), true, 'the free text is placed at the click');
  assert.equal(has(flow), false, 'the block takes its place in the flow, so nothing is offset');
});

test('the design schema keeps float only for a text block and never invents it', () => {
  const ok = (blocks) => ED.normalize({ version: 1, blocks }, { strict: true });
  assert.equal(ok([{ id: 'x-a', type: 'text', text: { ar: 'ن' }, float: true }]).design.blocks[0].float, true);
  assert.equal('float' in ok([{ id: 'x-a', type: 'text', text: { ar: 'ن' }, float: 'yes' }]).design.blocks[0], false, 'only true counts');
  assert.equal('float' in ok([{ id: 'x-a', type: 'text', text: { ar: 'ن' } }]).design.blocks[0], false);
  assert.equal('float' in ok([{ id: 'x-b', type: 'banner', title: { ar: 'ع' }, float: true }]).design.blocks[0], false, 'a banner is never free');
});

test('the storefront lays a free text over the page without giving it room in the flow', () => {
  const b = designBrowser(); stack(b);
  b.layer.set({ version: 1, blocks: [{ id: 'x-free', type: 'text', text: { ar: 'نص حر' }, float: true }, { id: 'x-flow', type: 'text', text: { ar: 'كتلة' } }], order: ['brands', 'x-free', 'x-flow', 'offers', 'new'] });
  const nodes = b.document.getElementById('main').children.filter((c) => c.hasAttribute && c.hasAttribute('data-elan-custom'));
  assert.equal(nodes.length, 2);
  assert.ok(nodes[0].classList.contains('elan-float'), 'the free text has a zero-height slot');
  assert.ok(!nodes[1].classList.contains('elan-float'));
  const entry = b.layer.elements().find((e) => e.id === 'x-free');
  assert.equal(entry.el.tagName, 'P', 'the text itself is what the editor selects and moves');
  assert.match(read('design-layer.js'), /\.elan-float\{position:relative;height:0/);
});

test('Esc, a left click or a scroll closes the right-click menu once; nothing is sent when it is not open', async () => {
  const b = await liveEditor(); stack(b);
  const fire = (type, ev) => (b.window.listeners[type] || []).forEach((fn) => fn(Object.assign({ target: {}, preventDefault() {}, stopPropagation() {} }, ev)));
  const closed = () => b.events.filter((e) => e[0] === 'close').length;
  fire('keydown', { key: 'Escape' }); fire('scroll', {});
  assert.equal(closed(), 0, 'no menu open, nothing to close');
  fire('contextmenu', { clientX: 5, clientY: 5 });
  assert.equal(b.events.filter((e) => e[0] === 'context').length, 1);
  fire('keydown', { key: 'Escape' }); assert.equal(closed(), 1);
  fire('keydown', { key: 'Escape' }); assert.equal(closed(), 1, 'already closed');
  fire('contextmenu', { clientX: 5, clientY: 5 }); fire('scroll', {}); assert.equal(closed(), 2);
  fire('contextmenu', { clientX: 5, clientY: 5 }); fire('pointerdown', { button: 0, clientX: 9, clientY: 9, pointerType: 'mouse' }); assert.equal(closed(), 3);
});

test('the editor window hides its menu on the close message and on Esc', () => {
  const host = read('editor/elan-editor.html'), bridge = read('elan-host-bridge.js');
  assert.match(bridge, /menuClose\(\)\{send\('menu-close',\{\}\);\}/);
  assert.match(host, /m\.type==='menu-close'\)\{menu\.style\.display='none';\}/);
  assert.match(host, /document\.addEventListener\('keydown',e=>\{if\(e\.key==='Escape'\)menu\.style\.display='none';\}\);/);
});

test('a free text belongs to the section it was created on, even from the upper half, and stays glued to it', async () => {
  const b = await liveEditor(); stack(b);
  const free = (await b.mode.execute('ui.openCreatePanel', { kind: 'text', at: { x: 40, y: 210 } })).elementId;   // upper half of "offers"
  assert.deepEqual(plain(b.mode.state().design.order), ['brands', 'offers', free, 'new'], 'right after offers, not before it');
  // a flow block created after "offers" goes after its free text, so the text keeps following offers
  const flow = (await b.mode.execute('ui.openCreatePanel', { kind: 'text_block', at: { x: 40, y: 480 } })).elementId; // lower half of "offers"
  assert.deepEqual(plain(b.mode.state().design.order), ['brands', 'offers', free, flow, 'new']);
  // copying a block that has a free text after it does the same
  const copy = (await b.mode.execute('element.duplicate', { elementId: flow })).elementId;
  assert.deepEqual(plain(b.mode.state().design.order), ['brands', 'offers', free, flow, copy, 'new']);
});

test('dragging a section takes the free texts laid over it along', () => {
  const editMode = read('edit-mode.js');
  assert.match(editMode, /Geometry\.reorderSticky\(order, moved, target, slot\.after, floats\)/);
  assert.match(editMode, /filter\(function \(b\) \{ return b\.float; \}\)/);
});
