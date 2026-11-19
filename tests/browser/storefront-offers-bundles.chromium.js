'use strict';
/* Bundles and offers, in a real Chromium, with a Supabase that answers a small catalog (the owner's rules of 2026-11-14/15 and the agreement of 2026-11-17):
   - an OFFER is a promotional message from the store, no price change, tagged «عرض»; the platform has no discount concept, so the word «خصم» is on no page;
   - a perfume shows the message of the store whose offer it shows (the other store's message stays hidden);
   - a number a store typed as "price before / after" (original_price here) is on no page at all;
   - «باقات وعروض» lists store-wide messages and the bundles (cheapest eligible offer per bundle), and a bundle has no cart button yet;
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
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('«باقات وعروض»: perfumes with their own store\'s message, store-wide messages, and the bundles', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('sec|offers'));
    await page.waitForSelector('#res .card');
    const cards = await page.evaluate(() => [...document.querySelectorAll('#res .card')].map((c) => ({
      name: c.querySelector('h4').textContent.trim(), tag: (c.querySelector('.otag') || {}).textContent || null,
      line: (c.querySelector('.pmsg') || {}).textContent || null })));
    cards.sort((a, b) => a.name.localeCompare(b.name));
    const byName = Object.fromEntries(cards.map((c) => [c.name, c]));
    assert.equal(cards.length, 2, 'both perfumes the stores promote are listed');
    assert.equal(byName[NAMES.A].tag, 'عرض');
    assert.equal(byName[NAMES.A].line, 'اشترِ عطرين واحصل على هدية', 'the first message of the store whose offer the card shows');
    assert.equal(byName[NAMES.E].tag, 'عرض', 'every store message is tagged «عرض», whatever its wording');
    assert.equal(byName[NAMES.E].line, '11/11 Sale', 'store B owns the platform offer of this perfume: store A\'s message about it stays hidden');

    const smsg = await page.evaluate(() => [...document.querySelectorAll('.smsg')].map((m) => m.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(smsg, ['متجر ألف شحن مجاني فوق 1500'], 'a store-wide message is listed once, with its store');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('خصم') || !!document.querySelector('.otag-d')), false, 'the word «خصم» is on no part of the page');

    const bundles = await page.evaluate(() => [...document.querySelectorAll('.bgrid .card')].map((c) => ({
      name: c.querySelector('h4').textContent.trim(), price: c.querySelector('.price').textContent.replace(/\s+/g, ''), items: [...c.querySelectorAll('.bitems li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
      cart: c.querySelectorAll('button, [data-add], .cartb, [data-go]').length, extra: !!c.querySelector('.bextra'), tag: c.querySelector('.otag').textContent })));
    assert.deepEqual(bundles.map((b) => [b.name, b.price]), [['باقة الهدايا (عنوان المتجر)', '300EGP'], ['باقة مع قطعة إضافية', '450EGP']], 'the store\'s own titles, cheapest first; the sold-out bundle is nowhere');
    assert.deepEqual(bundles[0].items, ['2× ماركة عطر ألف · 100 مل', '1× عطر هاء · 30 مل'], 'the pieces as the store listed them, a size that no single perfume has included');
    assert.equal(bundles[0].extra, false);
    assert.equal(bundles[1].extra, true, 'a package with extra pieces says so');
    assert.deepEqual(bundles.map((b) => b.cart), [0, 0], 'a bundle cannot be bought yet: no button, no link');
    assert.deepEqual(bundles.map((b) => b.tag), ['باقة', 'باقة']);
    // the store's own description: only the bundle whose store wrote one has the block; it starts closed and opens to the whole text, line breaks kept
    const blocks = await page.evaluate(() => [...document.querySelectorAll('.bgrid .card')].map((c) => { const d = c.querySelector('details.bdesc'); return d ? { open: d.open, summary: d.querySelector('summary').textContent.trim(), imgs: d.querySelectorAll('img').length } : null; }));
    assert.deepEqual(blocks, [{ open: false, summary: 'تفاصيل الباقة كما كتبها المتجر', imgs: 0 }, null], 'a closed details block only on the bundle that has a store description; nothing from the store became markup');
    await page.click('.bgrid .card:first-child details.bdesc summary');
    const text = await page.evaluate(() => document.querySelector('.bgrid .card:first-child .btext').innerText);
    assert.equal(text, 'السطر الأول\nالسطر الثاني <img src=x onerror="window.__xss=2">', 'the whole description, exactly as the store wrote it, markup shown as text');
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'nothing a store wrote ran');
    await shot(page, 'offers-page');
    assert.ok(await noSideScroll(page), 'no sideways scroll on the offers page');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('no number a store typed as "price before / after" is on any page, and the price is the cheapest real one', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    for (const go of ['sec|offers', 'sec|all', 'prod|' + SZ.A, 'prod|' + SZ.E]) {
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
    assert.deepEqual(r, { tags: 2, lines: 0, bundles: 0, stores: 0 }, 'bundles and store messages belong to «باقات وعروض» only');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the offers page holds at every width', async () => {
  for (const size of H.WIDTHS) {
    const { context, page, errors } = await openStore(size);
    try {
      await page.evaluate(() => go('sec|offers'));
      await page.waitForSelector('.bgrid .card');
      assert.ok(await noSideScroll(page), 'no sideways scroll at ' + size.name);
      const box = await page.evaluate(() => { const c = document.querySelector('.bgrid .card').getBoundingClientRect(); return { w: c.width, h: c.height, vw: window.innerWidth }; });
      assert.ok(box.w > 100 && box.w < box.vw, 'the bundle card fits the screen at ' + size.name);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
});
