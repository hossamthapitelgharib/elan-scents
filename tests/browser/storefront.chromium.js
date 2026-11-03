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

test('the brands strip has no title and no gold line and sits right under the counters; the brands pages have no title and the breadcrumb says «البراندات»', async () => {
  const { context, page, errors } = await visit(H.WIDTHS[0]);
  try {
    /* the test server answers every catalog request with an empty list, so give the page a few brands to draw */
    await page.evaluate(() => { BR = ['AMOUAGE', 'ARMAF', 'AFNAN']; render(); });
    await page.waitForTimeout(300);
    const home = await page.evaluate(() => {
      const sec = document.getElementById('brands'), counters = document.querySelector('#intro .counters').getBoundingClientRect();
      const pill = sec.querySelector('.sub'), pillBox = pill.getBoundingClientRect();
      const others = Array.from(document.querySelectorAll('#main > section[id]')).filter((s) => s.id !== 'brands');
      return {
        title: !!sec.querySelector('h3'), cards: sec.querySelectorAll('.strip .card').length, hasArrow: !!pill, gap: Math.round(pillBox.top - counters.bottom),
        iconsBelowArrow: sec.querySelector('.strip .card').getBoundingClientRect().top >= pillBox.bottom,
        others: others.length, othersWithTitle: others.filter((s) => s.querySelector('h3')).length
      };
    });
    assert.equal(home.title, false, 'no title (and so no gold line under it) in the brands section');
    assert.ok(home.cards >= 1 && home.hasArrow, 'the brand icons and the oval arrow are still there');
    assert.ok(home.gap >= 0 && home.gap <= 40, 'the arrow starts right under the counters, not ' + home.gap + 'px below them');
    assert.ok(home.iconsBelowArrow, 'the brand icons follow the arrow');
    assert.ok(home.others >= 3 && home.othersWithTitle === home.others, 'every other section keeps its title');

    await page.evaluate(() => { go('brand|AMOUAGE'); });
    await page.waitForTimeout(600);
    const brand = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumb: (document.querySelector('#view .bc b') || {}).textContent || '', middle: ((document.querySelector('#view .bc a[data-bc="1"]') || {}).textContent || '').trim(), filters: !!document.querySelector('#view .filter-panel') }));
    assert.equal(brand.titles, 0, 'a brand\'s own page has no title');
    assert.equal(brand.crumb, 'AMOUAGE', 'the breadcrumb still says which brand this is');
    assert.ok(brand.filters, 'the filters follow the breadcrumb');
    assert.equal(brand.middle, 'البراندات', 'on a brand\'s page the breadcrumb calls the brands section «البراندات», not its long tagline');

    await page.evaluate(() => { go('sec|brands'); });
    await page.waitForTimeout(400);
    const all = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumb: (document.querySelector('#view .bc b') || {}).textContent || '', cards: document.querySelectorAll('#view .grid .card').length, text: document.getElementById('view').innerText }));
    assert.equal(all.titles, 0, 'the page of all brands has no title (so no gold line under it either)');
    assert.equal(all.crumb, 'البراندات', 'its breadcrumb says «البراندات»');
    assert.ok(all.cards >= 1, 'the brand cards are still there');
    assert.ok(!/للفخامة عنوان وللرقي حضور/.test(all.text), 'the tagline is nowhere on the page');

    await page.evaluate(() => { go('sec|all'); });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll('#view h3').length), 1, 'the other inner pages keep their title');
    assert.deepEqual(errors, [], 'no page error');
  } finally { await context.close(); }
});
