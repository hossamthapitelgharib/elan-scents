'use strict';
/* Standard sizes for elements (owner, 2026-11-08): choosing "create text block / banner / text / image" from the menu opens a list of saved world-standard sizes
   (first choice "automatic"), and a chosen element has a "standard size" entry too; the free drag handle stays. Real Chromium, real editor: the menu entry, the
   chooser window, the size drawn in the storefront preview, one undo step, and the phone scaling a wide size to the screen. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const LAPTOP = H.WIDTHS.find((w) => w.name === 'laptop') || H.WIDTHS[H.WIDTHS.length - 1];
const PHONE = H.WIDTHS.find((w) => w.name === 'phone') || H.WIDTHS[0];

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
const sizeButton = (page, dim) => page.locator('#elanSizeDlg button', { hasText: dim });

const sizeOf = (frame, id) => frame.evaluate((elementId) => {
  const entry = window.ElanDesignLayer.elements().find((e) => e.id === elementId);
  if (!entry) return null;
  const r = entry.el.getBoundingClientRect(), box = entry.el.parentElement;
  return { w: Math.round(r.width), h: Math.round(r.height), room: box ? box.clientWidth : 0, vw: innerWidth, left: Math.round(r.left), right: Math.round(r.right) };
}, id);
const lastBlock = (frame) => frame.evaluate(() => { const b = window.ElanEditMode.state().design.blocks; return b.length ? b[b.length - 1].id : null; });
/* the local store already holds a design with blocks of its own, so every count is compared with the count before */
const blockCount = (frame) => frame.evaluate(() => window.ElanEditMode.state().design.blocks.length);
const withoutW = (frame, id) => frame.evaluate((elementId) => { const e = window.ElanEditMode.state().design.edits || {}; return Object.keys(e).every((d) => !(e[d][elementId] && (e[d][elementId].w || e[d][elementId].h))); }, id);

