'use strict';
/* Owner, 2026-11-26: «لما ادخل سيكشن أو كارت وأطلع منه بالضغط على الرئيسية في تسلسل الدخول بلاقيها ترميني بره عند الهيرو وليس عند السيكشن أو الكارت اللي أنا ضغطت عليه...
   وكروت الفئات لما أضغط على كارت مثلا رجالي وأدخله يكون تسلسل الدخول الرئيسية ثم الفئات ثم رجالي، ولما أضغط على الفئات تفتح صفحة فيها كروت الفئات، ونفس الكلام على كروت المناسبات وكروت النوتات العطرية».
   Measured here in real Chromium at the three widths:
   (1) «الرئيسية» of the trail returns to the place the visitor left the home page from (the section or the card he pressed), after a card, after the menu (the page is frozen under it, scrollY reads 0),
       and after moving from one inner page to another (which must not overwrite the place with the top of the page); the place is read from the page, never from a number;
   (2) the trail of a category / occasion / note is الرئيسية › the section › the item, and the section is a page of its own cards (one per item, as on the home page), the item opens its perfumes;
   (3) the Categories cards of the home page link by position (col|cats|0: the owner's saved edits are keyed to that text) and still open «رجالي» with the men's perfumes, not a page called «0» with nothing in it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const trail = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#view .bc a, #view .bc b')).map((e) => e.textContent.trim()));
const names = (page, group) => page.evaluate((g) => CATALOG_TAXONOMY_KEYS[g].map((k) => CATALOG_KEYED_LABELS.ar[g][k]), group);
async function openHome(size, setup) {
  const { context } = await H.openContext(browser, server, size);
  if (setup) await setup(context);
  const page = await context.newPage();
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.ElanDesignLayer && ElanDesignLayer.current() !== null && typeof document.getElementById('mb').onclick === 'function', null, { timeout: 15000 });   // (the store script has built the page and the menu button works: a click before that is lost)
  await H.quiet(page);
  return { context, page };
}
/* A card of the home page brought to the middle of the window (the page scrolls smoothly by its stylesheet: instant here), its place and the place of the page measured. */
const showCard = (page, selector) => page.evaluate((s) => {
  document.documentElement.style.scrollBehavior = 'auto';
  const c = document.querySelector(s); c.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = c.getBoundingClientRect();
  return { y: scrollY, top: r.top, x: Math.min(Math.max(r.left + r.width / 2, 6), innerWidth - 6), cy: r.top + r.height / 2 };
}, selector);
const homeBack = async (page) => {
  await page.click('#view .bc a[data-bc="0"]');
  await page.waitForFunction(() => !document.body.classList.contains('inner'), null, { timeout: 4000 });
  await page.waitForTimeout(150);   // (the page must not slide anywhere after it is shown: an animation, if it existed, would still be moving here)
};

for (const size of H.WIDTHS) {
  test('at ' + size.width + 'px «الرئيسية» of the trail returns to the card the visitor pressed, not to the hero', async () => {
    const { context, page } = await openHome(size);
    try {
      const at = await showCard(page, '#occ .card[data-go^="col|occ|"]');
      assert.ok(at.y > 300, 'the card is down the page: ' + at.y);
      await page.mouse.click(at.x, at.cy);
      await page.waitForFunction(() => document.body.classList.contains('inner'), null, { timeout: 4000 });
      assert.equal((await trail(page)).length, 3, 'a card of the occasions opened its own page: ' + (await trail(page)).join(' › '));
      assert.equal(await page.evaluate(() => scrollY), 0, 'the inner page is shown from its top');
      await homeBack(page);
      const back = await page.evaluate(() => { const r = document.querySelector('#occ .card[data-go^="col|occ|"]').getBoundingClientRect(); return { y: scrollY, top: r.top }; });
      assert.ok(Math.abs(back.y - at.y) <= 2, 'the page is where it was (not at the hero): ' + back.y + ' against ' + at.y);
      assert.ok(Math.abs(back.top - at.top) <= 2, 'and the card is where it was in the window: ' + back.top.toFixed(1) + ' against ' + at.top.toFixed(1));
    } finally { await context.close(); }
  });

  test('at ' + size.width + 'px the place is kept through the menu (the page is frozen under it) and through inner pages', async () => {
    const { context, page } = await openHome(size);
    try {
      const at = await showCard(page, '#occ .card[data-go^="col|occ|"]');
      await page.click('#mb');
      await page.waitForFunction(() => document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      assert.equal(await page.evaluate(() => scrollY), 0, 'the page is held still under the menu: scrollY reads 0 there');
      await page.click('#menu [data-go="sec|occ"]');
      await page.waitForFunction(() => document.body.classList.contains('inner') && !document.body.classList.contains('sheet-open'), null, { timeout: 4000 });
      assert.deepEqual(await trail(page), ['الرئيسية', (await trail(page))[1]], 'the menu opened the page of the occasions');
      await homeBack(page);
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - at.y) <= 2, 'after the menu, «الرئيسية» returns to where he was, not to the hero');
      /* home → the page of the occasions → a card → «مناسبات» of the trail → a card → «الرئيسية»: moving between inner pages did not overwrite the place with the top of the page */
      await page.evaluate(() => go('sec|occ'));
      await page.click('#view .taxo-grid .card:first-child');
      await page.click('#view .bc a[data-bc="1"]');
      await page.click('#view .taxo-grid .card:nth-child(2)');
      assert.equal((await trail(page)).length, 3);
      await homeBack(page);
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - at.y) <= 2, 'and after three inner pages it is still the place he left the home page from');
    } finally { await context.close(); }
  });

  for (const [group, menu] of [['cats', 'الفئات'], ['occ', 'مناسبات'], ['notes', 'نوتات عطرية']]) {
    test('at ' + size.width + 'px «' + menu + '» is a page of its own cards, and a card is الرئيسية › ' + menu + ' › the card', async () => {
      const { context, page } = await openHome(size);
      try {
        const labels = await names(page, group);
        await page.evaluate((g) => go('sec|' + g), group);
        assert.deepEqual(await trail(page), ['الرئيسية', menu], 'the trail of the page of the section');
        const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#view .taxo-grid .card')).map((c) => ({ go: c.dataset.go, text: c.querySelector('h4').textContent.trim(), w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height })));
        assert.deepEqual(cards.map((c) => c.text), labels, 'one card per item, with the names of the home page');
        assert.equal(await page.evaluate(() => document.querySelectorAll('#view .section-perfume-grid').length), 0, 'the page of the section is not a heap of perfumes');
        for (const c of cards) assert.ok(c.w > 150 && c.h > 100 && Math.abs(c.h / c.w - 0.75) < 0.03, 'a card of the page is a card, 4:3: ' + JSON.stringify(c));
        await page.click('#view .taxo-grid .card:nth-child(2)');
        assert.deepEqual(await trail(page), ['الرئيسية', menu, labels[1]], 'the trail of an item: the section in the middle, the item at the end');
        assert.equal(await page.evaluate(() => document.querySelectorAll('#view .taxo-grid').length), 0, 'the page of an item is the page of its perfumes');
        await page.click('#view .bc a[data-bc="1"]');
        assert.deepEqual(await trail(page), ['الرئيسية', menu], 'pressing the section in the trail opens the page of its cards');
        assert.equal(await page.evaluate(() => document.querySelectorAll('#view .taxo-grid .card').length), labels.length);
      } finally { await context.close(); }
    });
  }
}

