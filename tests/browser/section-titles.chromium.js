'use strict';
/* Owner, 2026-11-24: «قرب المسافة بين كلمة ماستربيسز والسهم … وارفعهم مع الصورة لفوق شوية وتبقى المسافة متماثلة مع العناصر بالصفحة», and «احذف الخط الذهبي تحت العناوين وأعلى الفوتر».
   Two needs, pinned here in real Chromium without any number the owner can change from the editor:
   (1) when a section's title is moved up or down in the editor, the arrow under it, the cards under that and the next section move WITH it, so the gap between the title and its arrow, and the
       gap between the arrow and the block, stay exactly what they are when the title is not moved (before this the title went alone and left its arrow 60px behind, and the arrow cannot be picked);
   (2) nothing is drawn as a gold line under a title or at the top of the footer, and the boxes that held those lines are still there, so the spacing is the one the owner had.
   The offsets below are made up for this test (a synthetic design), never read from design/home.json: the owner moves his titles from the editor and saves, and a test must not turn that into a red main. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function visit(size) {
  const { context } = await H.openContext(browser, server, size);
  const page = await context.newPage();
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForSelector('#master h3', { state: 'attached' });
  await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null, null, { timeout: 15000 });
  await H.quiet(page);
  return { context, page };
}

// what the eye reads: where the words of the title end, where the arrow pill is, and where the block under the arrow starts
const measure = () => {
  const sec = document.getElementById('master'), h = sec.querySelector('h3'), sub = sec.querySelector('.sub');
  const rg = document.createRange(); rg.selectNodeContents(h);
  const glyph = rg.getBoundingClientRect(), arrow = sub.getBoundingClientRect(), below = sub.nextElementSibling.getBoundingClientRect();
  return { glyphTop: glyph.top + scrollY, glyphBottom: glyph.bottom + scrollY, arrowTop: arrow.top + scrollY, arrowBottom: arrow.bottom + scrollY, belowTop: below.top + scrollY, nextSection: sec.nextElementSibling.getBoundingClientRect().top + scrollY };
};
const design = (page, dy) => page.evaluate((v) => {
  const edits = { all: {} }; if (v) edits.all['sec:master:title'] = { dy: v };
  ElanDesignLayer.set({ version: 1, edits });
}, dy);

for (const size of H.WIDTHS) {
  test('at ' + size.width + 'px a Masterpieces title the owner moves up or down takes its arrow, its cards and the next section along, and every gap stays the same', async () => {
    const { context, page } = await visit(size);
    try {
      await design(page, 0); await H.quiet(page);
      const base = await page.evaluate(measure);
      assert.ok(base.arrowTop > base.glyphBottom && base.belowTop > base.arrowBottom, 'the page has the usual order: title, arrow, block (' + JSON.stringify(base) + ')');
      for (const dy of [-40, -12, 25]) {
        await design(page, dy); await H.quiet(page);
        const m = await page.evaluate(measure);
        const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1.2, what + ' (dy ' + dy + '): ' + a.toFixed(1) + ' against ' + b.toFixed(1) + ' — ' + JSON.stringify({ base, m }));
        near(m.glyphTop - base.glyphTop, dy, 'the title itself still moves by the amount the owner gave it');
        near(m.arrowTop - m.glyphBottom, base.arrowTop - base.glyphBottom, 'the room between the title and its arrow is what it was');
        near(m.belowTop - m.arrowBottom, base.belowTop - base.arrowBottom, 'the room between the arrow and the picture is what it was');
        near(m.arrowTop - base.arrowTop, dy, 'the arrow went with the title');
        near(m.belowTop - base.belowTop, dy, 'the picture went with the title');
        near(m.nextSection - base.nextSection, dy, 'the next section followed, so no hole and no overlap is left in the page');
      }
      await design(page, 0); await H.quiet(page);
      const back = await page.evaluate(measure);
      assert.ok(Math.abs(back.arrowTop - base.arrowTop) <= 1 && Math.abs(back.nextSection - base.nextSection) <= 1, 'taking the offset away puts everything back (' + JSON.stringify({ base, back }) + ')');
    } finally { await context.close(); }
  });
}

test('no gold line is drawn under a title or at the top of the footer, and their boxes are still in the page', async () => {
  const { context, page } = await visit(H.WIDTHS[0]);
  try {
    const got = await page.evaluate(() => {
      const draws = (cs) => cs.backgroundImage !== 'none' || !/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(cs.backgroundColor);
      const titles = Array.from(document.querySelectorAll('h3')).map((h) => { const a = getComputedStyle(h, '::after'); return { draws: draws(a), height: a.height, display: a.display }; });
      const fdiv = document.querySelector('footer .fdiv'), f = getComputedStyle(fdiv);
      return { titles, footer: { draws: draws(f), height: f.height, width: f.width } };
    });
    assert.ok(got.titles.length > 3, 'the home page has its section titles');
    got.titles.forEach((t, i) => { assert.equal(t.draws, false, 'title ' + i + ' draws no line under itself'); assert.equal(t.display, 'block', 'title ' + i + ' keeps the box that held the line'); assert.ok(parseFloat(t.height) > 0, 'with a height of its own, so the room under the title did not shrink'); });
    assert.equal(got.footer.draws, false, 'the divider at the top of the footer draws nothing');
    assert.ok(parseFloat(got.footer.height) > 0, 'but it keeps its place in the page');
  } finally { await context.close(); }
});
