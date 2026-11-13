'use strict';
/* Owner, 2026-11-12, in real Chromium: two sections placed side by side from the standard sizes must keep the platform's fixed gaps.
   1. a row puts its things side by side with exactly --elan-gap-x between them (the gap the platform leaves between its cards);
   2. the gap between a row and the one before it equals the gap with the one after it, and both equal --elan-gap-y, whatever the neighbours are (a banner, another row,
      a built-in section with its own padding), at a phone, a tablet and a laptop width;
   3. the same on the page itself in the editor: «ضعه في صف واحد جنب العنصر اللي فوقه» makes the row, «رجّعه في صف لوحده» undoes it, and the saved edit is only {beside}. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const banner = (id, t) => ({ id, type: 'banner', title: { ar: t } });
const ORDER = ['brands', 'offers', 'x-a', 'x-b', 'x-c', 'x-d', 'x-e', 'new', 'cats', 'master', 'notes', 'occ', 'soon', 'stores'];
/* a, b side by side (standard sizes); c alone; d and e side by side with no size at all; then the built-in sections go on */
const DESIGN = {
  version: 1, order: ORDER,
  blocks: [banner('x-a', 'أ'), banner('x-b', 'ب'), banner('x-c', 'ج'), banner('x-d', 'د'), banner('x-e', 'هـ')],
  edits: { all: { 'x-a': { w: 300, h: 120 }, 'x-b': { beside: 'x-a', w: 300, h: 120 }, 'x-e': { beside: 'x-d' } } }
};

const FLOAT_ONLY = { version: 1, blocks: [{ id: 'x-f', type: 'text', text: { ar: 'ف' }, float: true }] };
async function openStore(size, design) {
  const { context } = await H.openContext(browser, server, size);
  const page = await context.newPage();
  const errors = []; H.watchErrors(page, errors);
  await page.route('**/design/home.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(design) }));
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-elan-custom]') && window.ElanDesignLayer, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  return { context, page, errors };
}

