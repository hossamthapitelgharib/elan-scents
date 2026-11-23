'use strict';
/* Owner, 2026-11-23: in the header the menu, the search and the notification icons must be the same size as the cart and favourites icons.
   «Same size» is what the eye sees, not the number in the stylesheet: the heart fills less of its 24px square than the menu or the bell fill of theirs, so the cart is set to 20px and the
   others to 24px and they still looked different. This test measures what is DRAWN (the box of the paths plus the stroke, in pixels) and requires the three right-hand icons to be within
   1.2px of the heart and the cart, on a phone, a tablet and a laptop; it does not pin any width or height. It also checks that no icon moved: every button keeps a box of at least 24px and
   the row of icons on the right keeps its order. Real Chromium. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

for (const size of H.WIDTHS) {
  test('at ' + size.width + 'px the menu, search and notification icons are drawn as large as the heart and the cart', async () => {
    const { context } = await H.openContext(browser, server, size);
    const page = await context.newPage();
    try {
      await page.goto(H.SITE + '/', { waitUntil: 'load' });
      await H.quiet(page);
      const got = await page.evaluate(() => {
        const items = { menu: '#mb', notif: 'header button[data-sheet="notif"]', search: '#quickSearchBtn', fav: 'header button[data-sheet="fav"]', cart: 'header button[data-sheet="cart"]' };
        const out = {};
        for (const k in items) {
          const button = document.querySelector(items[k]), svg = button.querySelector('svg'), cs0 = getComputedStyle(svg), vb = svg.viewBox.baseVal;
          // the drawing fills the svg's content box (its box minus padding), which is how a menu icon is made smaller without changing its button
          const content = svg.getBoundingClientRect().width - parseFloat(cs0.paddingLeft) - parseFloat(cs0.paddingRight), scale = content / vb.width;
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          svg.querySelectorAll('path,circle').forEach((n) => { const b = n.getBBox(); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); });
          const stroke = parseFloat(getComputedStyle(svg).strokeWidth) || 1.7, box = button.getBoundingClientRect();
          out[k] = { w: (x1 - x0 + stroke) * scale, h: (y1 - y0 + stroke) * scale, boxW: box.width, x: box.x, cy: svg.getBoundingClientRect().y + svg.getBoundingClientRect().height / 2, visible: box.width > 0 && box.height > 0 };
        }
        return out;
      });
      const drawn = (i) => Math.max(i.w, i.h);                                  // the long side of what is drawn
      const reference = (drawn(got.fav) + drawn(got.cart)) / 2;
      for (const k of ['menu', 'notif', 'search']) {
        assert.ok(got[k].visible, k + ' is in the header');
        assert.ok(Math.abs(drawn(got[k]) - reference) <= 1.2, k + ' is drawn ' + drawn(got[k]).toFixed(1) + 'px on its long side, the heart and the cart ' + reference.toFixed(1) + 'px (' + JSON.stringify(got) + ')');
        assert.ok(got[k].boxW >= 24, k + ' keeps a button of at least 24px, so it is as easy to touch as before');
      }
      assert.ok(Math.abs(drawn(got.fav) - drawn(got.cart)) <= 1.2, 'the heart and the cart were already the same size and stay so');
      assert.ok(got.menu.x > got.notif.x && got.notif.x > got.search.x, 'the order on the right is menu, notification, search (right to left)');
      assert.ok(got.fav.x > got.cart.x, 'and on the left the heart then the cart');
      const centres = Object.values(got).map((i) => i.cy);
      assert.ok(Math.max(...centres) - Math.min(...centres) <= 1, 'the five icons stay level with each other (' + centres.map((c) => c.toFixed(1)).join(', ') + ')');
    } finally { await context.close(); }
  });
}
