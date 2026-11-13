'use strict';
/* «قريبًا» and the cart, in a real Chromium, with a Supabase that answers a small catalog (the owner's rules of 2026-11-12):
   A1  the cheapest store sold out: the next store (Store B, 130) is the platform eligible offer; the cart still holds the line at Store A (100)
       -> the line moves to Store B's group and the message names both stores and prices;
   E1  2 in stock, the cart holds 4                      -> cut to 2, «تم تخفيض الكمية» beside the item, still purchasable;
   F1  price fell from 70 to 60 at the same store        -> stays, at the new price, listed in the message;
   G1  nothing changed                                    -> not in the message;
   D1  no eligible offer anywhere                         -> leaves the cart, the message says «المنتج غير متاح حاليًا»;
   B1  only a merchant's announcement                     -> «قريبًا»: no price, no stock, no cart button, still listed;
   H1  an offer row with NULL stock (unconfirmed)         -> not on sale, not announced: nowhere. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const id = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const S1 = id(1), S2 = id(2);
const K = { A: 10, B: 20, D: 40, E: 50, F: 60, G: 70, H: 80 };
const P = {}, SZ = {}, SPA = {}, SPB = {};
for (const [k, n] of Object.entries(K)) { P[k] = id(n); SZ[k] = id(n + 1); SPA[k] = id(n + 2); SPB[k] = id(n + 3); }
const NAMES = { A: 'عطر ألف', B: 'عطر باء', D: 'عطر دال', E: 'عطر هاء', F: 'عطر فاء', G: 'عطر جيم', H: 'عطر حاء' };
const STORES = { [S1]: 'متجر ألف', [S2]: 'متجر باء' };

const row = (k, storeId, sp, price, stock) => ({ product_size_id: SZ[k], product_id: P[k], store_product_id: sp, store_id: storeId, store_name: STORES[storeId], price, currency: 'EGP', stock_quantity: stock, price_includes_tax: true, price_includes_shipping: false });
// what the database says: cheapest ELIGIBLE offer per size (stock > 0), and every eligible row
const PLATFORM = [row('A', S2, SPB.A, 130, 5), row('E', S1, SPA.E, 80, 2), row('F', S1, SPA.F, 60, 9), row('G', S1, SPA.G, 50, 9)];
const ELIGIBLE = PLATFORM.concat([
  row('A', S1, SPA.A, 100, 0),    // a sold-out row that slipped into the feed: the storefront refuses it itself
  row('H', S1, SPA.H, 40, null)   // NULL stock = unconfirmed: not eligible
]).map((r) => Object.assign({}, r, { is_new_arrival: false, is_coming_soon: false }));
const ANNOUNCEMENTS = [{ product_size_id: SZ.B, product_id: P.B, store_id: S1, store_name: STORES[S1], stock_unknown: true }];
const KEEP = ['A', 'B', 'D', 'E', 'F', 'G', 'H'];
const TABLES = {
  public_brands: [{ name: 'ماركة', slug: 'brand' }],
  public_stores: [{ id: S1, name: STORES[S1], short_description: '' }, { id: S2, name: STORES[S2], short_description: '' }],
  public_products: KEEP.map((k) => ({ id: P[k], name: NAMES[k], brand_name: 'ماركة', sales_count: 0, views_count: 0, search_count: 0, average_rating: null, reviews_count: 0, short_description: '', official_description: '', composition: '', gender: 'unisex' })),
  product_sizes: KEEP.map((k) => ({ id: SZ[k], size_label: '100 مل', size_ml: 100, product_id: P[k] })),
  catalog_platform_offers: PLATFORM,
  catalog_eligible_offers: ELIGIBLE,
  catalog_coming_soon_announcements: ANNOUNCEMENTS
};
const line = (k, storeId, sp, price, q) => ({ sid: SZ[k], storeProductId: sp, storeId, storeName: STORES[storeId], observedPrice: price, currency: 'EGP', q });
const CART = [line('A', S1, SPA.A, 100, 2), line('E', S1, SPA.E, 80, 4), line('F', S1, SPA.F, 70, 1), line('G', S1, SPA.G, 50, 1), line('D', S1, SPA.D, 90, 1)];
const NAMES_SAVED = { [SZ.D]: { n: NAMES.D, s: '100 مل' } };

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
  await context.addInitScript(({ cart, names }) => { try { if (!localStorage.getItem('elan_cart')) { localStorage.setItem('elan_cart', JSON.stringify(cart)); localStorage.setItem('elan_cart_names', JSON.stringify(names)); } } catch (e) { /* storage blocked */ } }, { cart: CART, names: NAMES_SAVED });
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof PERFUMES !== 'undefined' && PERFUMES.length === 4 && typeof ANNOUNCEMENTS !== 'undefined' && ANNOUNCEMENTS.length === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => CART_CHANGES.length > 0, null, { timeout: 5000 });
  return { context, page, errors, problems };
}

