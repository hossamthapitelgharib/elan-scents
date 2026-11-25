'use strict';
/* Owner, 2026-11-25: «عنصر القائمة بالماوس (ضبط الأبعاد) أحيانًا لا يعمل».
   What was found when the real right-click was tried in real Chromium, with the real mouse all the way (right-click on the element, the item, the shape in the window):
   (1) «أبعاد العناصر» was the 19th of 21 items of a menu that holds at most 80% of the window and scrolls inside itself, so on every window height the item was below the bottom edge,
       out of sight unless the menu was scrolled; it now comes right after the twelve items the owner ordered, and the menu is compact, so it is seen when the menu opens;
   (2) every action of the menu asks the server about the session first, and one lost answer failed the item with a message only in a small status line; a lost answer is now asked once more,
       and a failure of a menu item is shown in a red message where it can be seen.
   The point under the mouse is computed from the page the way the editor shows it (the preview is scaled to fit), never from a number the owner can change from the editor. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(height) {
  const { context } = await H.openContext(browser, server, { name: 'laptop-' + height, width: 1366, height });
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
  await H.quiet(page, frame);
  return { context, page, frame };
}

/* Right-click on the middle of an element of the preview, with the real mouse (the preview is scaled to fit the window: the point is scaled with it). */
async function rightClick(page, frame, id) {
  await frame.evaluate((elementId) => { document.documentElement.style.scrollBehavior = 'auto'; window.ElanDesignLayer.elements().find((x) => x.id === elementId).el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, id);
  await page.waitForTimeout(150);
  const at = await frame.evaluate((elementId) => {
    const b = window.ElanDesignLayer.elements().find((x) => x.id === elementId).el.getBoundingClientRect();
    const f = Array.from(parent.document.querySelectorAll('iframe')).find((x) => /elan_editor=1/.test(x.src)), r = f.getBoundingClientRect();
    return { x: r.left + (b.left + b.width / 2) * (r.width / innerWidth), y: r.top + (b.top + b.height / 2) * (r.width / innerWidth) };
  }, id);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForFunction(() => { const m = document.getElementById('menu'); return m && m.style.display !== 'none' && m.querySelector('button'); }, null, { timeout: 5000 });
  const picked = await frame.evaluate(() => { const s = window.ElanEditMode.state().selected; return s && s.id; });
  assert.equal(picked, id, 'the right-click chose the element that was under the mouse');
}
const sizeItem = (page) => page.locator('#menu button', { hasText: 'أبعاد العناصر' });
const heightOf = (frame, id) => frame.evaluate((elementId) => { const r = window.ElanDesignLayer.elements().find((x) => x.id === elementId).el.getBoundingClientRect(); return { w: r.width, h: r.height }; }, id);
async function chooseShape(page, ratio, beforePick) {
  await sizeItem(page).first().click({ timeout: 3000 });
  await page.waitForSelector('#elanSizeDlg', { timeout: 4000 });
  if (beforePick) await beforePick();   // the moment before the shape is chosen: what the editor asks the server from here on is the item's own question
  await page.locator('#elanSizeDlg .grid button').filter({ has: page.locator('.dim', { hasText: new RegExp('^' + ratio + '$') }) }).first().click();
}
const TITLE = 'sec:master:title';

for (const height of [600, 900]) {
  test('in a window ' + height + 'px high the dimensions item is seen when the menu opens, with no scrolling inside the menu', async () => {
    const { context, page, frame } = await openEditor(height);
    try {
      await rightClick(page, frame, TITLE);
      const got = await page.evaluate(() => {
        const m = document.getElementById('menu'), mr = m.getBoundingClientRect(), items = Array.from(m.querySelectorAll('button')), k = items.findIndex((b) => /أبعاد العناصر/.test(b.textContent)), br = items[k] && items[k].getBoundingClientRect();
        return { n: items.length, place: k + 1, scrollTop: m.scrollTop, menu: [mr.top, mr.bottom], item: br && [br.top, br.bottom], innerHeight, disabled: items[k] && items[k].disabled };
      });
      assert.ok(got.item, 'the menu of an element has the dimensions item: ' + JSON.stringify(got));
      assert.equal(got.disabled, false, 'and it is enabled');
      assert.equal(got.scrollTop, 0, 'the menu was not scrolled');
      assert.ok(got.item[0] >= got.menu[0] - 0.5 && got.item[1] <= got.menu[1] + 0.5, 'the item is inside the part of the menu that is seen: ' + JSON.stringify(got));
      assert.ok(got.item[0] >= 0 && got.item[1] <= got.innerHeight, 'and inside the window: ' + JSON.stringify(got));
      assert.ok(got.place <= 13, 'it is among the first items (the 13th, after the twelve the owner ordered), it was the 19th: ' + got.place);
    } finally { await context.close(); }
  });
}

test('a title takes the shape chosen from the right-click menu with the real mouse, and the menu closes behind it', async () => {
  const { context, page, frame } = await openEditor(768);
  try {
    await rightClick(page, frame, TITLE);
    const before = await heightOf(frame, TITLE);
    await chooseShape(page, '4:3');
    await page.waitForFunction(() => !document.getElementById('elanSizeDlg'), null, { timeout: 4000 });
    await H.quiet(page, frame);
    const after = await heightOf(frame, TITLE);
    assert.ok(Math.abs(after.h - after.w * 3 / 4) <= 1.5, 'the title is 4:3 now (' + after.w.toFixed(1) + ' × ' + after.h.toFixed(1) + ', it was ' + before.w.toFixed(1) + ' × ' + before.h.toFixed(1) + ')');
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('menu')).display), 'none', 'the menu is closed');
    assert.equal(await page.locator('#liveError').isVisible().catch(() => false), false, 'and nothing failed');
  } finally { await context.close(); }
});