/* The Categories cards of the home page link by position (the owner's saved edits are keyed to the text col|cats|0) and the page they open goes by key. */
const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const S1 = id(1);
const ITEMS = [{ k: 'A', name: 'عطر رجالي أول', gender: 'men' }, { k: 'B', name: 'عطر رجالي ثان', gender: 'men' }, { k: 'C', name: 'عطر نسائي أول', gender: 'women' }];
const P = {}, SZ = {}, SP = {};
ITEMS.forEach((it, i) => { P[it.k] = id(10 + i * 10); SZ[it.k] = id(11 + i * 10); SP[it.k] = id(12 + i * 10); });
const offer = (it) => ({ product_size_id: SZ[it.k], product_id: P[it.k], store_product_id: SP[it.k], store_id: S1, store_name: 'متجر ألف', price: 100, currency: 'EGP', stock_quantity: 5, price_includes_tax: true, price_includes_shipping: false });
const TABLES = {
  public_brands: [{ name: 'ماركة', slug: 'brand' }],
  public_stores: [{ id: S1, name: 'متجر ألف', short_description: '' }],
  public_products: ITEMS.map((it) => ({ id: P[it.k], name: it.name, brand_name: 'ماركة', sales_count: 0, views_count: 0, search_count: 0, average_rating: null, reviews_count: 0, short_description: '', official_description: '', composition: '', gender: it.gender })),
  product_sizes: ITEMS.map((it) => ({ id: SZ[it.k], size_label: '100 مل', size_ml: 100, product_id: P[it.k] })),
  catalog_platform_offers: ITEMS.map(offer),
  catalog_eligible_offers: ITEMS.map((it) => Object.assign(offer(it), { is_new_arrival: false, is_coming_soon: false }))
};
const withCatalog = async (context) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await context.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'sbgdtuqfrnfeggkwqtrw.supabase.co') return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(TABLES[url.pathname.replace('/rest/v1/', '')] || []) });
  });
};

for (const size of [H.WIDTHS[0], H.WIDTHS[2]]) {
  test('at ' + size.width + 'px the home page card «رجالي» opens «رجالي» with the men\'s perfumes (الرئيسية › الفئات › رجالي), and «الفئات» opens the cards', async () => {
    const { context, page } = await openHome(size, withCatalog);
    try {
      await page.waitForFunction(() => typeof PERFUMES !== 'undefined' && PERFUMES.length === 3, null, { timeout: 15000 });
      const at = await showCard(page, '#cats .card[data-go="col|cats|0"]');
      await page.mouse.click(at.x, at.cy);
      await page.waitForFunction(() => document.body.classList.contains('inner'), null, { timeout: 4000 });
      assert.deepEqual(await trail(page), ['الرئيسية', 'الفئات', 'رجالي'], 'the title of the page is the category, not its position');
      const shown = await page.evaluate(() => Array.from(document.querySelectorAll('#view .section-perfume-grid .card')).map((c) => c.innerText));
      assert.equal(shown.length, 2, 'the two men\'s perfumes, not an empty page: ' + shown.length);
      assert.ok(shown.every((t) => /رجالي/.test(t)) && !shown.some((t) => /نسائي/.test(t)), 'and only them');
      await page.click('#view .bc a[data-bc="1"]');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#view .taxo-grid .card').length), 3, '«الفئات» opens the three cards of the categories');
      await page.click('#view .taxo-grid .card:nth-child(2)');
      assert.deepEqual(await trail(page), ['الرئيسية', 'الفئات', 'نسائي']);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#view .section-perfume-grid .card').length), 1, 'the women\'s perfume');
      await homeBack(page);
      assert.ok(Math.abs(await page.evaluate(() => scrollY) - at.y) <= 2, 'and «الرئيسية» returns to the card of the home page the visitor pressed');
    } finally { await context.close(); }
  });
}
