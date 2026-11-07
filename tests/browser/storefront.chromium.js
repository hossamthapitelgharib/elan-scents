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

test('the brands strip has no title and no gold line and sits right under the counters; the brands pages and the all-perfumes page have no title, the breadcrumb says «البراندات» / «كل العطور»', async () => {
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

    // the inner page of «سحر الخليج بين يديك» (all perfumes): no title and no gold line, but «كل العطور» stays in the breadcrumb
    await page.evaluate(() => { go('sec|all'); });
    await page.waitForTimeout(400);
    const perfumes = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumb: (document.querySelector('#view .bc b') || {}).textContent || '', filters: !!document.querySelector('#view .filter-panel'), text: document.getElementById('view').innerText }));
    assert.equal(perfumes.titles, 0, 'the all-perfumes page has no title (so no gold line under it either)');
    assert.equal(perfumes.crumb, 'كل العطور', 'but «كل العطور» stays in the breadcrumb');
    assert.ok(perfumes.filters, 'the filters follow the breadcrumb');

    // no inner page has a title: the breadcrumb names it, and each section is called there by its plain menu word
    const menuWord = { offers: 3, new: 4, master: 5, cats: 6, occ: 7, notes: 8, stores: 9 };
    for (const go of ['sec|offers', 'sec|new', 'sec|cats', 'sec|master', 'sec|occ', 'sec|notes', 'sec|stores', 'col|cats|0', 'store|Afnan Egypt']) {
      await page.evaluate((g) => { go(g); }, go);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({ titles: document.querySelectorAll('#view h3').length, crumbs: [...document.querySelectorAll('#view .bc a, #view .bc b')].map((e) => e.textContent.trim()) }));
      assert.equal(r.titles, 0, go + ': no title (and no gold line under it)');
      const second = r.crumbs[1], expected = await page.evaluate((id) => (id ? T().menu[id] : null), menuWord[go.split('|')[1]]);
      if (expected) assert.equal(second, expected, go + ': the breadcrumb calls the section «' + expected + '»');
      assert.ok(r.crumbs.length >= 2 && r.crumbs.every(Boolean), go + ': the breadcrumb names the page: ' + r.crumbs.join(' › '));
    }
    assert.deepEqual(errors, [], 'no page error');
  } finally { await context.close(); }
});

test('the menu page has no lines between its items and its close button looks like the cart page\'s', async () => {
  const { context, page, errors } = await visit(H.WIDTHS[0]);
  try {
    const css = (sel) => page.evaluate((q) => { const e = document.querySelector(q), c = getComputedStyle(e), r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), bg: c.backgroundColor, border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor, radius: c.borderRadius, color: c.color, font: c.fontSize, shadow: c.boxShadow, text: e.textContent.trim() }; }, sel);
    await page.evaluate(() => document.getElementById('mb').click());
    await page.waitForTimeout(700);
    const lines = await page.evaluate(() => [...document.querySelectorAll('#menu a')].map((a) => parseFloat(getComputedStyle(a).borderBottomWidth) + parseFloat(getComputedStyle(a).borderTopWidth)));
    assert.ok(lines.length >= 10, 'the menu lists its items: ' + lines.length);
    assert.deepEqual(lines.filter((n) => n > 0), [], 'no menu item has a line above or below it');
    const menuX = await css('#menu .mx');
    await page.evaluate(() => document.querySelector('#menu .mx').click());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.getElementById('menu').classList.contains('open')), false, 'the × closes the menu');
    await page.evaluate(() => { sheet('cart'); });
    await page.waitForTimeout(600);
    const cartX = await css('#sheet .sheet-close');
    assert.deepEqual(menuX, cartX, 'the menu\'s close button is drawn exactly like the cart page\'s');
    assert.equal(menuX.text, '\u00d7');
    assert.deepEqual(errors, [], 'no page error');
  } finally { await context.close(); }
});