test('the chooser lists the saved groups, automatic first, and a size picked before creating is the size the new block has (laptop)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const before = await blockCount(frame);
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const lay = await page.evaluate(() => {
      const dlg = document.getElementById('elanSizeDlg'), first = dlg.querySelector('button');
      return { first: first.textContent.trim(), firstClass: first.className, focused: document.activeElement === first, groups: Array.from(dlg.querySelectorAll('h4')).map((h) => h.textContent),
        count: dlg.querySelectorAll('.grid button').length, rtl: getComputedStyle(dlg).direction, inView: dlg.getBoundingClientRect().right <= innerWidth && dlg.getBoundingClientRect().left >= 0 };
    });
    assert.equal(lay.first, 'تلقائي (المقاس الافتراضي)', 'automatic is the first choice');
    assert.equal(lay.firstClass, 'auto'); assert.ok(lay.focused, 'and has the focus, so Enter takes it');
    assert.deepEqual(lay.groups, ['نسب شائعة (أمثلة)', 'بانرات الويب (IAB)', 'سوشيال ميديا', 'شاشات وأجهزة', 'ورق الطباعة (96 نقطة/بوصة)']);
    assert.ok(lay.count >= 20, 'the saved sizes are listed: ' + lay.count);
    assert.equal(lay.rtl, 'rtl'); assert.ok(lay.inView, 'inside the window');
    await sizeButton(page, '300 × 250').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.deepEqual({ w: s.w, h: s.h }, { w: 300, h: 250 }, 'drawn at the standard size: ' + JSON.stringify(s));
    // one undo takes the new block away with its size
    await frame.evaluate(async () => { await window.ElanEditMode.execute('history.undo', {}); });
    assert.equal(await blockCount(frame), before, 'one undo step took the block away with its size');
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

test('a chosen element can be given a standard size, drag-resized with the mouse as before, and given its original size back (laptop)', async () => {
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
    await menuItem(page, 'مقاس قياسي للعنصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal((await page.locator('#elanSizeDlg button.auto').textContent()).trim(), 'رجوع للمقاس الأصلي');
    await sizeButton(page, '336 × 280').click();
    await page.waitForTimeout(500);
    let s = await sizeOf(frame, id);
    assert.deepEqual({ w: s.w, h: s.h }, { w: 336, h: 280 }, JSON.stringify(s));

    // the corner handle still resizes freely with the left mouse button (the new block is at the end of the page: bring it into the window first)
    await frame.evaluate((elementId) => { window.ElanDesignLayer.elements().find((e) => e.id === elementId).el.scrollIntoView({ block: 'center' }); }, id);
    // the page scrolls smoothly: wait until the handle stops moving before aiming at it
    let handle = null;
    for (let i = 0; i < 40; i++) {
      const now = await frame.evaluate(() => { const r = document.querySelector('.eo-h').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (handle && Math.abs(now.y - handle.y) < 0.5 && Math.abs(now.x - handle.x) < 0.5) { handle = now; break; }
      handle = now; await page.waitForTimeout(150);
    }
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / (await frame.evaluate(() => innerWidth));
    await page.mouse.move(box.x + handle.x * k, box.y + handle.y * k);
    await page.mouse.down();
    await page.mouse.move(box.x + (handle.x + 40) * k, box.y + (handle.y + 30) * k, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const dragged = await sizeOf(frame, id);
    assert.ok(dragged.w !== 336 || dragged.h !== 280, 'the handle changed the size: ' + JSON.stringify(dragged));

    // and back to the original size
    await openMenu(page, frame, id);
    await menuItem(page, 'مقاس قياسي للعنصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#elanSizeDlg button.auto').click();
    await page.waitForTimeout(500);
    s = await sizeOf(frame, id);
    assert.deepEqual({ w: s.w, h: s.h }, { w: natural.w, h: natural.h }, 'the original size is back: ' + JSON.stringify(s));
  } finally { await context.close(); }
});

test('on a phone a wide standard size is scaled to the screen keeping its shape, and is saved for that screen size only', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const dlg = await page.evaluate(() => { const r = document.getElementById('elanSizeDlg').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; });
    assert.ok(dlg.left >= 0 && dlg.right <= dlg.width, 'the chooser fits the phone window: ' + JSON.stringify(dlg));
    await sizeButton(page, '728 × 90').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(600);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.ok(s.w < 728 && s.w <= s.room, 'narrower than the 728 asked for, inside its box: ' + JSON.stringify(s));
    assert.ok(s.left >= 0 && s.right <= s.vw, 'and inside the screen: ' + JSON.stringify(s));
    assert.ok(Math.abs(s.w / s.h - 728 / 90) < 0.5, 'with the shape of 728x90: ' + JSON.stringify(s));
    const saved = await frame.evaluate((elementId) => { const e = window.ElanEditMode.state().design.edits, out = {}; Object.keys(e).forEach((d) => { if (e[d][elementId]) out[d] = e[d][elementId]; }); return out; }, id);
    assert.deepEqual(Object.keys(saved), [await frame.evaluate(() => window.ElanEditMode.state().device)], 'saved for the phone size only: ' + JSON.stringify(saved));
  } finally { await context.close(); }
});

/* "مقاساتي" (owner, 2026-11-09): an own size is saved next to the standard ones, shown first the next time, usable at once, deletable, and kept in the design. */
const addRow = (page) => page.locator('#elanSizeDlg details.mine-add');
async function openAddRow(page) {
  await page.locator('#elanSizeDlg details.mine-add summary').click();
  await page.locator('#elanSizeDlg details.mine-add input').first().waitFor({ state: 'visible', timeout: 10000 });
}
const mineOf = (frame) => frame.evaluate(() => window.ElanEditMode.state().design.mySizes || []);

test('an own size is saved from the chooser (Enter works), listed first as «مقاساتي», used to create a block, and can be deleted (laptop)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const before = await blockCount(frame), mineBefore = (await mineOf(frame)).length;
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(!(await addRow(page).evaluate((d) => d.open)), 'the add row is folded until asked for');
    await openAddRow(page);
    const inputs = page.locator('#elanSizeDlg details.mine-add input');
    await inputs.nth(0).fill('360'); await inputs.nth(1).fill('240'); await inputs.nth(2).fill('بانر العروض');
    await inputs.nth(2).press('Enter');
    await page.waitForFunction(() => document.querySelector('#elanSizeDlg h4') && document.querySelector('#elanSizeDlg h4').textContent === 'مقاساتي', null, { timeout: 10000 });
    assert.ok(await chooser(page).isVisible(), 'Enter saved the size and the window stayed open');
    assert.equal(await blockCount(frame), before, 'saving a size created nothing');
    const lay = await page.evaluate(() => {
      const dlg = document.getElementById('elanSizeDlg'), r = dlg.getBoundingClientRect(), first = dlg.querySelector('h4 + .grid .cell');
      return { first: first ? first.textContent.replace(/\s+/g, ' ').trim() : '', del: !!(first && first.querySelector('button.del')), status: dlg.querySelector('.msg').textContent, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, cleared: Array.from(dlg.querySelectorAll('details.mine-add input')).every((i) => i.value === '') };
    });
    assert.match(lay.first, /360 × 240/); assert.match(lay.first, /بانر العروض/); assert.ok(lay.del, 'with a delete button'); assert.ok(lay.cleared, 'the fields are emptied for the next one');
    assert.match(lay.status, /اتحفظ/); assert.ok(lay.inView, 'the window still fits the screen');
    const mine = await mineOf(frame);
    assert.equal(mine.length, mineBefore + 1); assert.deepEqual(mine[mine.length - 1], { w: 360, h: 240, name: 'بانر العروض' }, 'part of the design in the page');

    // a wrong size is refused in the window without closing it
    await inputs.nth(0).fill('10'); await inputs.nth(1).fill('10'); await inputs.nth(1).press('Enter');
    await page.waitForTimeout(300);
    assert.match(await page.locator('#elanSizeDlg .msg').textContent(), /40/); assert.equal((await mineOf(frame)).length, mineBefore + 1, 'nothing saved');

    // the saved size makes a block of exactly that size (the preview is phone-wide, so a size that fits it)
    await page.locator('#elanSizeDlg .cell button:not(.del)', { hasText: '360 × 240' }).click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.deepEqual({ w: s.w, h: s.h }, { w: 360, h: 240 }, JSON.stringify(s));

    // the next time the chooser opens it is there first, and a delete takes it away
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#elanSizeDlg h4')).map((h) => h.textContent));
    assert.equal(groups[0], 'مقاساتي'); assert.equal(groups.length, 6);
    await page.locator('#elanSizeDlg .cell button.del').last().click();
    await page.waitForFunction((n) => (window.__x = 1) && document.querySelectorAll('#elanSizeDlg h4').length === n, mineBefore === 0 ? 5 : 6, { timeout: 10000 });
    assert.equal((await mineOf(frame)).length, mineBefore, 'deleted from the design too');
    await page.keyboard.press('Escape');
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
  } finally { await context.close(); }
});

