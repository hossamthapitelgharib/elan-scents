'use strict';
/* The storefront in a real Chromium at phone (390), tablet (820) and laptop (1366) widths. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function visit(size) {
  const { context, problems } = await H.openContext(browser, server, size);
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#hero', { state: 'attached' });
  await page.waitForTimeout(1200);
  return { context, page, errors, problems };
}

for (const size of H.WIDTHS) {
  test('storefront at ' + size.width + 'px (' + size.name + '): no page errors, no sideways scroll, the hero spans the screen', async () => {
    const { context, page, errors, problems } = await visit(size);
    try {
      assert.deepEqual(errors, [], 'the page must raise no error');
      assert.deepEqual(problems, []);
      const m = await page.evaluate(() => {
        const hero = document.getElementById('hero').getBoundingClientRect();
        /* a visitor cannot push the page sideways: the off-screen menu is clipped, not scrollable */
        document.body.scrollLeft = 120; document.documentElement.scrollLeft = 120; window.scrollTo(120, 0);
        return { inner: document.body.clientWidth, sideways: document.body.scrollLeft + document.documentElement.scrollLeft + window.scrollX, heroW: Math.round(hero.width), heroH: Math.round(hero.height), lang: document.documentElement.lang, dir: document.documentElement.dir };
      });
      assert.equal(m.sideways, 0, 'the page does not scroll sideways');
      assert.equal(m.heroW, m.inner, 'the hero takes the full width of the page (the page scrolls inside the body, so its own scrollbar is excluded)');
      assert.ok(m.heroH >= 200, 'the hero has a real height: ' + m.heroH);
      assert.equal(m.dir, 'rtl');
    } finally { await context.close(); }
  });

  test('storefront at ' + size.width + 'px: the sections follow the page order and never wider than the screen', async () => {
    const { context, page } = await visit(size);
    try {
      const sections = await page.evaluate(() => Array.from(document.querySelectorAll('#main > section[id]')).map((s) => { const r = s.getBoundingClientRect(); return { id: s.id, top: Math.round(r.top + scrollY), width: Math.round(r.width), display: getComputedStyle(s).display }; }).concat([{ id: '#client', width: document.body.clientWidth }]));
      const client = sections.pop().width;
      assert.ok(sections.length >= 3, 'the page has its sections: ' + JSON.stringify(sections.map((s) => s.id)));
      sections.filter((s) => s.display !== 'none').forEach((s) => assert.ok(s.width <= client, s.id + ' is ' + s.width + 'px wide on a ' + size.width + 'px screen'));
      const visible = sections.filter((s) => s.display !== 'none').map((s) => s.top);
      assert.deepEqual(visible, visible.slice().sort((a, b) => a - b), 'sections run top to bottom in order');
    } finally { await context.close(); }
  });
}