test('every menu entry that is a section opens that section\'s own page; only «عن» and «تواصل معنا» scroll to their place on the home page', async () => {
  const { context, page, errors } = await visit(H.WIDTHS[0]);
  try {
    const links = await page.evaluate(() => ({ pages: [...document.querySelectorAll('#menu a[data-go]')].map((a) => a.getAttribute('data-go')), anchors: [...document.querySelectorAll('#menu a[href^="#"]:not(.mlogo)')].map((a) => a.getAttribute('href')) }));
    assert.deepEqual(links.pages, ['sec|all', 'sec|brands', 'sec|offers', 'sec|new', 'sec|cats', 'sec|master', 'sec|occ', 'sec|notes', 'sec|stores'], 'the menu entries that are sections open pages');
    assert.deepEqual(links.anchors, ['#about', '#contact'], 'only the two parts of the home page that have no page of their own are anchors');
    for (const go of links.pages) {
      await page.evaluate(() => { document.body.classList.remove('inner'); document.getElementById('mb').click(); });
      await page.waitForTimeout(400);
      await page.evaluate((g) => document.querySelector('#menu a[data-go="' + g + '"]').click(), go);
      await page.waitForTimeout(500);
      const r = await page.evaluate((g) => {
        const id = g.split('|')[1];
        return { inner: document.body.classList.contains('inner'), open: document.getElementById('menu').classList.contains('open'), crumb: ((document.querySelector('#view .bc b') || {}).textContent || '').trim(), expected: id === 'all' ? LB[lang].all2 : T().menu[{ brands: 2, offers: 3, new: 4, master: 5, cats: 6, occ: 7, notes: 8, stores: 9 }[id]] };
      }, go);
      assert.equal(r.inner, true, go + ': opens an inner page');
      assert.equal(r.open, false, go + ': the menu closes');
      assert.equal(r.crumb, r.expected, go + ': the page is the section\'s own page (breadcrumb «' + r.expected + '»)');
      assert.equal(await page.evaluate(() => document.querySelectorAll('#view h3').length), 0, go + ': and it has no title of its own');
    }
    for (const id of ['about', 'contact']) {
      await page.evaluate(() => { document.body.classList.add('inner'); document.getElementById('mb').click(); });
      await page.waitForTimeout(400);
      await page.evaluate((x) => document.querySelector('#menu a[href="#' + x + '"]').click(), id);
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => ({ inner: document.body.classList.contains('inner'), open: document.getElementById('menu').classList.contains('open') }));
      assert.deepEqual(r, { inner: false, open: false }, '#' + id + ': back on the home page, menu closed');
    }
    assert.deepEqual(errors, [], 'no page error');
  } finally { await context.close(); }
});

test('Masterpieces page: the chips are the filter (no filter panel under them), each one ranks the perfumes, and the selected one is the gold of the contact form\'s send button', async () => {
  const { context, page, errors } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => {
      const mk = (id, name, brand, sales, views, ind) => { const offer = { store: 'S', storeId: 's1', storeProductId: 'sp' + id, price: 100, cur: 'EGP', avail: true, flags: ['master'], stock: 5, tax: true, ship: false }; return { id, pid: id, name, pn: name, brand, sz: '100 مل', img: '', cats: [0], occs: [0], notes: [0], rating: 0, sales, views, searches: 0, requests: 0, rel: sales, ts: 0, ind, sd: 's', desc: 'd', comp: 'c', globalOffer: offer, allEligibleOffers: [offer], offersByStore: { s1: offer } }; };
      PERFUMES = [mk('a', 'عطر منخفض', 'X', 10, 250, ['sales', 'views', 'topBrand']), mk('b', 'عطر الأعلى', 'Y', 100, 25, ['sales', 'views', 'topBrand']), mk('c', 'عطر وسط', 'Y', 50, 90, ['sales', 'views'])];
      go('sec|master');
    });
    await page.waitForTimeout(600);
    const names = () => page.evaluate(() => [...document.querySelectorAll('#res .card h4')].map((h) => h.textContent));
    const state = await page.evaluate(() => ({ chips: [...document.querySelectorAll('#view .chip')].map((c) => c.dataset.ind), panel: document.querySelectorAll('#view .filter-panel, #view .filter-head, #view select').length, h3: document.querySelectorAll('#view h3').length }));
    assert.deepEqual(state.chips, ['sales', 'views', 'topBrand'], 'the three chips of the page');
    assert.equal(state.panel, 0, 'no filter panel, no dropdowns: the chips are the filter');
    assert.equal(state.h3, 0);
    assert.deepEqual(await names(), ['عطر الأعلى', 'عطر وسط', 'عطر منخفض'], 'with no chip: the usual order (by popularity)');
    await page.click('#view .chip[data-ind="views"]');
    assert.deepEqual(await names(), ['عطر منخفض', 'عطر وسط', 'عطر الأعلى'], 'most viewed: the most viewed first');
    await page.click('#view .chip[data-ind="sales"]');
    assert.deepEqual(await names(), ['عطر الأعلى', 'عطر وسط', 'عطر منخفض'], 'best sellers: the best selling first');
    await page.click('#view .chip[data-ind="topBrand"]');
    assert.deepEqual(await names(), ['عطر الأعلى', 'عطر منخفض'], 'each brand\'s best seller only');
    await page.waitForTimeout(400); /* the chip fades to its selected colours over .2s */
    const paint = await page.evaluate(() => {
      const cs = (e) => { const s = getComputedStyle(e); return { bg: s.backgroundImage, color: s.color }; };
      const on = document.querySelector('#view .chip.on'), send = document.querySelector('#contact .btn'), off = document.querySelector('#view .chip:not(.on)');
      return { onCount: document.querySelectorAll('#view .chip.on').length, pressed: on.getAttribute('aria-pressed'), on: cs(on), onIcon: getComputedStyle(on.querySelector('svg')).color, send: cs(send), off: cs(off) };
    });
    assert.equal(paint.onCount, 1);
    assert.equal(paint.pressed, 'true');
    assert.equal(paint.on.bg, paint.send.bg, 'the selected chip has the same gold gradient as the «إرسال» button');
    assert.ok(/gradient/.test(paint.on.bg), 'and it is a gradient, not the old dark brown');
    assert.equal(paint.on.color, paint.send.color, 'with the same white text');
    assert.equal(paint.onIcon, paint.send.color, 'and a white icon');
    assert.ok(!/gradient/.test(paint.off.bg), 'the other chips stay plain');
    await page.click('#view .chip[data-ind="topBrand"]');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#view .chip.on').length), 0, 'pressing the chosen chip again clears it');
    assert.equal((await names()).length, 3, 'and all the masterpieces are back');
    await page.evaluate(() => go('sec|offers'));
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => !!document.querySelector('#view .filter-panel')), 'the other list pages keep their filter panel');
    assert.deepEqual(errors, [], 'no page error');
  } finally { await context.close(); }
});

