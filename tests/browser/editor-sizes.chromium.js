'use strict';
/* Dimensions of elements, in relative terms only (owner, 2026-11-10): the right-click item «أبعاد العناصر» opens the common shapes (1:1, 4:3, 9:16, 16:9… as examples) and
   the chosen element takes the shape; creating a text block or a text asks the same way; dragging the corner handle goes by saved relative sizes («نص العرض»…) with the
   element's own shape and the size written beside the pointer, never a free size. Real Chromium, real editor: the menu entry, the window, the size drawn in the storefront
   preview, one undo step, and the phone. (The panels that have their own «أبعاد…» field are checked in panels.chromium.js.) */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const G = require('../../editor/editor-geometry.js');

const pw = H.loadPlaywright();
const LAPTOP = H.WIDTHS.find((w) => w.name === 'laptop') || H.WIDTHS[H.WIDTHS.length - 1];
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];
const STEP_NAMES = G.STEPS.map((s) => s.name);

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

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

/* The right-click menu of the live editor for `id` (or the empty page), opened the way the preview opens it. */
async function openMenu(page, frame, id) {
  const tools = await frame.evaluate((elementId) => {
    const mode = window.ElanEditMode;
    const info = elementId ? mode.state().selected : null;
    return window.ElanEditTools.menu(info);
  }, id || null);
  await page.evaluate(({ tools: list, elementId }) => { showLiveMenu({ element: elementId ? { id: elementId, tools: list } : null, tools: list, x: 60, y: 120 }); }, { tools, elementId: id || null });
}
const menuItem = (page, text) => page.locator('#menu button', { hasText: text });
const chooser = (page) => page.locator('#elanSizeDlg');
const shapeButton = (page, ratio) => page.locator('#elanSizeDlg .grid button').filter({ has: page.locator('.dim', { hasText: new RegExp('^' + ratio + '$') }) });

const sizeOf = (frame, id) => frame.evaluate((elementId) => {
  const entry = window.ElanDesignLayer.elements().find((e) => e.id === elementId);
  if (!entry) return null;
  const r = entry.el.getBoundingClientRect(), box = entry.el.parentElement;
  return { w: Math.round(r.width), h: Math.round(r.height), room: box ? box.clientWidth : 0, vw: innerWidth, left: Math.round(r.left), right: Math.round(r.right) };
}, id);
/* the room the page measures for the element's box (its content width), the same way edit-mode.js does */
const roomOf = (frame, id) => frame.evaluate((elementId) => {
  const box = window.ElanDesignLayer.elements().find((e) => e.id === elementId).el.parentElement, cs = getComputedStyle(box);
  return box.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}, id);
const lastBlock = (frame) => frame.evaluate(() => { const b = window.ElanEditMode.state().design.blocks; return b.length ? b[b.length - 1].id : null; });
/* the local store already holds a design with blocks of its own, so every count is compared with the count before */
const blockCount = (frame) => frame.evaluate(() => window.ElanEditMode.state().design.blocks.length);
const withoutW = (frame, id) => frame.evaluate((elementId) => { const e = window.ElanEditMode.state().design.edits || {}; return Object.keys(e).every((d) => !(e[d][elementId] && (e[d][elementId].w || e[d][elementId].h))); }, id);

async function createWithShape(page, frame, ratio) {
  await openMenu(page, frame, null);
  await menuItem(page, 'إنشاء كتلة نصية').click();
  await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
  await shapeButton(page, ratio).click();
  await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(500);
  return lastBlock(frame);
}

test('the dimensions window lists the common shapes only (no pixel sizes), automatic first, each drawn as a little shape; a shape picked before creating is the shape the new block has (laptop)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const before = await blockCount(frame);
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const lay = await page.evaluate(() => {
      const dlg = document.getElementById('elanSizeDlg'), first = dlg.querySelector('button');
      return { title: dlg.querySelector('h3').textContent, first: first.textContent.trim(), firstClass: first.className, focused: document.activeElement === first,
        headings: dlg.querySelectorAll('h4').length, dims: Array.from(dlg.querySelectorAll('.grid .dim')).map((e) => e.textContent), drawings: dlg.querySelectorAll('.grid .shape').length,
        pixels: /\d+\s*[×x]\s*\d+/.test(dlg.textContent.replace(/\d+:\d+/g, '')), rtl: getComputedStyle(dlg).direction, inView: dlg.getBoundingClientRect().right <= innerWidth && dlg.getBoundingClientRect().left >= 0 };
    });
    assert.equal(lay.title, 'أبعاد الكتلة النصية');
    assert.equal(lay.first, 'تلقائي (المقاس الافتراضي)', 'automatic is the first choice');
    assert.equal(lay.firstClass, 'auto'); assert.ok(lay.focused, 'and has the focus, so Enter takes it');
    assert.equal(lay.headings, 0, 'one list, no groups to hunt through');
    ['1:1', '4:3', '9:16', '16:9', '3:2', '4:5'].forEach((n) => assert.ok(lay.dims.includes(n), n + ' is offered: ' + lay.dims.join(' ')));
    assert.equal(lay.dims.length, G.RATIOS.length); assert.equal(lay.drawings, lay.dims.length, 'a little drawing with the shape of each');
    assert.equal(lay.pixels, false, 'no pixel numbers anywhere in the window');
    assert.equal(lay.rtl, 'rtl'); assert.ok(lay.inView, 'inside the window');
    const wide = shapeButton(page, '16:9');
    const drawn = await wide.locator('.shape').evaluate((e) => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
    assert.ok(Math.abs(drawn.w / drawn.h - 16 / 9) < 0.2 && Math.max(drawn.w, drawn.h) === 28, 'a 16:9 drawing: ' + JSON.stringify(drawn));
    await wide.click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.ok(s.w <= s.room && Math.abs(s.h - s.w * 9 / 16) <= 1.5, 'a 16:9 block inside its box: ' + JSON.stringify(s));
    await frame.evaluate(async () => { await window.ElanEditMode.execute('history.undo', {}); });
    assert.equal(await blockCount(frame), before, 'one undo step took the block away with its shape');
  } finally { await context.close(); }
});

