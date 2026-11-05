'use strict';
/* Three things the owner asked for in the live editor (2026-11-02), in a real Chromium:
   1. "دخول لصفحة" is a tool of the mouse menu, and the old "open page" chip on the selected element's box is gone.
   2. A "صفحة سابقة" button sits in the same row as the "رفع على GitHub" step and the two steps after it: four small ovals of one size on one line
      each, on a phone as well, and only the button with a light gold touch of its own; it leaves the current page for the previous one, one step per press.
   3. The save button turns into a green lamp when it is pressed and the lamp goes off as soon as the upload to GitHub is done. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
const PHONE = H.WIDTHS[0], LAPTOP = H.WIDTHS[2];

let browser, server;
test.before(async () => { if (!pw) return; server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(size, routes) {
  const { context, problems } = await H.openContext(browser, server, size);
  if (routes) await routes(context);
  await H.loginAsOwner(context, server);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the platform loaded inside the editor');
  await page.waitForTimeout(1500);
  return { context, page, frame, errors, problems };
}
const message = (page) => page.evaluate(() => document.getElementById('bridgeStatus').textContent);

test('"دخول لصفحة" is in the mouse menu and the box of the selected element has no open chip', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    const target = await frame.evaluate(() => {
      const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
      document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + e.el.getBoundingClientRect().top - 120), behavior: 'instant' });
      const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
    });
    await page.waitForTimeout(300);
    const box = await page.locator('iframe').first().boundingBox(), k = box.width / 390;
    await page.mouse.click(box.x + target.x * k, box.y + target.y * k);                      // select it
    await page.waitForTimeout(300);
    assert.equal(await frame.evaluate(() => document.querySelector('.eo-open')), null, 'no open chip on the element box');
    assert.ok(!(await frame.evaluate(() => document.body.innerText.includes('فتح الصفحة'))), 'and no "فتح الصفحة" text anywhere on the platform');
    await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
    await page.waitForTimeout(400);
    const items = await page.evaluate(() => Array.from(document.getElementById('menu').children).map((b) => ({ text: b.textContent, off: !!b.disabled })));
    const enter = items.find((i) => i.text === 'دخول لصفحة');
    assert.ok(enter, 'the menu lists "دخول لصفحة": ' + items.map((i) => i.text).join(' | '));
  } finally { await context.close(); }
});

test('"صفحة سابقة" sits in the row of the GitHub step, at the same size as the steps and on one line, with only a light touch of its own; on the home page it says there is nothing before it', async () => {
  for (const size of [LAPTOP, PHONE]) {
    const { context, page } = await openEditor(size);
    try {
      for (const lit of [false, true]) {
        /* the longest label is "✓ تحميل النسخة الجديدة": the cells must still be one size and one line when every step is done */
        const row = await page.evaluate((lit) => {
          if (lit) setStages(3);
          const cells = Array.from(document.getElementById('editorStages').children);
          return {
            cells: cells.map((el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); const lines = Array.from(el.children).map((c) => c.getBoundingClientRect().height); return { id: el.id || el.dataset.label, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), border: cs.borderTopColor, cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1, tall: Math.max.apply(null, lines) > 20 }; }),
            innerWidth
          };
        }, lit);
        const where = size.width + 'px' + (lit ? ' (all steps done)' : '') + ': ' + JSON.stringify(row.cells.map((c) => [c.id, c.x, c.y, c.w, c.h]));
        assert.deepEqual(row.cells.map((c) => c.id), ['editorPrevPage', 'رفع على GitHub', 'نشر على الموقع', 'تحميل النسخة الجديدة'], 'the button comes first, right beside the "رفع على GitHub" step: ' + where);
        assert.equal(new Set(row.cells.map((c) => c.y)).size, 1, 'the button and the three steps are one row, on a phone too: ' + where);
        assert.equal(new Set(row.cells.map((c) => c.w)).size, 1, 'one width: ' + where);
        assert.equal(new Set(row.cells.map((c) => c.h)).size, 1, 'one height: ' + where);
        assert.ok(row.cells.every((c) => c.x >= 0 && c.x + c.w <= row.innerWidth), 'inside the window: ' + where);
        assert.ok(row.cells.every((c) => !c.cut), 'no label is cut off: ' + where);
        assert.ok(row.cells.every((c) => !c.tall), 'every label is on one line: ' + where);
        assert.ok(row.cells.slice(1).every((c) => c.border !== row.cells[0].border || lit), 'only "صفحة سابقة" has the gold border');
      }
      assert.match(await page.locator('#editorPrevPage').innerText(), /صفحة سابقة/);
      assert.equal(await page.locator('#editorPrevPage').getAttribute('aria-label'), 'صفحة سابقة');
      await page.evaluate(() => setStages(0));
      await page.click('#editorPrevPage'); await page.waitForTimeout(500);
      assert.match(await message(page), /الصفحة الرئيسية/);
    } finally { await context.close(); }
  }
});