/* what can be SEEN of every top-level thing: its box, and the room its own padding leaves empty above and below (the page's own measure, ElanDesignLayer.airOf) */
const measure = (page) => page.evaluate(() => {
  const L = window.ElanDesignLayer, main = document.getElementById('main');
  const box = (n) => { const r = n.getBoundingClientRect(); return { id: n.id || n.getAttribute('data-elan-id'), top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const rows = Array.from(main.children).filter((c) => getComputedStyle(c).display !== 'none' && !c.classList.contains('elan-float')).map((c) => {
    if (!c.hasAttribute('data-elan-row')) return { row: false, id: c.id || c.getAttribute('data-elan-id'), box: box(c), seenTop: box(c).top + L.airOf(c, true), seenBottom: box(c).bottom - L.airOf(c, false) };
    const members = Array.from(c.children).map((m) => ({ ...box(m), airT: L.airOf(m, true), airB: L.airOf(m, false) }));
    return { row: true, members, box: box(c), seenTop: Math.min(...members.map((m) => m.top + m.airT)), seenBottom: Math.max(...members.map((m) => m.bottom - m.airB)) };
  });
  const cs = getComputedStyle(document.documentElement);
  const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--elan-gap-x)'; document.body.appendChild(probe);
  const gapX = probe.getBoundingClientRect().width; probe.remove();
  return { rows, gapY: parseFloat(cs.getPropertyValue('--elan-gap-y')), gapX, cg: cs.getPropertyValue('--cg') };
});
const near = (a, b, why) => assert.ok(Math.abs(a - b) <= 1, why + ': ' + a + ' vs ' + b);

for (const size of H.WIDTHS) {
  test('rows keep the fixed gaps at a ' + size.name + ' width (' + size.width + 'px)', async () => {
    const { context, page, errors } = await openStore(size, DESIGN);
    try {
      const m = await measure(page);
      assert.ok(m.gapY > 0 && m.gapX > 0, 'the two gaps are defined by the platform: ' + JSON.stringify([m.gapY, m.gapX, m.cg]));
      const idx = (id) => m.rows.findIndex((r) => (r.row ? r.members.some((x) => x.id === id) : r.id === id));
      const ab = m.rows[idx('x-a')], de = m.rows[idx('x-d')];
      assert.ok(ab.row && ab.members.map((x) => x.id).join() === 'x-a,x-b' || ab.members.map((x) => x.id).join() === 'x-b,x-a', 'a and b are one row: ' + JSON.stringify(ab.members.map((x) => x.id)));
      assert.ok(de.row, 'd and e are one row');
      // 1. the horizontal gap between the two things of a row is the platform's gap, and they sit side by side on one line
      for (const r of [ab, de]) {
        const [p, q] = r.members.slice().sort((x, y) => x.left - y.left);
        near(q.left - p.right, m.gapX, 'horizontal gap in the row');
        near(p.top + p.airT, q.top + q.airT, 'the things of a row start at the same height');
      }
      // 2. every row is spaced from the one before it by the same fixed gap (what can be seen, not the boxes)
      const around = ['x-a', 'x-c', 'x-d'].map(idx);
      for (const i of around) {
        near(m.rows[i].seenTop - m.rows[i - 1].seenBottom, m.gapY, 'gap above row ' + i);
        near(m.rows[i + 1].seenTop - m.rows[i].seenBottom, m.gapY, 'gap below row ' + i);
      }
      // the built-in sections nobody touched keep exactly the gaps the page always had (a page with only a free text, which takes no room, is the page as it was)
      const base = await openStore(size, FLOAT_ONLY), before = await measure(base.page);
      await base.context.close();
      const gapsOf = (list) => { const g = {}; list.forEach((r, i) => { if (i && !r.row && /^[a-z]+$/.test(r.id) && !list[i - 1].row && /^[a-z]+$/.test(list[i - 1].id)) g[list[i - 1].id + '>' + r.id] = Math.round(r.seenTop - list[i - 1].seenBottom); }); return g; };
      const was = gapsOf(before.rows), now = gapsOf(m.rows);
      const same = Object.keys(now).filter((k) => k in was);
      assert.ok(same.length >= 4, 'there are untouched neighbours to compare: ' + JSON.stringify([was, now]));
      same.forEach((k) => near(now[k], was[k], 'natural gap ' + k));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('without any {beside} the rows engine leaves the page alone, and a page with a single extra block spaces it evenly', async () => {
  const design = { version: 1, order: ['brands', 'offers', 'x-a', 'new', 'cats', 'master', 'notes', 'occ', 'soon', 'stores'], blocks: [banner('x-a', 'أ')], edits: { all: { 'x-a': { w: 300, h: 120 } } } };
  const { context, page, errors } = await openStore(H.WIDTHS[0], design);
  try {
    const m = await measure(page);
    assert.equal(await page.locator('[data-elan-row]').count(), 0, 'no row without a {beside}');
    const i = m.rows.findIndex((r) => r.id === 'x-a');
    near(m.rows[i].seenTop - m.rows[i - 1].seenBottom, m.gapY, 'gap above the block');
    near(m.rows[i + 1].seenTop - m.rows[i].seenBottom, m.gapY, 'gap below the block');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a loop, a missing neighbour or a hidden one never breaks the page: those things are simply laid out one under the other', async () => {
  const design = { version: 1, order: ORDER, blocks: [banner('x-a', 'أ'), banner('x-b', 'ب'), banner('x-c', 'ج'), banner('x-d', 'د'), banner('x-e', 'هـ')],
    edits: { all: { 'x-a': { beside: 'x-b' }, 'x-b': { beside: 'x-a' }, 'x-c': { beside: 'x-nobody' }, 'x-e': { beside: 'x-d' }, 'x-d': { hidden: true } } } };
  const { context, page, errors } = await openStore(H.WIDTHS[2], design);
  try {
    assert.equal(await page.locator('[data-elan-row]').count(), 0, 'no row is made from a loop, a missing or a hidden neighbour');
    for (const id of ['x-a', 'x-b', 'x-c', 'x-e']) assert.equal(await page.locator('[data-elan-id="' + id + '"]').count(), 1, id + ' is still on the page');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a row shrinks standard sizes a little so the two fit with the fixed gap, and wraps nothing at a phone width', async () => {
  const design = { version: 1, order: ORDER, blocks: [banner('x-a', 'أ'), banner('x-b', 'ب')], edits: { all: { 'x-a': { w: 800, h: 100 }, 'x-b': { beside: 'x-a', w: 800, h: 100 } } } };
  const { context, page, errors } = await openStore(H.WIDTHS[0], design);
  try {
    const m = await measure(page), r = m.rows.find((x) => x.row);
    const [p, q] = r.members.slice().sort((x, y) => x.left - y.left);
    assert.ok(Math.abs(p.top - q.top) <= 1, 'still one line');
    assert.ok(p.left >= -1 && q.right <= H.WIDTHS[0].width + 1, 'inside the screen: ' + JSON.stringify([p.left, q.right]));
    near(q.left - p.right, m.gapX, 'the gap is kept');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

/* ---------- in the editor ---------- */
async function openEditor(size) {
  const { context } = await H.openContext(browser, server, size);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && window.ElanEditTools && document.getElementById('bar'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the editor opened the storefront preview');
  await page.waitForTimeout(1500);
  return { context, page, frame };
}
const savedEdit = (frame, id) => frame.evaluate((elementId) => { const st = window.ElanEditMode.state(), e = (st.design.edits || {}); const out = {}; Object.keys(e).forEach((dev) => { if (e[dev][elementId]) out[dev] = JSON.parse(JSON.stringify(e[dev][elementId])); }); return out; }, id);

test('in the editor: «ضعه في صف واحد جنب العنصر اللي فوقه» makes the row, the saved edit is only {beside}, and «رجّعه في صف لوحده» undoes it', async () => {
  const { context, page, frame } = await openEditor(H.WIDTHS[2]);
  try {
    const ids = await frame.evaluate(async () => {
      const mode = window.ElanEditMode, a = (await mode.execute('element.create', { kind: 'text_block' })).elementId, b = (await mode.execute('element.create', { kind: 'text_block' })).elementId;
      return [a, b];
    });
    await frame.evaluate(async (id) => { await window.ElanEditMode.execute('element.select', { elementId: id }); }, ids[1]);
    const tools = await frame.evaluate(() => window.ElanEditTools.menu(window.ElanEditMode.state().selected).map((t) => ({ id: t.id, label: t.label, enabled: t.enabled })));
    const join = tools.find((t) => t.id === 'row_join'), split = tools.find((t) => t.id === 'row_split');
    assert.ok(join && join.enabled, 'the join tool is in the menu and works: ' + JSON.stringify(tools.map((t) => t.id)));
    assert.ok(split && !split.enabled, 'the split tool is there but off while the element is alone');
    assert.equal(await frame.locator('[data-elan-row]').count(), 0);
    await frame.evaluate(async (id) => { await window.ElanEditMode.execute('tool.run', { id: 'row_join', elementId: id }); }, ids[1]);
    await page.waitForTimeout(400);
    assert.equal(await frame.locator('[data-elan-row]').count(), 1, 'one row on the page');
    assert.deepEqual(await frame.evaluate(() => Array.from(document.querySelector('[data-elan-row]').children).map((n) => n.getAttribute('data-elan-id'))), ids, 'the two are in it, in reading order');
    const saved = await savedEdit(frame, ids[1]);
    const keys = Object.keys(saved).reduce((all, dev) => all.concat(Object.keys(saved[dev])), []);
    assert.ok(keys.includes('beside') && !keys.includes('dx') && !keys.includes('dy'), 'saved as {beside} and no offset: ' + JSON.stringify(saved));
    const geo = await frame.evaluate(() => { const [p, q] = Array.from(document.querySelector('[data-elan-row]').children).map((n) => n.getBoundingClientRect()).sort((x, y) => x.left - y.left); const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--elan-gap-x)'; document.body.appendChild(probe); const g = probe.getBoundingClientRect().width; probe.remove(); return { gap: q.left - p.right, g, same: Math.abs(p.width - q.width) }; });
    assert.ok(Math.abs(geo.gap - geo.g) <= 1, 'the gap is the platform\'s: ' + JSON.stringify(geo));
    assert.ok(geo.same <= 1, 'with no size chosen the two share the row equally: ' + JSON.stringify(geo));
    const after = await frame.evaluate(() => window.ElanEditTools.menu(window.ElanEditMode.state().selected).filter((t) => t.id.startsWith('row_')).map((t) => [t.id, t.enabled]));
    assert.deepEqual(after, [['row_join', false], ['row_split', true]], 'join is off (already beside it), split is on');
    await frame.evaluate(async (id) => { await window.ElanEditMode.execute('tool.run', { id: 'row_split', elementId: id }); }, ids[1]);
    await page.waitForTimeout(400);
    assert.equal(await frame.locator('[data-elan-row]').count(), 0, 'the row is gone');
    assert.deepEqual(await savedEdit(frame, ids[1]), {}, 'nothing of the row is left in the saved design');
  } finally { await context.close(); }
});

test('in the editor: taking the first of three out of its row keeps the other two together, and a row never holds more than four', async () => {
  const { context, page, frame } = await openEditor(H.WIDTHS[2]);
  try {
    const ids = await frame.evaluate(async () => {
      const mode = window.ElanEditMode, out = [];
      for (let i = 0; i < 3; i++) out.push((await mode.execute('element.create', { kind: 'text_block' })).elementId);
      await mode.execute('tool.run', { id: 'row_join', elementId: out[1] });
      await mode.execute('tool.run', { id: 'row_join', elementId: out[2] });
      return out;
    });
    await page.waitForTimeout(300);
    assert.equal(await frame.evaluate(() => document.querySelector('[data-elan-row]').children.length), 3, 'three in one row');
    await frame.evaluate(async (id) => { await window.ElanEditMode.execute('tool.run', { id: 'row_split', elementId: id }); }, ids[0]);
    await page.waitForTimeout(300);
    const left = await frame.evaluate(() => Array.from(document.querySelector('[data-elan-row]').children).map((n) => n.getAttribute('data-elan-id')));
    assert.deepEqual(left, [ids[1], ids[2]], 'the other two stay a row: ' + JSON.stringify(left));
    // the fourth is refused: a row holds four
    const more = await frame.evaluate(async () => { const mode = window.ElanEditMode, out = []; for (let i = 0; i < 3; i++) out.push((await mode.execute('element.create', { kind: 'text_block' })).elementId); return out; });
    for (const id of more) await frame.evaluate(async (x) => { await window.ElanEditMode.execute('tool.run', { id: 'row_join', elementId: x }); }, id);
    await page.waitForTimeout(300);
    assert.ok(await frame.evaluate(() => document.querySelector('[data-elan-row]').children.length) <= 4, 'a row never holds more than four');
  } finally { await context.close(); }
});

/* a drag with real pointer events inside the page's frame (the editor listens on its window) */
const pointer = (frame, type, x, y, extra) => frame.evaluate(({ type, x, y, extra }) => {
  const target = document.elementFromPoint(x, y) || document.body;
  target.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1 }, extra || {})));
}, { type, x, y, extra });
async function drag(frame, from, to) {
  await pointer(frame, 'pointerdown', from.x, from.y);
  for (let i = 1; i <= 8; i++) await pointer(frame, 'pointermove', from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8);
  await pointer(frame, 'pointerup', to.x, to.y);
}
const centerOf = (frame, id) => frame.evaluate((elementId) => { const r = document.querySelector('[data-elan-id="' + elementId + '"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; }, id);

test('in the editor: dropping a section on the side of another one puts the two in a row; dropping it between others frees it again', async () => {
  const { context, page, frame } = await openEditor(H.WIDTHS[2]);
  try {
    const ids = await frame.evaluate(async () => {
      const mode = window.ElanEditMode, out = [];
      for (let i = 0; i < 3; i++) out.push((await mode.execute('element.create', { kind: 'text_block' })).elementId);
      for (const id of out) await mode.execute('element.resize', { elementId: id, w: 150, h: 110 });   // a standard size: narrower than the page (the editor shows the page at a phone width)
      return out;
    });
    await page.waitForTimeout(400);
    await frame.evaluate((id) => { const r = document.querySelector('[data-elan-id="' + id + '"]').getBoundingClientRect(); window.scrollTo({ top: scrollY + r.top - 90, behavior: 'instant' }); }, ids[0]);   // all three in view
    await page.waitForTimeout(300);
    const a = await centerOf(frame, ids[0]), c = await centerOf(frame, ids[2]);
    // drop the third one on the right edge of the first (the first one is not at the page's edge, the room beside it is its own width)
    await drag(frame, { x: c.x, y: c.y }, { x: a.right - 10, y: a.y });
    await page.waitForTimeout(500);
    const rows = await frame.evaluate(() => Array.from(document.querySelectorAll('[data-elan-row]')).map((r) => Array.from(r.children).map((n) => n.getAttribute('data-elan-id'))));
    assert.equal(rows.length, 1, 'one row was made: ' + JSON.stringify(rows));
    assert.deepEqual(rows[0].slice().sort(), [ids[0], ids[2]].sort(), 'the dropped one and the one it was dropped on');
    const saved = await savedEdit(frame, ids[2]), keys = Object.keys(saved).reduce((all, dev) => all.concat(Object.keys(saved[dev])), []);
    assert.ok(keys.includes('beside') || (await savedEdit(frame, ids[0]) && Object.keys(await savedEdit(frame, ids[0])).length), 'saved as a row: ' + JSON.stringify(saved));
    assert.ok(!keys.includes('dx') && !keys.includes('dy'), 'no offset is saved for it');
    const geo = await frame.evaluate((idList) => { const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--elan-gap-x)'; document.body.appendChild(probe); const g = probe.getBoundingClientRect().width; probe.remove(); const r = idList.map((id) => document.querySelector('[data-elan-id="' + id + '"]').getBoundingClientRect()).sort((x, y) => x.left - y.left); return { gap: r[1].left - r[0].right, g }; }, [ids[0], ids[2]]);
    assert.ok(Math.abs(geo.gap - geo.g) <= 1, 'the gap between them is the platform\'s: ' + JSON.stringify(geo));
    // the second one (still alone) is spaced from the row by the fixed gap
    const m = await frame.evaluate((alone) => { const L = window.ElanDesignLayer, row = document.querySelector('[data-elan-row]'), el = document.querySelector('[data-elan-id="' + alone + '"]'); const vis = (n) => ({ top: n.getBoundingClientRect().top + L.airOf(n, true), bottom: n.getBoundingClientRect().bottom - L.airOf(n, false) }); const members = Array.from(row.children).map(vis); const rowBottom = Math.max(...members.map((x) => x.bottom)), rowTop = Math.min(...members.map((x) => x.top)); return { before: row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING ? el.getBoundingClientRect().top - rowBottom : rowTop - el.getBoundingClientRect().bottom, gapY: L.gapY() }; }, ids[1]);
    assert.ok(Math.abs(m.before - m.gapY) <= 1.5, 'the row and its neighbour are one fixed gap apart: ' + JSON.stringify(m));
    // dragging one out of the row to a place between other things frees it
    const rowNow = await frame.evaluate(() => Array.from(document.querySelector('[data-elan-row]').children).map((n) => n.getAttribute('data-elan-id')));
    const out = rowNow[0] === ids[0] ? ids[2] : rowNow[0];
    const alone = await centerOf(frame, ids[1]), moving = await centerOf(frame, out);
    await drag(frame, { x: moving.x, y: moving.y }, { x: alone.x, y: alone.bottom - 4 });
    await page.waitForTimeout(500);
    assert.equal(await frame.locator('[data-elan-row]').count(), 0, 'dropped between others: it is out of the row and the row is gone');
  } finally { await context.close(); }
});