test('Enter takes "automatic" (no fixed size) and Esc or the cancel button creates nothing', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const before = await blockCount(frame);
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Enter');
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(400);
    assert.equal(await blockCount(frame), before + 1, 'Enter created the block');
    assert.ok(await withoutW(frame, await lastBlock(frame)), 'with no fixed size');

    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#elanSizeDlg .foot button').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(300);
    assert.equal(await blockCount(frame), before + 1, 'closing the window without choosing creates nothing');
  } finally { await context.close(); }
});

test('right-click on an element: «أبعاد العناصر» opens the shapes, the element takes the one chosen keeping its width, and "back to the original" gives its own size back (laptop)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const id = await lastBlock(frame);
    const natural = await sizeOf(frame, id);
    await frame.evaluate(async (elementId) => { await window.ElanEditMode.execute('element.select', { elementId }); }, id);
    await openMenu(page, frame, id);
    await menuItem(page, 'أبعاد العناصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await page.locator('#elanSizeDlg h3').textContent()).trim(), 'أبعاد العناصر');
    assert.equal((await page.locator('#elanSizeDlg button.auto').textContent()).trim(), 'رجوع للأبعاد الأصلية');
    await shapeButton(page, '1:1').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    let s = await sizeOf(frame, id);
    assert.ok(Math.abs(s.w - natural.w) <= 1 && Math.abs(s.h - s.w) <= 1, 'a square with the width it had: ' + JSON.stringify([natural, s]));

    await openMenu(page, frame, id);
    await menuItem(page, 'أبعاد العناصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await shapeButton(page, '9:16').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    s = await sizeOf(frame, id);
    assert.ok(Math.abs(s.w - natural.w) <= 1 && Math.abs(s.h - s.w * 16 / 9) <= 2, 'and a tall one, same width: ' + JSON.stringify(s));

    await openMenu(page, frame, id);
    await menuItem(page, 'أبعاد العناصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#elanSizeDlg button.auto').click();
    await page.waitForTimeout(500);
    s = await sizeOf(frame, id);
    assert.deepEqual({ w: s.w, h: s.h }, { w: natural.w, h: natural.h }, 'the original size is back: ' + JSON.stringify(s));
  } finally { await context.close(); }
});

