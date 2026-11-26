'use strict';
/* Owner, 2026-11-25: «لما بفتح صفحة القائمة وأنا في أي مكان بالمنصة، بتفتح لكن صفحة المنصة بتبقى بيضاء بدون عناصر، ولما بقفل القائمة العناصر ترجع. وعايز خلفية القائمة أبيض ناصع».
   The page is frozen while the menu is open by fixing the body at top:-scrollY (app.js, lockBodyScroll). The body also had overflow:hidden and height:100%: a box one window high lifted out of the window by the scroll
   the visitor had, so anywhere but the very top everything behind the menu was clipped away and the shade lay over a blank page. Measured here in real Chromium at the three widths, from the middle of the page:
   what is behind the shade is still the page (the section is still where it was and still takes the touch of a point beside the menu), the menu page is pure white, and closing the menu brings the visitor back to where he was. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

for (const size of H.WIDTHS) {
  test('at ' + size.width + 'px the page stays behind the open menu, the menu page is pure white, and closing it returns to the same place', async () => {
    const { context } = await H.openContext(browser, server, size);
    const page = await context.newPage();
    try {
      await page.goto(H.SITE + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null && typeof document.getElementById('mb').onclick === 'function', null, { timeout: 15000 });   // (the menu button works once the store script has built the page: a click before that is lost, which is how this test failed now and then on a loaded machine)
      await H.quiet(page);
      const before = await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';   // the page scrolls smoothly otherwise, and the place is read at once
        window.scrollTo(0, Math.min(1200, document.documentElement.scrollHeight - innerHeight - 50));
        const sec = Array.from(document.querySelectorAll('#main > section')).find((s) => { const r = s.getBoundingClientRect(); return r.top < innerHeight * 0.6 && r.bottom > innerHeight * 0.4 && getComputedStyle(s).display !== 'none'; });
        if (!sec) return null;
        sec.dataset.probe = '1';
        return { y: scrollY, id: sec.id, top: sec.getBoundingClientRect().top };
      });
      assert.ok(before && before.y > 300, 'the page was scrolled down to a section: ' + JSON.stringify(before));
      await page.click('#mb');
      await page.waitForFunction(() => { const m = document.getElementById('menu'), r = m.getBoundingClientRect(); const w = document.documentElement.clientWidth; return m.classList.contains('open') && (Math.abs(r.left) < 1 || Math.abs(r.right - innerWidth) < 1 || Math.abs(r.right - w) < 1); }   // (the menu rests against the edge of what is seen: with a classic scrollbar beside the page that edge is clientWidth, 15px short of innerWidth, which made this wait fail now and then)
, null, { timeout: 4000 });
      const got = await page.evaluate(() => {
        const sec = document.querySelector('[data-probe]'), r = sec.getBoundingClientRect(), m = document.getElementById('menu'), mr = m.getBoundingClientRect();
        const x = mr.left < innerWidth / 2 ? innerWidth * 0.92 : innerWidth * 0.08, y = Math.min(Math.max(r.top + 30, 80), innerHeight - 40);
        return { top: r.top, locked: document.body.classList.contains('sheet-open'), bg: getComputedStyle(m).backgroundColor, beside: document.elementsFromPoint(x, y).includes(sec), point: [Math.round(x), Math.round(y)] };
      });
      assert.equal(got.locked, true, 'the page is frozen while the menu is open');
      assert.ok(Math.abs(got.top - before.top) <= 1.5, 'the section behind the menu did not move: ' + got.top.toFixed(1) + ' against ' + before.top.toFixed(1));
      assert.equal(got.beside, true, 'and it is really there behind the shade (not clipped away): ' + JSON.stringify(got));
      assert.equal(got.bg, 'rgb(255, 255, 255)', 'the menu page is pure white');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      const after = await page.evaluate(() => scrollY);
      assert.ok(Math.abs(after - before.y) <= 2, 'closing the menu returns to the same place: ' + after + ' against ' + before.y);
    } finally { await context.close(); }
  });
}

/* The cart, the favourites and the account sheets freeze the page the same way: closing one must give the visitor his place back (it threw him to the top of the page), and the menu closed with Escape too. */
for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('at ' + size.width + 'px closing the cart sheet returns to the place the visitor was at, and Escape does the same for the menu', async () => {
    const { context } = await H.openContext(browser, server, size);
    const page = await context.newPage();
    try {
      await page.goto(H.SITE + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null && typeof document.getElementById('mb').onclick === 'function', null, { timeout: 15000 });   // (the menu button works once the store script has built the page: a click before that is lost, which is how this test failed now and then on a loaded machine)
      await H.quiet(page);
      const scrollTo = (y) => page.evaluate((v) => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, Math.min(v, document.documentElement.scrollHeight - innerHeight - 50)); return scrollY; }, y);
      const y1 = await scrollTo(1200);
      assert.ok(y1 > 300, 'the page was scrolled down: ' + y1);
      await page.click('header [data-sheet="cart"]');
      await page.waitForFunction(() => { const s = document.getElementById('sheet'); return s && !s.hidden; }, null, { timeout: 4000 });
      assert.equal(await page.evaluate(() => document.body.style.top), '-' + y1 + 'px', 'the page was frozen where it was, not thrown to the top');
      await page.click('#sheet .sheet-close');
      await page.waitForFunction(() => document.getElementById('sheet').hidden && !document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - y1) <= 2, 'closing the sheet returns to the same place');
      await page.click('#mb');
      await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - y1) <= 2, 'and so does closing the menu with Escape');
    } finally { await context.close(); }
  });
}
