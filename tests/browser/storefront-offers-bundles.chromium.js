'use strict';
/* Bundles and offers, in a real Chromium, with a Supabase that answers a small catalog (the owner's rules of 2026-11-14/15 and the agreement of 2026-11-17):
   - an OFFER is a promotional message from the store, no price change, tagged «عرض»; the platform has no discount concept, so the word «خصم» is on no page;
   - a perfume shows the message of the store whose offer it shows (the other store's message stays hidden);
   - a number a store typed as "price before / after" (original_price here) is on no page at all;
   - «باقات وعروض» (owner, 2026-11-27) is two cards side by side, 5:7: the bundles (cheapest eligible offer per bundle; the card is a card of a perfume, its pieces and the store's whole
     description are on its own page, and it has no cart button yet) and the offers (the perfumes a store promotes, with the store-wide messages); the filter panel has «باقات» and «عروض» buttons;
   - everything a store wrote is escaped, and no page scrolls sideways. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const S1 = id(1), S2 = id(2);
const P = { A: id(10), E: id(50) }, SZ = { A: id(11), E: id(51) }, SPA = { A: id(12), E: id(52) }, SPB = { E: id(53) };
const NAMES = { A: 'عطر ألف', E: 'عطر هاء' };
const STORES = { [S1]: 'متجر ألف', [S2]: 'متجر باء' };
const B1 = id(100), B2 = id(101), B3 = id(102);

const row = (k, storeId, sp, price, stock) => ({ product_size_id: SZ[k], product_id: P[k], store_product_id: sp, store_id: storeId, store_name: STORES[storeId], price, currency: 'EGP', stock_quantity: stock, price_includes_tax: true, price_includes_shipping: false });
// A is sold by store A only (100). E: store B is the cheapest (80), store A is dearer (90) -> the platform offer of E is store B's.
// The claimed "old price" numbers below are what stores may send: they must show nowhere.
const PLATFORM = [Object.assign(row('A', S1, SPA.A, 100, 5), { original_price: 999, discount_percentage: 90 }), row('E', S2, SPB.E, 80, 3)];
const ELIGIBLE = PLATFORM.concat([row('E', S1, SPA.E, 90, 4)]).map((r) => Object.assign({}, r, { is_new_arrival: false, is_coming_soon: false }));
const MESSAGES = [
  { offer_id: id(200), store_id: S1, store_name: STORES[S1], product_size_id: SZ.A, kind: 'offer', title: 'اشترِ عطرين واحصل على هدية', description: 'هدية مع كل عبوتين', ends_at: null },
  { offer_id: id(201), store_id: S1, store_name: STORES[S1], product_size_id: SZ.A, kind: 'offer', title: '<img src=x onerror="window.__xss=1">', description: '', ends_at: null },
  { offer_id: id(202), store_id: S2, store_name: STORES[S2], product_size_id: SZ.E, kind: 'offer', title: '11/11 Sale', description: '', ends_at: null },
  { offer_id: id(203), store_id: S1, store_name: STORES[S1], product_size_id: SZ.E, kind: 'offer', title: 'رسالة متجر ألف على عطر هاء', description: '', ends_at: null },
  { offer_id: id(204), store_id: S1, store_name: STORES[S1], product_size_id: null, kind: 'offer', title: 'شحن مجاني فوق 1500', description: '', ends_at: null }
];
// A bundle stands on its own: the store's OWN title and full description (with line breaks) and pieces written as the store listed them, with no catalog id.
const BUNDLE_OFFERS = [
  { store_bundle_id: id(300), bundle_id: B1, store_id: S1, store_name: STORES[S1], title: 'باقة الهدايا (عنوان المتجر)', description: 'السطر الأول\nالسطر الثاني <img src=x onerror="window.__xss=2">', price: '300.00', currency: 'EGP', stock_quantity: 5, price_includes_tax: true, price_includes_shipping: false },
  { store_bundle_id: id(301), bundle_id: B2, store_id: S2, store_name: STORES[S2], title: 'باقة مع قطعة إضافية', description: null, price: '450.00', currency: 'EGP', stock_quantity: 2, price_includes_tax: true, price_includes_shipping: false },
  { store_bundle_id: id(302), bundle_id: B3, store_id: S1, store_name: STORES[S1], title: 'باقة نفدت', description: '', price: '10.00', currency: 'EGP', stock_quantity: 0, price_includes_tax: true, price_includes_shipping: false }
];
const BUNDLES = [
  { id: B1, brand_name: 'ماركة', name: 'اسم داخلي ١', slug: 'gifts', has_extra_items: false },
  { id: B2, brand_name: 'ماركة', name: 'اسم داخلي ٢', slug: 'extra', has_extra_items: true },
  { id: B3, brand_name: 'ماركة', name: 'باقة نفدت', slug: 'gone', has_extra_items: false }
];
const ITEMS = [
  { bundle_id: B1, quantity: 2, brand_name: 'ماركة', product_name: NAMES.A, size_ml: 100 },
  { bundle_id: B1, quantity: 1, brand_name: null, product_name: NAMES.E, size_ml: 30 },
  { bundle_id: B2, quantity: 1, brand_name: 'ماركة', product_name: NAMES.A, size_ml: 100 },
  { bundle_id: B2, quantity: 1, brand_name: null, product_name: NAMES.E, size_ml: 12 },
  { bundle_id: B3, quantity: 1, brand_name: 'ماركة', product_name: NAMES.A, size_ml: 100 }
];
const TABLES = {
  public_brands: [{ name: 'ماركة', slug: 'brand' }],
  public_stores: [{ id: S1, name: STORES[S1], short_description: '' }, { id: S2, name: STORES[S2], short_description: '' }],
  public_products: Object.keys(P).map((k) => ({ id: P[k], name: NAMES[k], brand_name: 'ماركة', sales_count: 0, views_count: 0, search_count: 0, average_rating: null, reviews_count: 0, short_description: '', official_description: '', composition: '', gender: 'unisex' })),
  product_sizes: Object.keys(P).map((k) => ({ id: SZ[k], size_label: '100 مل', size_ml: 100, product_id: P[k] })),
  // the stores' own offer rows (which perfume a store promotes): what puts a perfume on the «باقات وعروض» page
  offers: [{ product_size_id: SZ.A, store_id: S1 }, { product_size_id: SZ.E, store_id: S2 }],
  catalog_platform_offers: PLATFORM,
  catalog_eligible_offers: ELIGIBLE,
  catalog_platform_bundle_offers: BUNDLE_OFFERS,
  public_bundles: BUNDLES,
  public_bundle_items: ITEMS,
  catalog_offer_messages: MESSAGES
};

async function openStore(size) {
  const { context, problems } = await H.openContext(browser, server, size);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  await context.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'sbgdtuqfrnfeggkwqtrw.supabase.co') return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const table = url.pathname.replace('/rest/v1/', '');
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(TABLES[table] || []) });
  });
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof PERFUMES !== 'undefined' && PERFUMES.length === 2 && typeof BUNDLES !== 'undefined' && BUNDLES.length === 2, null, { timeout: 15000 });
  return { context, page, errors, problems };
}
const shotDir = process.env.ELAN_SHOTS;
const shot = async (page, name) => { if (shotDir) { require('node:fs').mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: shotDir + '/' + name + '.png', fullPage: true }); } };
const shotEl = async (page, selector, name) => { if (shotDir) { require('node:fs').mkdirSync(shotDir, { recursive: true }); const box = await page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: Math.max(0, r.left + scrollX), y: r.top + scrollY, width: Math.min(r.width, document.documentElement.clientWidth), height: r.height }; }, selector); await page.screenshot({ path: shotDir + '/' + name + '.png', fullPage: true, clip: box }); } };
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('«باقات وعروض»: the home block and the page are two cards (5:7), one for the bundles and one for the offers, each opening its own page', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    const home = await page.evaluate(() => [...document.querySelectorAll('#offers .strip .card')].map((c) => { const r = c.getBoundingClientRect(); return { go: c.getAttribute('data-go'), name: c.querySelector('h4').textContent.trim(), count: (c.querySelector('small') || {}).textContent || null, w: r.width, h: r.height, top: Math.round(r.top + scrollY), art: !!c.querySelector('.artbg') }; }));
    assert.deepEqual(home.map((c) => [c.go, c.name]), [['col|offers|bundles', 'باقات'], ['col|offers|offers', 'عروض']], 'a card for the bundles and a card for the offers, nothing else in the block');
    assert.equal(home[0].count, 'باقتان', 'the bundles card counts the two bundles that can be bought');
    assert.equal(home[1].count, 'عرضان', 'the offers card counts the two perfumes a store promotes');
    assert.equal(home[0].top, home[1].top, 'side by side in one row');
    for (const c of home) { assert.ok(Math.abs(c.w / c.h - 5 / 7) < 0.02, 'each card is 5:7 (' + c.w + 'x' + c.h + ')'); assert.ok(c.art, 'with a picture the owner can replace'); }
    assert.ok(await noSideScroll(page), 'no sideways scroll on the home page');
    await shotEl(page, '#offers', 'home-offers-' + H.WIDTHS[0].name);

    // the page of the section: the same two cards
    await page.evaluate(() => go('sec|offers'));
    await page.waitForSelector('#view .offers-grid .card');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#view .offers-grid .card').length), 2);
    await shotEl(page, '#view', 'offers-hub');
    await page.click('#view .offers-grid .card:first-child');
    await page.waitForSelector('#res .card.bf');
    const trail = await page.evaluate(() => [...document.querySelectorAll('#view .bc a, #view .bc b')].map((e) => e.textContent.trim()));
    assert.deepEqual(trail, ['الرئيسية', 'باقات وعروض', 'باقات'], 'the trail reads الرئيسية › باقات وعروض › باقات and each step is a page');
    await page.click('#view .bc a[data-bc="1"]');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#view .offers-grid .card').length), 2, 'the second step is the page of the two cards');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the card of a bundle is a card of a perfume; its pieces and the store\'s whole description are on its own page', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('col|offers|bundles'));
    await page.waitForSelector('#res .card.bf');
    const bundles = await page.evaluate(() => [...document.querySelectorAll('#res .card')].map((c) => ({
      name: c.querySelector('h4').textContent.trim(), price: c.querySelector('.price').textContent.replace(/\s+/g, ''), meta: [...c.querySelectorAll('.pmeta span')].map((e) => e.textContent.trim()),
      tag: c.querySelector('.otag').textContent, pim: !!c.querySelector('.pim'), buttons: c.querySelectorAll('button, [data-add], .cartb').length, inside: c.querySelectorAll('li, details, .btext').length, go: c.getAttribute('data-go') })));
    assert.deepEqual(bundles.map((b) => [b.name, b.price]), [['باقة الهدايا (عنوان المتجر)', '300EGP'], ['باقة مع قطعة إضافية', '450EGP']], 'the store\'s own titles, cheapest first; the sold-out bundle is nowhere');
    assert.deepEqual(bundles.map((b) => b.meta), [['ماركة', 'لدى متجر ألف'], ['ماركة', 'لدى متجر باء']], 'brand and store, like a perfume');
    assert.deepEqual(bundles.map((b) => b.tag), ['باقة', 'باقة']);
    assert.deepEqual(bundles.map((b) => [b.pim, b.buttons, b.inside]), [[true, 0, 0], [true, 0, 0]], 'a picture area like a perfume, no button, and no list or description on the card');
    assert.ok(bundles.every((b) => /^bundle\|/.test(b.go)));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.smsg').length), 0, 'the store-wide messages belong to the page of the offers');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('خصم') || !!document.querySelector('.otag-d')), false, 'the word «خصم» is on no part of the page');
    await shot(page, 'bundles-page');
    assert.ok(await noSideScroll(page), 'no sideways scroll on the bundles page');

    await page.click('#res .card:first-child');
    await page.waitForSelector('.bpage');
    const trail = await page.evaluate(() => [...document.querySelectorAll('#view .bc a, #view .bc b')].map((e) => e.textContent.trim()));
    assert.deepEqual(trail, ['الرئيسية', 'باقات وعروض', 'باقات', 'باقة الهدايا (عنوان المتجر)'], 'the trail goes through every page of the way');
    const detail = await page.evaluate(() => ({ title: document.querySelector('.bpage .pdn').textContent.trim(), price: document.querySelector('.bpage .price').textContent.replace(/\s+/g, ''),
      items: [...document.querySelectorAll('.bpage .bitems li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()), extra: !!document.querySelector('.bpage .bextra'), buy: document.querySelectorAll('.bpage button, .bpage [data-add]').length,
      text: (document.querySelector('.bpage .btext') || {}).innerText, imgs: document.querySelectorAll('.bpage .btext img').length }));
    assert.equal(detail.title, 'باقة الهدايا (عنوان المتجر)');
    assert.equal(detail.price, '300EGP');
    assert.deepEqual(detail.items, ['2× ماركة عطر ألف · 100 مل', '1× عطر هاء · 30 مل'], 'the pieces as the store listed them, a size that no single perfume has included');
    assert.equal(detail.extra, false);
    assert.equal(detail.buy, 0, 'a bundle cannot be bought yet');
    assert.equal(detail.text, 'السطر الأول\nالسطر الثاني <img src=x onerror="window.__xss=2">', 'the whole description, exactly as the store wrote it, markup shown as text');
    assert.equal(detail.imgs, 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing a store wrote ran');
    await shot(page, 'bundle-page');
    assert.ok(await noSideScroll(page));

    await page.click('#view .bc a[data-bc="2"]');
    await page.waitForSelector('#res .card.bf');
    await page.click('#res .card:nth-child(2)');
    await page.waitForSelector('.bpage');
    assert.equal(await page.evaluate(() => !!document.querySelector('.bpage .bextra')), true, 'a package with extra pieces says so');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.bpage .btext').length), 0, 'a store that wrote no description leaves no block');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the page of the «عروض» card: the perfumes a store promotes, with the message of the store whose offer each shows, and the store-wide messages', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('col|offers|offers'));
    await page.waitForSelector('#res .card');
    const cards = await page.evaluate(() => [...document.querySelectorAll('#res .card')].map((c) => ({
      name: c.querySelector('h4').textContent.trim(), tag: (c.querySelector('.otag') || {}).textContent || null,
      line: (c.querySelector('.pmsg') || {}).textContent || null })));
    cards.sort((a, b) => a.name.localeCompare(b.name));
    const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
    assert.equal(cards.length, 2, 'both perfumes the stores promote are listed, no bundle among them');
    assert.equal(byName[NAMES.A].tag, 'عرض');
    assert.equal(byName[NAMES.A].line, 'اشترِ عطرين واحصل على هدية', 'the first message of the store whose offer the card shows');
    assert.equal(byName[NAMES.E].tag, 'عرض', 'every store message is tagged «عرض», whatever its wording');
    assert.equal(byName[NAMES.E].line, '11/11 Sale', 'store B owns the platform offer of this perfume: store A\'s message about it stays hidden');
    const smsg = await page.evaluate(() => [...document.querySelectorAll('.smsg')].map((m) => m.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(smsg, ['متجر ألف شحن مجاني فوق 1500'], 'a store-wide message is listed once, with its store');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#res .card.bf').length), 0);
    await shot(page, 'offers-page');
    assert.ok(await noSideScroll(page), 'no sideways scroll on the offers page');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the filters «باقات» and «عروض» sit in the filter panel and switch what the results show', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('sec|all'));
    await page.waitForSelector('#res .card');
    const names = () => page.evaluate(() => [...document.querySelectorAll('#res .card')].map((c) => c.querySelector('h4').textContent.trim() + (c.classList.contains('bf') ? '*' : '')));
    const chips = () => page.evaluate(() => [...document.querySelectorAll('.filter-panel .kind-row .chip')].map((c) => [c.textContent.trim(), c.getAttribute('aria-pressed')]));
    assert.deepEqual(await chips(), [['باقات', 'false'], ['عروض', 'false']], 'two buttons in the filter panel, off');
    assert.deepEqual((await names()).filter((n) => n.endsWith('*')), [], 'neither on: the perfumes alone, as before');
    await page.click('.filter-panel summary');
    await page.click('.filter-panel [data-okind="bun"]');
    assert.deepEqual(await chips(), [['باقات', 'true'], ['عروض', 'false']]);
    assert.deepEqual(await names(), ['باقة الهدايا (عنوان المتجر)*', 'باقة مع قطعة إضافية*'], '«باقات»: the bundles, cheapest first');
    await page.click('.filter-panel [data-okind="off"]');
    assert.deepEqual((await names()).slice(0, 2), ['باقة الهدايا (عنوان المتجر)*', 'باقة مع قطعة إضافية*'], 'both on: the bundles first');
    assert.equal((await names()).length, 4, 'then the two perfumes a store promotes');
    await page.click('.filter-panel [data-okind="bun"]');
    assert.deepEqual((await names()).filter((n) => n.endsWith('*')), [], '«عروض» alone: only perfumes');
    assert.equal((await names()).length, 2);
    await page.click('.filter-panel [data-okind="off"]');
    await page.click('.filter-panel [data-okind="bun"]');
    await page.fill('.filter-panel input[data-k="q"]', 'إضافية');
    assert.deepEqual(await names(), ['باقة مع قطعة إضافية*'], 'the words filter the bundles too');
    await page.fill('.filter-panel input[data-k="q"]', '');
    await page.selectOption('.filter-panel select[data-k="cat"]', { index: 1 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('#res .card').length), 0, 'a category leaves no bundle');
    assert.match(await page.evaluate(() => document.querySelector('#res .empty').textContent), /لا توجد باقات/);
    // reset goes back to the page's own state: all perfumes, no kind on
    await page.click('[data-filter-reset]');
    assert.deepEqual(await chips(), [['باقات', 'false'], ['عروض', 'false']]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('no number a store typed as "price before / after" is on any page, and the price is the cheapest real one', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    for (const go of ['sec|offers', 'col|offers|offers', 'col|offers|bundles', 'sec|all', 'prod|' + SZ.A, 'prod|' + SZ.E]) {
      await page.evaluate((g) => go(g), go);
      await page.waitForTimeout(150);
      const text = await page.evaluate(() => document.getElementById('view').innerText);
      assert.doesNotMatch(text, /999|90\s*%|٩٩٩/, 'the claimed old price and percentage appear nowhere (' + go + ')');
    }
    const price = await page.evaluate((sz) => platformEligibleOffer(byId(sz)).price, SZ.E);
    assert.equal(price, 80, 'a message and a claimed old price never change the cheapest price');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the product page shows the messages of the store whose offer it shows, escaped', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate((sz) => go('prod|' + sz), SZ.A);
    await page.waitForSelector('.pdo');
    const a = await page.evaluate(() => [...document.querySelectorAll('.pdo')].map((p) => ({ text: p.textContent.replace(/\s+/g, ' ').trim(), img: p.querySelectorAll('img').length })));
    assert.equal(a.length, 2);
    assert.equal(a[0].text, 'عرض اشترِ عطرين واحصل على هدية هدية مع كل عبوتين');
    assert.ok(a[1].text.includes('<img src=x onerror="window.__xss=1">'), 'the store\'s markup is shown as text');
    assert.equal(a[1].img, 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing a store wrote ran');

    await page.evaluate((sz) => go('prod|' + sz), SZ.E);
    await page.waitForSelector('.pdo');
    const e = await page.evaluate(() => [...document.querySelectorAll('.pdo')].map((p) => ({ text: p.textContent.replace(/\s+/g, ' ').trim() })));
    assert.deepEqual(e, [{ text: 'عرض 11/11 Sale' }], 'only store B\'s message: store A\'s message on this perfume is not the page\'s offer');
    await shot(page, 'product-page');
    assert.ok(await noSideScroll(page));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('elsewhere the card carries the tag but not the message text, and nothing is added for a perfume with no message', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('sec|all'));
    await page.waitForSelector('#res .card');
    const r = await page.evaluate(() => ({ tags: document.querySelectorAll('#res .card .otag').length, lines: document.querySelectorAll('#res .card .pmsg').length, bundles: document.querySelectorAll('.bgrid').length, stores: document.querySelectorAll('.smsg').length }));
    assert.deepEqual(r, { tags: 2, lines: 0, bundles: 0, stores: 0 }, 'bundles are cards of the results only when the «باقات» filter is on, and the store-wide messages belong to the page of the offers');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the offers pages hold at every width', async () => {
  for (const size of H.WIDTHS) {
    const { context, page, errors } = await openStore(size);
    try {
      const pair = await page.evaluate(() => [...document.querySelectorAll('#offers .strip .card')].map((c) => { const r = c.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, vw: window.innerWidth }; }));
      assert.equal(pair.length, 2);
      assert.ok(pair.every((c) => c.l >= 0 && c.r <= c.vw && Math.abs(c.w / c.h - 5 / 7) < 0.02), 'the two 5:7 cards fit the screen at ' + size.name);
      await shotEl(page, '#offers', 'home-offers-' + size.name);
      assert.ok(await noSideScroll(page), 'no sideways scroll on the home page at ' + size.name);
      await page.evaluate(() => go('col|offers|bundles'));
      await page.waitForSelector('#res .card.bf');
      assert.ok(await noSideScroll(page), 'no sideways scroll on the bundles page at ' + size.name);
      const box = await page.evaluate(() => { const c = document.querySelector('#res .card.bf').getBoundingClientRect(); return { w: c.width, h: c.height, vw: window.innerWidth }; });
      assert.ok(box.w > 100 && box.w < box.vw, 'the bundle card fits the screen at ' + size.name);
      await page.click('#res .card.bf');
      await page.waitForSelector('.bpage');
      assert.ok(await noSideScroll(page), 'no sideways scroll on the page of a bundle at ' + size.name);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
