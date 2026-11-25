'use strict';
/* Owner, 2026-11-25: «في الفوتر رسمة لوجو للمنصة وتحتها شوية عناصر وكلام، بس المسافة بين الرسمة والعناصر صغيرة قوى — كبّرها شوية».
   The logo is part of the footer's artwork (assets/footer-background.webp, drawn over the whole footer, whose height follows its width), and the icons / words / credits under it sit on the
   bottom edge of the footer in pixels, so the room between the logo and the icons shrank with the phone: about 3px at 375px wide, and the icons overlapped the logo under 360px.
   Measured here in real Chromium from the artwork itself (where its last bright rows are drawn), at phone widths, with a made-up design (no offsets the owner saved from the editor):
   the icons start at least ~26px under the logo on every phone width, and from the widths where there was room already nothing moved. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function gapAt(width) {
  const { context } = await H.openContext(browser, server, { name: 'phone-' + width, width, height: 800 });
  const page = await context.newPage();
  try {
    await page.goto(H.SITE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null, null, { timeout: 15000 });
    await page.evaluate(() => ElanDesignLayer.set({ version: 1, edits: { all: {} } }));   // no offsets: what the stylesheet gives the footer
    await H.quiet(page);
    await page.evaluate(() => document.querySelector('footer').scrollIntoView({ block: 'end', behavior: 'instant' }));
    await page.waitForFunction(() => { const i = document.querySelector('footer .footer-background'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 });
    return await page.evaluate(() => {
      const f = document.querySelector('footer'), fr = f.getBoundingClientRect(), img = f.querySelector('.footer-background');
      /* where the logo ends in the artwork: the last rows with bright pixels in its middle (the artwork has nothing bright under the logo) */
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const x0 = Math.floor(c.width * 0.2), w = Math.floor(c.width * 0.6), data = g.getImageData(x0, 0, w, c.height).data;
      let last = -1;
      for (let y = 0; y < c.height; y++) { let n = 0; for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (data[i] > 185 && data[i + 1] > 150) n++; } if (n > 6) last = y; }
      const logoBottom = fr.top + fr.height * ((last + 1) / c.height);
      const icons = f.querySelector('.fph').getBoundingClientRect();
      return { width: Math.round(fr.width), height: Math.round(fr.height), logoEndsAt: +((last + 1) / c.height).toFixed(3), gap: +(icons.top - logoBottom).toFixed(1) };
    });
  } finally { await context.close(); }
}

for (const width of [360, 390, 412]) {
  test('at ' + width + 'px wide the icons under the footer logo start at least ~26px under it, and not far from the room asked for', async () => {
    const got = await gapAt(width);
    assert.ok(got.logoEndsAt > 0.4 && got.logoEndsAt < 0.8, 'the logo was found in the artwork: ' + JSON.stringify(got));
    assert.ok(got.gap >= 26, 'the room between the logo and the icons is ' + got.gap + 'px (it was 3px at 375px): ' + JSON.stringify(got));
    assert.ok(got.gap <= 45, 'and it is a bit more, not a hole: ' + JSON.stringify(got));
  });
}

test('where the footer was already wide enough (430px) the room is not smaller than on the narrower phones', async () => {
  const narrow = await gapAt(390), wide = await gapAt(430);
  assert.ok(wide.gap >= narrow.gap - 1, 'at 430px: ' + JSON.stringify(wide) + ', at 390px: ' + JSON.stringify(narrow));
});