test('one lost answer of the session check does not fail the item: it is asked once more', async () => {
  const { context, page, frame } = await openEditor(768);
  try {
    await rightClick(page, frame, TITLE);
    const asked = []; let armed = false;
    await page.route('**/api/editor-session', (route) => { if (!armed) return route.fallback(); asked.push(1); if (asked.length === 1) return route.abort('failed'); return route.fallback(); });   // fallback: the harness's own routing of the test host answers it
    await chooseShape(page, '16:9', async () => { armed = true; });
    await page.waitForFunction(() => !document.getElementById('elanSizeDlg'), null, { timeout: 4000 });
    await frame.waitForFunction((id) => { const r = window.ElanDesignLayer.elements().find((x) => x.id === id).el.getBoundingClientRect(); return Math.abs(r.height - r.width * 9 / 16) <= 1.5; }, TITLE, { timeout: 6000 }).catch(() => {});   // the second asking comes a moment later
    await H.quiet(page, frame);
    const after = await heightOf(frame, TITLE);
    assert.ok(asked.length >= 2, 'the first answer was lost and the session was asked again: ' + asked.length);
    assert.ok(Math.abs(after.h - after.w * 9 / 16) <= 1.5, 'the title is 16:9 anyway (' + after.w.toFixed(1) + ' × ' + after.h.toFixed(1) + ')');
    assert.equal(await page.locator('#liveError').isVisible().catch(() => false), false, 'with no error shown');
  } finally { await context.close(); }
});

test('when the session is really gone the item says so in a red message that can be seen, and changes nothing', async () => {
  const { context, page, frame } = await openEditor(768);
  try {
    await page.route('**/api/editor-session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthorized"}' }));
    await rightClick(page, frame, TITLE);
    const before = await heightOf(frame, TITLE);
    await chooseShape(page, '4:3');
    const box = page.locator('#liveError');
    await box.waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await box.textContent(), /انتهت جلسة التحرير/, 'the message says what happened and what to do');
    await H.quiet(page, frame);
    const after = await heightOf(frame, TITLE);
    assert.ok(Math.abs(after.h - before.h) <= 0.5, 'and the title was not changed');
  } finally { await context.close(); }
});
