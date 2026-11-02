'use strict';
/* The owner's editor in a real Chromium at phone (390), tablet (820) and laptop (1366) windows.
   On every window the platform inside the editor is laid out as on a phone (390 css px wide), and it must
   look exactly like the real storefront opened on a phone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function openEditor(size) {
  const { context, problems } = await H.openContext(browser, server, size);
  await H.loginAsOwner(context, server);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/editor', { waitUntil: 'load' });
  await page.waitForSelector('iframe', { state: 'attached' });
  let frame = null;
  for (let i = 0; i < 80 && !frame; i++) {
    frame = page.frames().find((f) => f.url().includes('elan_editor=1')) || null;
    if (frame && !(await frame.evaluate(() => !!(window.ElanEditMode && document.getElementById('hero'))).catch(() => false))) frame = null;
    if (!frame) await page.waitForTimeout(250);
  }
  assert.ok(frame, 'the platform loaded inside the editor');
  await page.waitForTimeout(1500);               // the frame is fitted a moment after it loads
  return { context, page, frame, errors, problems };
}

/* what a section looks like: id, width and height in css px */
const SHAPE = () => {
  const out = [], hero = document.getElementById('hero');
  const take = (id, el) => { const r = el.getBoundingClientRect(); out.push({ id, w: Math.round(r.width), h: Math.round(r.height) }); };
  if (hero) take('hero', hero);
  document.querySelectorAll('#main > section[id]').forEach((s) => take(s.id, s));
  return { inner: innerWidth, high: innerHeight, shape: out };
};

for (const size of H.WIDTHS) {
  test('editor in a ' + size.width + 'px window: opens with no page errors and shows the platform as a phone does', async () => {
    const { context, page, frame, errors, problems } = await openEditor(size);
    try {
      assert.deepEqual(errors, [], 'the editor must raise no error while it loads');
      assert.deepEqual(problems, []);
      const inside = await frame.evaluate(() => ({ width: innerWidth, bucket: window.ElanDesign.deviceOf(innerWidth) }));
      assert.equal(inside.width, 390, 'the platform is laid out 390 css px wide whatever the window is');
      assert.equal(inside.bucket, 'mobile', 'so it is edited as the mobile layout');
      const box = await page.locator('iframe').first().boundingBox();
      assert.ok(box && box.width > 200 && box.height > 200, 'the platform is on screen');
      assert.ok(box.x >= -1 && box.x + box.width <= size.width + 1, 'inside the window: ' + JSON.stringify(box));
      const host = await page.evaluate(() => ({ sideways: (document.documentElement.scrollLeft = 80, document.documentElement.scrollLeft), client: document.documentElement.clientWidth }));
      assert.equal(host.sideways, 0, 'the editor itself does not scroll sideways');
    } finally { await context.close(); }
  });

  test('editor in a ' + size.width + 'px window: the platform inside looks exactly like the storefront on a phone', async () => {
    const editor = await openEditor(size);
    try {
      const inEditor = await editor.frame.evaluate(SHAPE);
      assert.equal(inEditor.inner, 390);
      const phone = await H.openContext(browser, server, { width: 390, height: inEditor.high });
      const page = await phone.context.newPage();
      try {
        await page.goto(H.SITE + '/', { waitUntil: 'load' });
        await page.waitForSelector('#hero', { state: 'attached' });
        await page.addStyleTag({ content: 'html{scrollbar-width:none}' });   // a phone has no scrollbar track
        await page.waitForTimeout(1500);
        const onPhone = await page.evaluate(SHAPE);
        assert.equal(onPhone.inner, 390);
        assert.ok(onPhone.shape.length >= 4, 'hero and sections are there: ' + JSON.stringify(onPhone.shape.map((s) => s.id)));
        assert.deepEqual(inEditor.shape.map((s) => s.id), onPhone.shape.map((s) => s.id), 'the same sections in the same order');
        inEditor.shape.forEach((s, i) => {
          const p = onPhone.shape[i];
          assert.ok(Math.abs(s.w - p.w) <= 1, s.id + ' is ' + s.w + 'px wide in the editor and ' + p.w + 'px on the phone');
          assert.ok(Math.abs(s.h - p.h) <= 2, s.id + ' is ' + s.h + 'px high in the editor and ' + p.h + 'px on the phone');
        });
      } finally { await phone.context.close(); }
    } finally { await editor.context.close(); }
  });
}

test('editor: a right click on the platform opens the original tools menu', async () => {
  const { context, page, frame } = await openEditor(H.WIDTHS[2]);
  try {
    /* bring a section into view first, then click inside it (coordinates are the platform's own, the editor scales them) */
    const target = await frame.evaluate(() => {
      const e = window.ElanDesignLayer.elements().find((x) => x.kind === 'section' && x.id.startsWith('sec:') && x.el.getBoundingClientRect().height > 80);
      const top = e.el.getBoundingClientRect().top;
      document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo({ top: Math.max(0, scrollY + top - 120), behavior: 'instant' });
      const r = e.el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 30 };
    });
    await page.waitForTimeout(300);
    const box = await page.locator('iframe').first().boundingBox();
    const k = box.width / 390;
    await page.mouse.click(box.x + target.x * k, box.y + target.y * k, { button: 'right' });
    await page.waitForTimeout(400);
    const labels = await page.evaluate(() => { const m = document.getElementById('menu'); return !m || m.style.display === 'none' ? [] : Array.from(m.children).map((b) => b.textContent); });
    assert.ok(labels.length >= 17, 'the menu lists the 17 original tools and more: ' + labels.length);
    assert.ok(labels.some((l) => /تنسيق النص/.test(l)) && labels.some((l) => /إنشاء سيكشن/.test(l)));
  } finally { await context.close(); }
});