test('the own-size form fits a phone window and saves there too', async () => {
  const { context, page, frame } = await openEditor(PHONE);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await openAddRow(page);
    const inputs = page.locator('#elanSizeDlg details.mine-add input');
    await inputs.nth(0).fill('320'); await inputs.nth(1).fill('180');
    await page.locator('#elanSizeDlg button.keep').click();
    await page.waitForFunction(() => document.querySelector('#elanSizeDlg h4') && document.querySelector('#elanSizeDlg h4').textContent === 'مقاساتي', null, { timeout: 10000 });
    const fit = await page.evaluate(() => {
      const dlg = document.getElementById('elanSizeDlg'), r = dlg.getBoundingClientRect();
      const out = Array.from(dlg.querySelectorAll('details.mine-add input, button.keep, .cell')).filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 1 || b.right > r.right + 1); }).length;
      return { inView: r.left >= 0 && r.right <= innerWidth, overflowing: out, scrollX: dlg.scrollWidth > dlg.clientWidth + 1 };
    });
    assert.ok(fit.inView, 'inside the phone window: ' + JSON.stringify(fit)); assert.equal(fit.overflowing, 0, 'nothing sticks out: ' + JSON.stringify(fit)); assert.ok(!fit.scrollX, 'no sideways scroll: ' + JSON.stringify(fit));
    await page.locator('#elanSizeDlg .cell button:not(.del)').first().click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame), s = await sizeOf(frame, id);
    assert.ok(s.w <= s.room && s.left >= 0 && s.right <= s.vw, 'fits the screen: ' + JSON.stringify(s));
    assert.ok(Math.abs(s.w / s.h - 320 / 180) < 0.2, 'with its shape: ' + JSON.stringify(s));
  } finally { await context.close(); }
});

