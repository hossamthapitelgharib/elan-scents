'use strict';
/* Owner, 2026-11-13 (point 6, the simple version), 2026-11-14 (an item of the right-click menu, not a header button): «ظبّط مسافات الصفحة كلها» puts the whole page on the platform's fixed gaps.
   Whole sections and blocks lose their free offsets; things that sat side by side only because of those offsets become a real row (at most four);
   it is one undo step and nothing is published until Save. No preview and no button of its own to go back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

/* the editor reads the published design from the server: a clean one (no hand offsets at all) unless a test wants the real page */
const CLEAN = { version: 1 };
async function openEditor(design) {
  const { context } = await H.openContext(browser, server, H.WIDTHS[2]);
  await H.loginAsOwner(context, server);
  const page = await context.newPage();
  if (design) {
    await page.route('**/api/editor?action=state', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision: 'a'.repeat(40), design, branch: 'main' }) }));
    await page.route('**/design/home.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(design) }));
  }
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
const run = (frame, action, p) => frame.evaluate(async ({ action, p }) => JSON.parse(JSON.stringify(await window.ElanEditMode.execute(action, p || {}) || null)), { action, p });
const edits = (frame, id) => frame.evaluate((x) => { const e = (window.ElanEditMode.state().design.edits || {}); const out = {}; Object.keys(e).forEach((d) => { if (e[d][x]) out[d] = JSON.parse(JSON.stringify(e[d][x])); }); return out; }, id);
const rect = (frame, id) => frame.evaluate((x) => { const r = document.querySelector('[data-elan-id="' + x + '"]').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }, id);

/* small blocks, then every one after the first pulled by hand to sit to the right of the one before it */
async function lineOfBlocks(frame, n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push((await run(frame, 'element.create', { kind: 'text_block' })).elementId);
  for (const id of ids) await run(frame, 'element.resize', { elementId: id, w: 52, h: 60 });
  const natural = [];
  for (const id of ids) natural.push(await rect(frame, id));
  for (let i = 1; i < n; i++) {
    await run(frame, 'element.move', { elementId: ids[i], dx: Math.round(natural[0].left + i * 64 - natural[i].left), dy: Math.round(natural[0].top - natural[i].top) });
  }
  return ids;
}

test('things that sit side by side only because of hand offsets become one row, the offsets go, and undo brings it all back in one step', async () => {
  const { context, page, frame } = await openEditor(CLEAN);
  try {
    const ids = await lineOfBlocks(frame, 2);
    await page.waitForTimeout(300);
    const [a, b] = [await rect(frame, ids[0]), await rect(frame, ids[1])];
    assert.ok(Math.abs(a.top - b.top) < 2 && b.left > a.right - 1, 'before: side by side by hand: ' + JSON.stringify([a, b]));
    const hand = await edits(frame, ids[1]);
    assert.ok(Object.keys(hand).some((d) => hand[d].dx !== undefined), 'the second one carries a hand offset');
    const res = await run(frame, 'tool.run', { id: 'fix_spacing' });
    await page.waitForTimeout(400);
    assert.equal(res.rows, 1, JSON.stringify(res));
    assert.ok(res.changed >= 1);
    assert.match(res.message, /ظبّطت المسافات/);
    const saved = await edits(frame, ids[1]);
    const keys = Object.keys(saved).reduce((all, d) => all.concat(Object.keys(saved[d])), []);
    assert.ok(keys.includes('beside') && !keys.includes('dx') && !keys.includes('dy'), 'saved as {beside}, no offset left: ' + JSON.stringify(saved));
    assert.deepEqual(await frame.evaluate(() => Array.from(document.querySelector('[data-elan-row]').children).map((n) => n.getAttribute('data-elan-id'))), ids, 'one row with the two, in reading order');
    // undo = one step back to the hand placement
    await run(frame, 'history.undo');
    await page.waitForTimeout(400);
    assert.equal(await frame.locator('[data-elan-row]').count(), 0, 'the row is gone after one undo');
    const back = await edits(frame, ids[1]);
    assert.ok(Object.keys(back).some((d) => back[d].dx !== undefined), 'the hand offset is back');
  } finally { await context.close(); }
});