const shotDir = process.env.ELAN_SHOTS;
const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: shotDir + '/' + name + '.png' }); } };

test('the catalog: what is on sale, what is only announced, and what is neither', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    const r = await page.evaluate(() => ({ sale: PERFUMES.map((p) => [p.pn, p.platformEligibleOffer.store, p.platformEligibleOffer.price]), soon: ANNOUNCEMENTS.map((p) => [p.pn, p.announcedBy, p.stockUnknown, p.platformEligibleOffer, p.allEligibleOffers.length]) }));
    assert.deepEqual(r.sale.sort(), [[NAMES.A, 'متجر باء', 130], [NAMES.E, 'متجر ألف', 80], [NAMES.F, 'متجر ألف', 60], [NAMES.G, 'متجر ألف', 50]].sort(), 'A1 is at the next store (the sold-out one is refused); H1 (NULL stock) is nowhere');
    assert.deepEqual(r.soon, [[NAMES.B, 'متجر ألف', true, null, 0]]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('«قريبًا»: the announced perfume is listed without a price, without a cart button, and its page offers nothing to buy', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => go('sec|soon'));
    await page.waitForSelector('#res .card');
    const list = await page.evaluate(() => ({ names: [...document.querySelectorAll('#res .card h4')].map((h) => h.textContent.trim()), price: document.querySelectorAll('#res .card .price').length, cart: document.querySelectorAll('#res .card .cartb').length, st: [...document.querySelectorAll('#res .card .st')].map((s) => s.textContent.trim()) }));
    assert.deepEqual(list.names, [NAMES.B]);
    assert.equal(list.price, 0);
    assert.equal(list.cart, 0);
    assert.deepEqual(list.st, ['قريباً']);
    await page.evaluate((sid) => go('prod|' + sid), SZ.B);
    await page.waitForSelector('#view h1, #view h2, #view .pd');
    const prod = await page.evaluate((sid) => ({ text: document.getElementById('view').innerText, add: document.querySelectorAll('#view .pdadd, #view #qty, #view [data-add="' + sid + '"]').length, found: [...document.querySelectorAll('#view .pdadd, #view #qty, #view [data-add="' + sid + '"]')].map((n) => n.outerHTML.slice(0, 120)).join(' | '), price: document.querySelectorAll('#view .pdp .price').length }), SZ.B);
    assert.match(prod.text, new RegExp(NAMES.B));
    assert.equal(prod.add, 0, 'nothing to add to the cart: ' + prod.found);
    assert.equal(prod.price, 0, 'no price');
    // a sale section never shows it, and the home strip does
    await page.evaluate(() => go('sec|all'));
    await page.waitForSelector('#res .card');
    assert.ok(!(await page.evaluate(() => document.getElementById('res').innerText)).includes(NAMES.B), 'not among the perfumes on sale');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const size of H.WIDTHS) {
  test('the cart at ' + size.width + 'px: lines follow the platform eligible offer, with the message, the detail, the quantity notice and no overflow', async () => {
    const { context, page, errors } = await openStore(size);
    try {
      const cart = await page.evaluate(() => CART.map((c) => [c.sid, c.storeId, c.storeName, c.observedPrice, c.q]));
      assert.deepEqual(cart, [[SZ.A, S2, 'متجر باء', 130, 2], [SZ.E, S1, 'متجر ألف', 80, 2], [SZ.F, S1, 'متجر ألف', 60, 1], [SZ.G, S1, 'متجر ألف', 50, 1]], 'A1 moved, E1 cut, F1 re-priced, G1 untouched, D1 gone');
      await page.evaluate(() => sheet('cart'));
      await page.waitForSelector('#sheetB .cart-changes');
      const bar = page.locator('#sheetB .cart-changes-bar');
      assert.match(await bar.innerText(), /^تم تغيير حالة بعض منتجات السلة\s*\(4\)/, 'A1, E1, F1 and D1 changed; G1 did not');
      assert.equal(await bar.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#sheetB .cart-changes-list').isHidden(), true, 'closed until tapped');
      await shot(page, 'cart-closed-' + size.width);
      await bar.click();
      assert.equal(await bar.getAttribute('aria-expanded'), 'true');
      const detail = await page.locator('#sheetB .cart-changes-list').innerText();
      for (const part of [NAMES.A, 'المتجر السابق', 'متجر ألف', 'المتجر الحالي', 'متجر باء', 'السعر السابق', 'السعر الحالي', '100 EGP', '130 EGP', NAMES.F, '70 EGP', '60 EGP', NAMES.E, 'تم تخفيض الكمية', NAMES.D, 'المنتج غير متاح حاليًا']) assert.ok(detail.includes(part), part + ' in ' + detail);
      assert.ok(!detail.includes(NAMES.G), 'the untouched line is not in the message');
      await shot(page, 'cart-open-' + size.width);
      const groups = await page.evaluate(() => [...document.querySelectorAll('#sheetB .cart-store')].map((s) => ({ head: s.querySelector('.cart-store-head b').textContent.trim(), lines: [...s.querySelectorAll('.cl b')].map((b) => b.textContent.trim()), disabled: s.querySelector('.store-order-btn').disabled, cut: [...s.querySelectorAll('.cart-qtycut')].map((c) => c.textContent.trim()) })));
      assert.deepEqual(groups.map((g) => g.head).sort(), ['متجر ألف', 'متجر باء'], 'store names, never identifiers');
      const byHead = Object.fromEntries(groups.map((g) => [g.head, g]));
      assert.equal(byHead['متجر باء'].lines.length, 1, 'A1 sits in Store B\'s group');
      assert.ok(byHead['متجر باء'].lines[0].includes(NAMES.A));
      assert.equal(byHead['متجر ألف'].lines.length, 3);
      assert.deepEqual(byHead['متجر ألف'].cut, ['تم تخفيض الكمية'], 'the notice sits beside E1 only');
      assert.ok(groups.every((g) => !g.disabled), 'every group can still be ordered');
      const overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, sheet: (() => { const b = document.getElementById('sheetB'); return b.scrollWidth - b.clientWidth; })() }));
      assert.ok(overflow.doc <= 0 && overflow.sheet <= 0, 'no horizontal overflow: ' + JSON.stringify(overflow));
      // the customer hides the message
      await page.locator('#sheetB [data-cart-changes-dismiss]').click();
      assert.equal(await page.locator('#sheetB .cart-changes').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('elan_cart_changes')), null);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('the max quantity of the cheapest offer is shown as a message, and the line does not move to a dearer store', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[0]);
  try {
    await page.evaluate(() => sheet('cart'));
    await page.waitForSelector('#sheetB .cart-store');
    const e = SZ.E;
    await page.evaluate((sid) => cartQty(sid + '|1'), e);     // E1 is at its maximum of 2 already
    const after = await page.evaluate((sid) => CART.filter((c) => c.sid === sid).map((c) => [c.q, c.storeId, c.observedPrice]), e);
    assert.deepEqual(after, [[2, S1, 80]]);
    assert.match(await page.locator('#toast, .toast').first().innerText(), /أقصى كمية متاحة: 2/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