/* The corner handle (owner suggestion, 2026-11-09): a label beside the pointer shows the size being made, and Shift keeps the shape. */
async function aimHandle(page, frame) {
  await frame.evaluate(() => { document.querySelector('.eo-h').scrollIntoView({ block: 'center' }); });
  let handle = null;
  for (let i = 0; i < 40; i++) {   // the page scrolls smoothly: wait until the handle stops moving
    const now = await frame.evaluate(() => { const r = document.querySelector('.eo-h').getBoundingClientRect(); return { x: r.left + 2, y: r.top + r.height / 2 }; });   // the inner part: at the right edge of a full-width element the preview clips the last pixels
    if (handle && Math.abs(now.y - handle.y) < 0.5 && Math.abs(now.x - handle.x) < 0.5) { handle = now; break; }
    handle = now; await page.waitForTimeout(150);
  }
  const box = await page.locator('iframe').first().boundingBox(), k = box.width / (await frame.evaluate(() => innerWidth));
  return { x: (dx, dy) => box.x + (handle.x + dx) * k, y: (dx, dy) => box.y + (handle.y + dy) * k, k };
}
const labelOf = (frame) => frame.evaluate(() => {
  const l = document.querySelector('.eo-size'), r = l.getBoundingClientRect();
  return { text: l.textContent, shown: getComputedStyle(l).display !== 'none', inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
});

test('dragging the corner shows the size being made beside the pointer, and Shift keeps the shape (also when pressed or let go mid-drag)', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await sizeButton(page, '300 × 250').click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame);
    await frame.evaluate(async (elementId) => { await window.ElanEditMode.execute('element.select', { elementId }); }, id);
    await frame.evaluate((elementId) => { window.ElanDesignLayer.elements().find((e) => e.id === elementId).el.scrollIntoView({ block: 'center' }); }, id);
    await page.waitForTimeout(900);
    assert.equal((await labelOf(frame)).shown, false, 'no label before a drag');

    // 1. free drag: the label reads the size, the sides move on their own
    let aim = await aimHandle(page, frame);
    await page.mouse.move(aim.x(0, 0), aim.y(0, 0)); await page.mouse.down();
    await page.mouse.move(aim.x(60, 0), aim.y(60, 0), { steps: 8 });
    await page.waitForTimeout(150);
    let label = await labelOf(frame), s = await sizeOf(frame, id);
    assert.ok(label.shown && label.inView, 'the label is shown inside the window: ' + JSON.stringify(label));
    assert.ok(label.text.startsWith(s.w + ' × ' + s.h), 'it reads the real size: ' + label.text + ' vs ' + JSON.stringify(s));
    assert.ok(s.w > 300 && Math.abs(s.h - 250) <= 1, 'free: wider, same height: ' + JSON.stringify(s));
    await page.mouse.up(); await page.waitForTimeout(200);
    assert.equal((await labelOf(frame)).shown, false, 'the label goes away when the mouse is let go');

    // 2. Shift held for the whole drag: the shape of the start (here the free-dragged one) stays
    const start = await sizeOf(frame, id), startRatio = start.w / start.h;
    aim = await aimHandle(page, frame);
    await page.mouse.move(aim.x(0, 0), aim.y(0, 0)); await page.keyboard.down('Shift'); await page.mouse.down();
    await page.mouse.move(aim.x(-40, 6), aim.y(-40, 6), { steps: 8 });
    await page.waitForTimeout(150);
    label = await labelOf(frame); s = await sizeOf(frame, id);
    assert.match(label.text, /نسبة ثابتة/); assert.equal(label.text.split(' •')[0], s.w + ' × ' + s.h);
    assert.ok(s.w < start.w, 'smaller: ' + JSON.stringify(s));
    assert.ok(Math.abs(s.w / s.h - startRatio) < 0.04, 'same shape ' + startRatio.toFixed(3) + ': ' + JSON.stringify(s));
    await page.mouse.up(); await page.keyboard.up('Shift'); await page.waitForTimeout(300);
    const saved = await sizeOf(frame, id);
    assert.ok(Math.abs(saved.w / saved.h - startRatio) < 0.04, 'and the saved size has the same shape: ' + JSON.stringify(saved));

    // 3. Shift pressed and let go in the middle of a drag, the pointer not moving: the element follows at once
    const base = await sizeOf(frame, id);
    aim = await aimHandle(page, frame);
    await page.mouse.move(aim.x(0, 0), aim.y(0, 0)); await page.mouse.down();
    await page.mouse.move(aim.x(70, 4), aim.y(70, 4), { steps: 8 });
    await page.waitForTimeout(150);
    const free = await sizeOf(frame, id);
    assert.ok(Math.abs(free.h - (base.h + 4 / aim.k)) <= 2 || free.h <= base.h + 8, 'free so far: ' + JSON.stringify(free));
    await page.keyboard.down('Shift'); await page.waitForTimeout(150);
    label = await labelOf(frame); const locked = await sizeOf(frame, id);
    assert.match(label.text, /نسبة ثابتة/, 'pressing Shift shows the lock');
    assert.ok(Math.abs(locked.w / locked.h - base.w / base.h) < 0.04, 'the shape is the starting one at once: ' + JSON.stringify([base, locked]));
    await page.keyboard.up('Shift'); await page.waitForTimeout(150);
    const back = await sizeOf(frame, id);
    assert.equal((await labelOf(frame)).text.includes('نسبة ثابتة'), false, 'letting Shift go removes the lock');
    assert.deepEqual({ w: back.w, h: back.h }, { w: free.w, h: free.h }, 'and the free size is back');
    await page.mouse.up(); await page.waitForTimeout(200);
    assert.equal((await labelOf(frame)).shown, false);
  } finally { await context.close(); }
});