test('storefront filters use exact unified sizes and owners; a changed cart offer is blocked', async () => {
  const { context, page, errors } = await visit(H.WIDTHS[0]);
  try {
    await page.evaluate(() => {
      const offer = (store, storeId, storeProductId, price) => ({ store, storeId, storeProductId, price, cur: 'EGP', avail: true, flags: [], stock: 10, tax: true, ship: false });
      const mk = (id, name, sizeMl, o) => ({ id, pid: 'catalog-product', name, pn: name, brand: 'Brand', sizeMl, sz: sizeMl + ' مل', img: '', gender: 'unisex', cats: [], categoryIds: [], categoryKeys: ['unisex'], occs: [], occasionKeys: [], notes: [], noteKeys: [], rating: 0, sales: 0, views: 0, searches: 0, requests: 0, rel: 0, ts: 0, ind: [], sd: 'desc', desc: 'description', comp: 'composition', globalOffer: o, allEligibleOffers: [o], offersByStore: { [o.storeId]: o } });
      ST = [['Store A', '', 'store-a'], ['Store B', '', 'store-b']];
      BR = ['Brand'];
      CATALOG_SIZE_OPTIONS = [50, 100];
      PERFUMES = [
        mk('size-a', 'Perfume 50', 50, offer('Store A', 'store-a', 'sp-a-new', 100)),
        mk('size-b', 'Perfume 100', 100, offer('Store B', 'store-b', 'sp-b', 90))
      ];
      go('sec|all');
    });
    await page.waitForTimeout(300);
    await page.locator('#view .filter-panel summary').click();
    await page.waitForTimeout(100);
    const select = async (key, value) => {
      await page.locator('#view select[data-k="' + key + '"]').selectOption(value);
      await page.waitForTimeout(100);
    };
    const names = () => page.evaluate(() => [...document.querySelectorAll('#res .card h4')].map((h) => h.textContent.trim()));
    assert.deepEqual(await names(), ['Perfume 50', 'Perfume 100']);
    await select('size', '50');
    assert.deepEqual(await names(), ['Perfume 50'], 'the size filter matches only the selected unified product size');
    await select('size', '');
    await select('st', 'store-b');
    assert.deepEqual(await names(), ['Perfume 100'], 'the store filter matches the owner of the global offer, not an alternate seller');

    await page.evaluate(() => {
      go('store|Store A');
      CART = [{ sid: 'size-a', storeProductId: 'sp-a-old', storeId: 'store-a', storeName: 'Store A', observedPrice: 95, currency: 'EGP', q: 1 }];
      document.getElementById('sheetB').innerHTML = cartHTML();
    });
    const stale = await page.evaluate(() => ({
      storeProducts: [...document.querySelectorAll('#res .card h4')].map((h) => h.textContent.trim()),
      notice: document.querySelector('#sheetB .cart-review')?.textContent.trim() || '',
      disabled: document.querySelector('#sheetB [data-order-store]')?.disabled
    }));
    assert.deepEqual(stale.storeProducts, ['Perfume 50'], 'the populated store page renders without relying on a legacy offers array');
    assert.match(stale.notice, /تغيّر السعر|التوفر/);
    assert.equal(stale.disabled, true, 'a stale line cannot be checked out before review');
    assert.deepEqual(errors, [], 'no browser error across filter, store and cart routes');
  } finally { await context.close(); }
});