test('the corner handle goes by saved relative sizes only: it rests on one (named beside the pointer), goes on to the next or back to the one before, keeps the shape, and never lands on a free size (laptop)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const id = await createWithShape(page, frame, '16:9');
    await frame.evaluate(async (elementId) => { await window.ElanEditMode.execute('element.select', { elementId }); }, id);
    await frame.evaluate((elementId) => { window.ElanDesignLayer.elements().find((e) => e.id === elementId).el.scrollIntoView({ block: 'center' }); }, id);
    await page.waitForTimeout(900);
    const room = await roomOf(frame, id), steps = G.widthSteps(room);
    const start = await sizeOf(frame, id), startShape = start.w / start.h;
    const labelOf = () => frame.evaluate(() => { const l = document.querySelector('.eo-size'), r = l.getBoundingClientRect(); return { text: l.textContent, shown: getComputedStyle(l).display !== 'none', inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
    assert.equal((await labelOf()).shown, false, 'no label before a drag');

    const aim = await (async () => {   // the page scrolls smoothly: wait until the handle stops moving; the handle sits on the corner that moves (bottom-left on an Arabic page) and is pulled inside the screen for a full-width element
      let handle = null;
      for (let i = 0; i < 40; i++) {
        const now = await frame.evaluate(() => { const r = document.querySelector('.eo-h').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        if (handle && Math.abs(now.y - handle.y) < 0.5 && Math.abs(now.x - handle.x) < 0.5) { handle = now; break; }
        handle = now; await page.waitForTimeout(150);
      }
      const box = await page.locator('iframe').first().boundingBox(), k = box.width / (await frame.evaluate(() => innerWidth));
      return { x: (dx) => box.x + (handle.x + dx) * k, y: (dy) => box.y + (handle.y + dy) * k, k };
    })();

    const seen = [];   // [pointer shift in page pixels, label, width] at every pause
    await page.mouse.move(aim.x(0), aim.y(0)); await page.mouse.down();
    let at = 0;
    for (const target of [-30, -70, -110, -150, -190, -230, -190, -150, -110, -70, -30, 0]) {
      const dir = target < at ? -1 : 1;
      for (let x = at; dir < 0 ? x > target : x < target; x += dir * 5) await page.mouse.move(aim.x(-x), aim.y(Math.round(x * start.h / start.w)));   // up and to the right = smaller
      await page.mouse.move(aim.x(-target), aim.y(Math.round(target * start.h / start.w))); at = target;
      await page.waitForTimeout(120);
      const label = await labelOf(), s = await sizeOf(frame, id);
      seen.push({ at: target, label: label.text, w: s.w, h: s.h, shown: label.shown, inView: label.inView });
    }
    await page.mouse.up(); await page.waitForTimeout(250);
    const done = await sizeOf(frame, id);

    seen.forEach((p) => {
      assert.ok(p.shown && p.inView, 'the size is written beside the pointer, inside the window: ' + JSON.stringify(p));
      assert.ok(STEP_NAMES.some((n) => p.label.startsWith(n)), 'it is the name of a saved size: ' + p.label);
      const step = steps.find((st) => p.label.startsWith(st.name));
      assert.ok(Math.abs(p.w - step.w) <= 1, 'the width is that saved size (' + step.name + ' = ' + step.w + '): ' + JSON.stringify(p));
      assert.ok(Math.abs(p.w / p.h - startShape) < 0.06, 'the shape of the element stays: ' + JSON.stringify(p));
    });
    const widths = [...new Set(seen.map((p) => p.w))];
    assert.ok(widths.length >= 4, 'pulling on passes through several saved sizes, one after the other: ' + JSON.stringify(seen.map((p) => p.label)));
    const going = seen.slice(0, 6).map((p) => p.w), coming = seen.slice(6).map((p) => p.w);
    assert.ok(going.every((w, i) => i === 0 || w <= going[i - 1]), 'pulling in only ever goes to smaller sizes: ' + going);
    assert.ok(coming.every((w, i) => i === 0 || w >= coming[i - 1]), 'and pulling back out to bigger ones: ' + coming);
    assert.deepEqual(seen[4].w, seen[6].w, 'back over the same point it is on the same saved size');
    assert.equal((await labelOf()).shown, false, 'the label goes away when the mouse is let go');
    assert.ok(steps.some((st) => Math.abs(st.w - done.w) <= 1), 'what is left is a saved size: ' + JSON.stringify([done, steps.map((st) => st.w)]));
    const saved = await frame.evaluate((elementId) => { const e = window.ElanEditMode.state().design.edits, dev = window.ElanEditMode.state().device; return e[dev][elementId]; }, id);
    assert.ok(Math.abs(saved.w - done.w) <= 1 && Math.abs(saved.h - done.h) <= 1, 'and that is what is saved: ' + JSON.stringify([saved, done]));
  } finally { await context.close(); }
});

test('on a phone the dimensions window fits the screen, and a shape on a block keeps it inside the screen', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const dlg = await page.evaluate(() => {
      const d = document.getElementById('elanSizeDlg'), r = d.getBoundingClientRect();
      const out = Array.from(d.querySelectorAll('.grid button')).filter((b) => { const q = b.getBoundingClientRect(); return q.width && (q.left < r.left - 1 || q.right > r.right + 1); }).length;
      return { left: r.left, right: r.right, width: innerWidth, overflowing: out, sideways: d.scrollWidth > d.clientWidth + 1 };
    });
    assert.ok(dlg.left >= 0 && dlg.right <= dlg.width, 'the window fits the phone screen: ' + JSON.stringify(dlg));
    assert.equal(dlg.overflowing, 0, 'no shape sticks out'); assert.ok(!dlg.sideways, 'no sideways scroll');
    await shapeButton(page, '21:9').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(600);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.ok(s.w <= s.room && s.left >= 0 && s.right <= s.vw, 'inside the screen: ' + JSON.stringify(s));
    assert.ok(Math.abs(s.w / s.h - 21 / 9) < 0.1, 'with the shape of 21:9: ' + JSON.stringify(s));
    const saved = await frame.evaluate((elementId) => { const e = window.ElanEditMode.state().design.edits, out = {}; Object.keys(e).forEach((d) => { if (e[d][elementId]) out[d] = e[d][elementId]; }); return out; }, id);
    assert.deepEqual(Object.keys(saved), [await frame.evaluate(() => window.ElanEditMode.state().device)], 'saved for the phone size only: ' + JSON.stringify(saved));
  } finally { await context.close(); }
});