test('common shapes (1:1, 4:3, 9:16, 16:9…) are the first group, each drawn as a little shape; one makes a new block and gives a chosen one its shape; the drag label names the shape', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    await openMenu(page, frame, null);
    await menuItem(page, 'إنشاء كتلة نصية').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    const grid = page.locator('#elanSizeDlg .grid').first();
    const texts = await grid.locator('.dim').allTextContents();
    ['1:1', '4:3', '9:16', '16:9', '3:2', '4:5'].forEach((n) => assert.ok(texts.includes(n), n + ' is offered: ' + texts.join(' ')));
    const wide = grid.locator('button').filter({ has: page.locator('.dim', { hasText: /^16:9$/ }) });
    const shape = await wide.locator('.shape').evaluate((e) => ({ w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
    assert.ok(Math.abs(shape.w / shape.h - 16 / 9) < 0.2 && Math.max(shape.w, shape.h) === 28, 'a 16:9 drawing: ' + JSON.stringify(shape));
    assert.ok(await page.locator('#elanSizeDlg .grid .shape').count() >= 30, 'and a drawing beside every size, not only the shapes');
    await wide.click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const id = await lastBlock(frame);
    let s = await sizeOf(frame, id);
    assert.ok(s.w <= s.room && Math.abs(s.h - s.w * 9 / 16) <= 1.5, 'a 16:9 block: ' + JSON.stringify(s));

    // the drag label names the shape, and Shift keeps it
    await frame.evaluate(async (elementId) => { await window.ElanEditMode.execute('element.select', { elementId }); }, id);
    await frame.evaluate((elementId) => { window.ElanDesignLayer.elements().find((e) => e.id === elementId).el.scrollIntoView({ block: 'center' }); }, id);
    await page.waitForTimeout(900);
    const aim = await aimHandle(page, frame);
    await page.mouse.move(aim.x(0, 0), aim.y(0, 0)); await page.keyboard.down('Shift'); await page.mouse.down();
    await page.mouse.move(aim.x(-60, -3), aim.y(-60, -3), { steps: 8 });
    await page.waitForTimeout(150);
    const label = await labelOf(frame);
    assert.match(label.text, /\u2022 16:9 \u2022 نسبة ثابتة$/, 'the label: ' + label.text);
    await page.mouse.up(); await page.keyboard.up('Shift'); await page.waitForTimeout(300);

    // a chosen element takes a shape too: same width, the height follows
    s = await sizeOf(frame, id);
    await openMenu(page, frame, id);
    await menuItem(page, 'مقاس قياسي للعنصر').click();
    await chooser(page).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#elanSizeDlg .grid').first().locator('button').filter({ has: page.locator('.dim', { hasText: /^1:1$/ }) }).click();
    await chooser(page).waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(500);
    const sq = await sizeOf(frame, id);
    assert.ok(Math.abs(sq.w - s.w) <= 1 && Math.abs(sq.h - sq.w) <= 1, 'a square with the width it had: ' + JSON.stringify([s, sq]));
  } finally { await context.close(); }
});