test('"صفحة سابقة" leaves an inner page for the previous one, one press at a time', async () => {
  const { context, page, frame } = await openEditor(LAPTOP);
  try {
    /* an inner page as the storefront shows it: the body carries "inner" (the test has no catalogue to open a real brand page) */
    await frame.evaluate(() => { document.body.classList.add('inner'); });
    await page.click('#editorPrevPage'); await page.waitForTimeout(600);
    assert.equal(await frame.evaluate(() => document.body.classList.contains('inner')), false, 'one press leaves the inner page');
    assert.match(await message(page), /رجعت للصفحة السابقة/);
    await page.click('#editorPrevPage'); await page.waitForTimeout(400);
    assert.match(await message(page), /الصفحة الرئيسية/, 'a second press on the first page only says so');
  } finally { await context.close(); }
});

test('the save button lights a green lamp when pressed and puts it out once the upload to GitHub is done', async () => {
  const saves = [];
  const { context, page } = await openEditor(PHONE, async (ctx) => {
    await ctx.route('**/api/editor', async (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* not json */ }
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
      if (body.action === 'save') { saves.push(body.action); await new Promise((r) => setTimeout(r, 1800)); return json({ ok: true, committed: true, revision: 'a1b2c3d4e5'.repeat(4) }); }
      if (body.action === 'status') return json({ ok: true, published: false });
      return route.continue();
    });
  });
  try {
    /* this local server has no GitHub token, so the platform opens read-only and refuses to confirm a save: let it confirm, as it does for the owner */
    await page.evaluate(() => { const real = window.requestLive; window.requestLive = (action, payload) => action === 'page.markSaved' ? Promise.resolve(null) : real(action, payload); });
    const lit = () => page.evaluate(() => document.getElementById('save').classList.contains('lampOn'));
    assert.equal(await lit(), false, 'dark before the press');
    await page.click('#save'); await page.waitForTimeout(300);
    assert.equal(await lit(), true, 'lit right after the press, while the save is under way');
    const look = await page.evaluate(() => { const b = document.getElementById('save'), l = b.querySelector('.lamp'); return { bg: getComputedStyle(b).backgroundColor, lamp: getComputedStyle(l).display, lampBg: getComputedStyle(l).backgroundColor }; });
    assert.notEqual(look.bg, 'rgb(212, 183, 110)', 'the button changed colour: ' + look.bg);
    assert.equal(look.lamp, 'block');
    assert.match(look.lampBg, /rgb\(70, 224, 112\)/, 'a green lamp');
    await page.waitForFunction(() => !document.getElementById('save').classList.contains('lampOn'), null, { timeout: 8000 });
    assert.equal(saves.length, 1, 'one save went to the server');
    const chip = await page.evaluate(() => document.querySelector('#editorStages [data-label="رفع على GitHub"] span').textContent);
    assert.match(chip, /^✓/, 'the lamp went out when the upload to GitHub was marked done (message: ' + await message(page) + ')');
  } finally { await context.close(); }
});

test('the save lamp also goes out when the save fails', async () => {
  const { context, page } = await openEditor(PHONE, async (ctx) => {
    await ctx.route('**/api/editor', async (route) => {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { /* not json */ }
      if (body.action === 'save') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'github_failed' }) });
      return route.continue();
    });
  });
  try {
    await page.click('#save'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('save').classList.contains('lampOn')), true);
    await page.waitForFunction(() => !document.getElementById('save').classList.contains('lampOn'), null, { timeout: 5000 });
    assert.match(await message(page), /تعذّر الحفظ/);
  } finally { await context.close(); }
});
