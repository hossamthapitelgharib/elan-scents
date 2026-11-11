'use strict';
/* Stars and ratings count on the storefront, in a real Chromium, with a Supabase that answers three perfumes:
   A  4.00 stars, 305 ratings, ranked in «الأكثر تقييمًا»;
   B  2.67 stars, 320 ratings, NOT ranked (it still shows its figures everywhere);
   C  no rating at all (shows nothing: no stars, no count, no "0"). */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');

const pw = H.loadPlaywright();

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

const STORE = '00000000-0000-4000-8000-0000000000aa';
const P = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b', C: '00000000-0000-4000-8000-00000000000c' };
const SZ = { A: '00000000-0000-4000-8000-0000000000a1', B: '00000000-0000-4000-8000-0000000000b1', C: '00000000-0000-4000-8000-0000000000c1' };
const SP = { A: '00000000-0000-4000-8000-0000000000a2', B: '00000000-0000-4000-8000-0000000000b2', C: '00000000-0000-4000-8000-0000000000c2' };
const NAMES = { A: 'عطر ألف', B: 'عطر باء', C: 'عطر جيم' };
const RATING = { A: [4.0, 305], B: [2.67, 320], C: [null, null] };

const offerRow = (k) => ({ product_size_id: SZ[k], product_id: P[k], store_product_id: SP[k], store_id: STORE, store_name: 'متجر الاختبار', price: 100, currency: 'EGP', stock_quantity: 5, price_includes_tax: true, price_includes_shipping: false });
const TABLES = {
  public_brands: [{ name: 'ماركة', slug: 'brand' }],
  public_stores: [{ id: STORE, name: 'متجر الاختبار', short_description: '' }],
  public_products: ['A', 'B', 'C'].map((k) => ({ id: P[k], name: NAMES[k], brand_name: 'ماركة', sales_count: 0, views_count: 0, search_count: 0, average_rating: RATING[k][0], reviews_count: RATING[k][1], short_description: '', official_description: '', composition: '', gender: 'unisex' })),
  catalog_platform_offers: ['A', 'B', 'C'].map(offerRow),
  product_sizes: ['A', 'B', 'C'].map((k) => ({ id: SZ[k], size_label: '100 مل', size_ml: 100, product_id: P[k] })),
  catalog_eligible_offers: ['A', 'B', 'C'].map((k) => Object.assign(offerRow(k), { is_new_arrival: false, is_coming_soon: false })),
  storefront_product_rankings: [{ product_id: P.A, sales_rank: null, views_rank: null, searches_rank: null, rating_rank: 1 }],
};

async function openStore(size) {
  const { context, problems } = await H.openContext(browser, server, size);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  // registered after the harness route, so it is asked first
  await context.route('**/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'sbgdtuqfrnfeggkwqtrw.supabase.co') return route.fallback();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const table = url.pathname.replace('/rest/v1/', '');
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(TABLES[table] || []) });
  });
  const errors = []; const page = await context.newPage(); H.watchErrors(page, errors);
  await page.goto(H.SITE + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof PERFUMES !== 'undefined' && PERFUMES.length === 3, null, { timeout: 15000 });
  return { context, page, errors, problems };
}

for (const size of H.WIDTHS) {
  test('ratings at ' + size.width + 'px: every card shows its stars and count, the unrated one shows nothing', async () => {
    const { context, page, errors } = await openStore(size);
    try {
      // the same cards the storefront draws everywhere (home strips, grids, favourites, search) come from pc()
      const html = await page.evaluate(() => PERFUMES.map((p) => pc({ p, b: globalOffer(p) })).join(''));
      const doc = await page.evaluate((h) => { const d = document.createElement('div'); d.innerHTML = h; return Array.from(d.querySelectorAll('.card.pf')).map((c) => ({ name: c.querySelector('h4').textContent.trim(), rate: (c.querySelector('.prate') || {}).textContent || '', label: c.querySelector('.prate') ? c.querySelector('.prate').getAttribute('aria-label') : null })); }, html);
      const by = Object.fromEntries(doc.map((c) => [c.name, c]));
      assert.equal(by['عطر ألف'].rate.replace(/\s/g, ''), '★4.00(305)');
      assert.equal(by['عطر ألف'].label, '4.00 / 5 (305)');
      assert.equal(by['عطر باء'].rate.replace(/\s/g, ''), '★2.67(320)', 'a perfume outside the ranking still shows its figures');
      assert.equal(by['عطر جيم'].rate, '', 'no rating: nothing on the card');
      assert.equal(by['عطر جيم'].label, null);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('the perfume page shows stars with two decimals and the count; the unrated perfume shows no rating block', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[2] || H.WIDTHS[0]);
  try {
    const rows = await page.evaluate(() => PERFUMES.map((p) => { const d = document.createElement('div'); d.innerHTML = ratingHTML(p.rating, p.ratingCount); const r = d.querySelector('.rating'); return { name: p.pn, text: r ? r.textContent.replace(/\s/g, '') : '', label: r ? r.getAttribute('aria-label') : null, on: r ? r.querySelectorAll('.stars .on').length : 0 }; }));
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(by['عطر ألف'].text, '★★★★★4.00(305)');
    assert.equal(by['عطر ألف'].on, 4);
    assert.equal(by['عطر باء'].text, '★★★★★2.67(320)');
    assert.equal(by['عطر باء'].on, 3);
    assert.equal(by['عطر جيم'].text, '');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('«الأكثر تقييمًا» lists only the ranked perfume, while the other perfumes keep their figures', async () => {
  const { context, page, errors } = await openStore(H.WIDTHS[2] || H.WIDTHS[0]);
  try {
    const r = await page.evaluate(() => ({ ind: PERFUMES.map((p) => [p.pn, p.ind.join(',')]), rated: PERFUMES.filter((p) => p.ind.indexOf('rated') > -1).map((p) => p.pn), figures: PERFUMES.map((p) => [p.pn, p.rating, p.ratingCount]) }));
    assert.deepEqual(r.rated, ['عطر ألف']);
    assert.deepEqual(r.figures, [['عطر ألف', 4, 305], ['عطر باء', 2.67, 320], ['عطر جيم', 0, 0]]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
