'use strict';
/* Owner, 2026-11-22: «سحر الخليج بين يديك» (the title of the section under the hero that lists the qualified perfumes) took a new font but not a new size. Cause: the page's own sheet
   fixes some texts with !important (on a phone the size is 22px) and the design layer wrote the choice without it; the title also sets its own colour and text-shadow, so the effects (gold,
   soft, deep) written on its wrapper never reached the words. Whatever the owner chooses for a text in the editor (font, size, colour, background, effect) must show, on a phone and on a
   laptop, and must go away again when the edit is removed. Real Chromium. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('at ' + size.width + 'px every text choice made for the section title «سحر الخليج بين يديك» shows (font, size, colour, background, effect, alignment) and is undone with the edit', async () => {
    const { context } = await H.openContext(browser, server, size);
    const page = await context.newPage();
    try {
      await page.goto(H.SITE + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null, null, { timeout: 15000 }).catch(() => {});
      await H.quiet(page);
      const got = await page.evaluate(() => {
        const L = ElanDesignLayer, original = JSON.parse(JSON.stringify(L.current() || { version: 1 }));
        const probe = () => { const h = document.querySelector('#intro .magic h2'), cs = getComputedStyle(h); return { size: cs.fontSize, family: cs.fontFamily, color: cs.color, bg: cs.backgroundColor, shadow: cs.textShadow, align: cs.textAlign, inline: h.getAttribute('style') }; };
        const withEdit = (style) => { const d = JSON.parse(JSON.stringify(original)); d.edits = d.edits || {}; d.edits.all = d.edits.all || {}; d.edits.all['hero:magic'] = { style }; L.set(d); L.applyEdits(); return probe(); };
        const none = (() => { const d = JSON.parse(JSON.stringify(original)); if (d.edits && d.edits.all) delete d.edits.all['hero:magic']; L.set(d); L.applyEdits(); return probe(); })();
        const chosen = withEdit({ fontFamily: 'Cairo', fontSize: 40, color: '#0000ff', background: '#ffee00', align: 'left', effect: 'deep' });
        const gold = withEdit({ fontSize: 18, effect: 'gold' });
        const back = (() => { const d = JSON.parse(JSON.stringify(original)); if (d.edits && d.edits.all) delete d.edits.all['hero:magic']; L.set(d); L.applyEdits(); return probe(); })();
        return { none, chosen, gold, back };
      });
      assert.equal(got.chosen.size, '40px', 'the size chosen is the size drawn, whatever the page sheet says');
      assert.match(got.chosen.family, /Cairo/, 'the font');
      assert.equal(got.chosen.color, 'rgb(0, 0, 255)', 'the colour');
      assert.equal(got.chosen.bg, 'rgb(255, 238, 0)', 'the background');
      assert.equal(got.chosen.align, 'left', 'the alignment');
      assert.notEqual(got.chosen.shadow, 'none', 'the «deep» effect reaches the words of the title');
      assert.equal(got.gold.size, '18px', 'a smaller size too');
      assert.notEqual(got.gold.shadow, 'none', 'the «gold» effect reaches the words');
      assert.notEqual(got.gold.color, got.none.color, 'and gives them its colour when none was chosen');
      assert.deepEqual({ ...got.back, inline: null }, { ...got.none, inline: null }, 'removing the edit brings the title back to what the page draws (nothing is left on the words)');
      assert.equal(got.back.inline, got.none.inline, 'also in its own style attribute');
    } finally { await context.close(); }
  });
}