test('a section pulled by hand is put back in the normal flow, and a page that is already tidy is left alone', async () => {
  const { context, page, frame } = await openEditor(CLEAN);
  try {
    const before = await frame.evaluate(() => JSON.stringify(window.ElanEditMode.state().design));
    const none = await run(frame, 'tool.run', { id: 'fix_spacing' });
    assert.equal(none.changed, 0); assert.equal(none.rows, 0);
    assert.match(none.message, /مظبوطة أصلًا/);
    assert.equal(await frame.evaluate(() => JSON.stringify(window.ElanEditMode.state().design)), before, 'nothing changed in the design');

    const section = 'sec:offers';
    await run(frame, 'element.move', { elementId: section, dx: 0, dy: -25 });
    const pulled = await edits(frame, section);
    assert.ok(Object.keys(pulled).some((d) => pulled[d].dy === -25), 'the section carries the hand offset: ' + JSON.stringify(pulled));
    const res = await run(frame, 'tool.run', { id: 'fix_spacing' });
    await page.waitForTimeout(300);
    assert.equal(res.changed, 1, JSON.stringify(res));
    assert.equal(res.rows, 0);
    const left = await edits(frame, section);
    assert.ok(Object.keys(left).every((d) => left[d].dx === undefined && left[d].dy === undefined), 'the offset is gone: ' + JSON.stringify(left));
  } finally { await context.close(); }
});

test('a row never holds more than four: the fifth in a line is only freed from its offset', async () => {
  const { context, page, frame } = await openEditor(CLEAN);
  try {
    const ids = await lineOfBlocks(frame, 5);
    await page.waitForTimeout(300);
    const res = await run(frame, 'tool.run', { id: 'fix_spacing' });
    await page.waitForTimeout(400);
    assert.equal(res.rows, 3, 'three joins make a row of four: ' + JSON.stringify(res));
    const rows = await frame.evaluate(() => Array.from(document.querySelectorAll('[data-elan-row]')).map((r) => r.children.length));
    assert.ok(rows.length >= 1 && rows.every((n) => n <= 4), 'no row above four: ' + JSON.stringify(rows));
    const fifth = await edits(frame, ids[4]);
    assert.ok(Object.keys(fifth).every((d) => fifth[d].dx === undefined && fifth[d].dy === undefined && fifth[d].beside === undefined), 'the fifth has no offset and is not in the row: ' + JSON.stringify(fifth));
  } finally { await context.close(); }
});

/* a test design with one section pulled by hand: the published page's own design changes whenever the owner saves from the editor, so it cannot be what a test counts on */
const PULLED = { version: 1, edits: { all: { 'sec:offers': { dy: -25 } } } };
test('it is an item of the right-click menu (not a header button), and choosing it says what it did', async () => {
  const { context, page, frame } = await openEditor(PULLED);
  try {
    assert.equal(await page.locator('#fixSpacing').count(), 0, 'no header button any more');
    assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('#editorHeaderActions>button')).map((b) => b.id)), ['undo', 'redo', 'save', 'restorePrev', 'library', 'editorLogout'], 'the header keeps its six buttons');
    const target = await frame.evaluate(() => {
      const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
      document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + e.el.getBoundingClientRect().top - 120), behavior: 'instant' });
      const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
    });
    await page.waitForTimeout(300);
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / 390;
    await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
    await page.waitForFunction(() => Array.from(document.getElementById('menu').children).some((b) => b.textContent.trim() === 'ظبّط مسافات الصفحة كلها'), null, { timeout: 8000 });
    const item = page.locator('#menu > button', { hasText: 'ظبّط مسافات الصفحة كلها' });
    assert.equal(await item.count(), 1, 'one such item in the mouse menu');
    assert.equal(await item.isDisabled(), false, 'and it can be pressed');
    await item.click();
    /* the answer shows on the page itself (the platform's own message line), like every other menu tool */
    await frame.waitForFunction(() => /ظبّطت المسافات: شلت الإزاحة اليدوية|المسافات مظبوطة أصلًا/.test(document.body.textContent), null, { timeout: 8000 });
    assert.match(await frame.evaluate(() => document.body.textContent), /ظبّطت المسافات: شلت الإزاحة اليدوية/, 'the design has a hand offset, so it says what it removed');
  } finally { await context.close(); }
});
