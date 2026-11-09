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
    assert.deepEqual(lay.groups, ['بانرات الويب (IAB)', 'سوشيال ميديا', 'شاشات ونسب شائعة', 'ورق الطباعة (96 نقطة/بوصة)']);
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
