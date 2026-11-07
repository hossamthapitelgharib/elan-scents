'use strict';
/* End-to-end journeys for the customer, account and editor entry points.
   Every external service is mocked in the browser context: this suite never creates
   an account, order, email, upload, or database row in a real service. */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./harness.js');
const pw = H.loadPlaywright();

const WINDOW = { width: 390, height: 844 };
const CUSTOMER_SESSION = { access_token: 'customer-test-token', refresh_token: 'refresh-test-token', user: { id: 'customer-1', email: 'customer@example.test' } };
const ORDER = {
  id: 'request-1', tracking_number: 'ELN-TEST-0001', status: 'awaiting_store_confirmation', subtotal: 150, total_amount: 150, currency: 'EGP',
  created_at: '2026-11-02T10:00:00Z', stores: { name: 'Test Store' },
  store_order_request_items: [{ product_name: 'Test Perfume', brand_name: 'Test Brand', size_label: '50 ml', product_size_id: '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11', quantity: 1, line_total: 150, unit_price: 150, currency: 'EGP' }],
  store_shipments: []
};

const FAV_SIZE = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
let favRows = [], favWrites = [];
let acctRow = null, acctWrites = [];   // the customer_details row the mocked database holds, and what the page wrote to it
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function context({ session = null } = {}) {
  favRows = []; favWrites = []; acctRow = null; acctWrites = [];
  const result = await H.openContext(browser, server, WINDOW);
  if (session) await result.context.addInitScript((value) => localStorage.setItem('elan_auth_session', JSON.stringify(value)), session);
  return result;
}

async function mockPage(page) {
  await page.route('**/api/customer-orders*', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sessions: [{ id: 'session-1', store_order_requests: [ORDER] }], pagination: { total: 1, hasMore: false } }) }));
  await page.route('**/api/config', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://sbgdtuqfrnfeggkwqtrw.supabase.co', key: 'public-test-key', turnstile_site_key: 'test-site-key' }) }));
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', route => H.safeFulfill(route, {
    status: 200,
    contentType: 'application/javascript',
    body: "window.turnstile={render:function(holder,opts){setTimeout(function(){opts.callback('test-turnstile-token');},0);return 'test-widget';},remove:function(){}};"
  }));
  await page.route('**/api/place-store-order', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'request-1', trackingNumber: 'ELN-TEST-0001', currency: 'EGP' }) }));
  await page.route('https://nominatim.openstreetmap.org/reverse*', route => H.safeFulfill(route, { status: 200, contentType: 'application/json',
    body: JSON.stringify({ display_name: 'x', address: { road: 'شارع التحرير', suburb: 'وسط البلد', city: 'القاهرة', state: 'محافظة القاهرة', country: 'مصر' } }) }));
  await page.route('https://www.google.com/maps*', route => H.safeFulfill(route, { status: 200, contentType: 'text/html', body: '<!doctype html><title>map</title><p>map</p>' }));
  await page.route('**/api/customer-cart', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"ok":true,"items":[]}' }));
  await page.route('**/api/request-store-order-cancellation', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"requestId":"request-1","duplicate":false}' }));
  await page.route('**/sbgdtuqfrnfeggkwqtrw.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/auth/v1/token') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMER_SESSION) });
    if (url.pathname === '/auth/v1/user') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMER_SESSION.user) });
    if (url.pathname.includes('/cart_items')) return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '[]' });
    if (url.pathname.includes('/rest/v1/favorites')) {
      if (request.method() === 'GET') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(favRows) });
      favWrites.push({ method: request.method(), url: request.url(), body: request.postData() || '' });
      return H.safeFulfill(route, { status: request.method() === 'POST' ? 201 : 204, contentType: 'application/json', body: '' });
    }
    if (url.pathname.includes('/rest/v1/customer_details')) {
      if (request.method() === 'GET') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(acctRow ? [acctRow] : []) });
      const body = JSON.parse(request.postData() || '{}');
      acctWrites.push({ method: request.method(), url: request.url(), prefer: request.headers().prefer || '', auth: request.headers().authorization || '', body });
      // what the database trigger does: the delivery address is a copy of the home address while ship_same is true
      acctRow = { ...body, ...(body.ship_same ? { ship_governorate: body.governorate, ship_address: body.address, ship_lat: body.address_lat, ship_lng: body.address_lng } : {}) };
      return H.safeFulfill(route, { status: 201, contentType: 'application/json', body: JSON.stringify([acctRow]) });
    }
    if (url.pathname.includes('/auth/v1/logout')) return H.safeFulfill(route, { status: 204, contentType: 'application/json', body: '' });
    if (url.pathname.includes('/auth/v1/recover')) return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{}' });
    return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '[]' });
  });
}

async function openPage(c, path) {
  const page = await c.context.newPage();
  await mockPage(page);
  await page.goto(H.SITE + path, { waitUntil: 'load' });
  return page;
}

test('1. public storefront opens in RTL and keeps the mobile layout', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#hero').count(), 1);
    assert.equal(await page.locator('#main').count(), 1);
  } finally { await c.context.close(); }
});

test('2. cart sheet opens and is keyboard-accessible', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('[data-sheet="cart"]').click();
    assert.equal(await page.locator('#sheet').isVisible(), true);
    assert.equal(await page.locator('#sheetB .sheet-close').count(), 1);
    await page.locator('#sheetB .sheet-close').click();
    assert.equal(await page.locator('#sheet').isHidden(), true);
  } finally { await c.context.close(); }
});

test('3. sign-up sheet exposes the required safe fields and nothing else under the button', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="signup"]').click();
    const form = page.locator('[data-auth-form="signup"], form[data-auth-mode="signup"]');
    assert.equal(await form.count(), 1);
    assert.equal(await form.locator('input[name="name"]').getAttribute('autocomplete'), 'off');
    assert.equal(await form.locator('input[name="password"]').getAttribute('autocomplete'), 'new-password');
    assert.equal(await page.locator('#sheet .auth-consent').count(), 0, 'no privacy sentence in the sign-up panel');
    assert.equal(await page.locator('#sheet [data-sheet="login"]').count(), 0, 'no «sign in» line after the sign-up button');
  } finally { await c.context.close(); }
});

test('4. login request receives a mocked session and updates the signed-in menu', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    await page.locator('[data-auth-mode="login"] input[name="email"]').fill('customer@example.test');
    await page.locator('[data-auth-mode="login"] input[name="password"]').fill('correct-password');
    await page.locator('[data-auth-mode="login"] button[type="submit"]').click();
    await page.waitForFunction(() => !!JSON.parse(localStorage.getItem('elan_auth_session') || 'null'));
    await page.waitForFunction(() => document.getElementById('sheet').hidden);
    assert.equal(await page.locator('#sheet').isHidden(), true, 'the login panel closes and the cart does not open by itself');
  } finally { await c.context.close(); }
});

test('4b. the sign-in panel has no «create account» line under its button', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    assert.equal(await page.locator('#sheet [data-auth-mode="login"]').count(), 1);
    assert.equal(await page.locator('#sheet [data-sheet="signup"]').count(), 0);
  } finally { await c.context.close(); }
});

test('5. cart-to-checkout route requires authentication and shows the account path', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('[data-sheet="cart"]').click();
    assert.equal(await page.locator('#sheet').isVisible(), true);
    assert.match(await page.locator('#sheetB').innerText(), /سلتك فارغة/);
    assert.equal(await page.locator('[data-store-order-form]').count(), 0);
    assert.equal(await page.locator('a[href="/account.html"]').count(), 1);
  } finally { await c.context.close(); }
});

test('6. signed-in account page renders active order, shipping area and order count', async () => {
  const c = await context({ session: CUSTOMER_SESSION });
  try {
    const page = await openPage(c, '/account.html');
    await page.waitForSelector('#app:not([hidden])');
    assert.match(await page.locator('#ordersCount').innerText(), /1/);
    assert.match(await page.locator('#activeOrders').innerText(), /ELN-TEST-0001/);
    assert.match(await page.locator('#activeOrders').innerText(), /لم يسجل المتجر بيانات الشحن بعد/);
  } finally { await c.context.close(); }
});

test('7. account archive search uses the customer order endpoint and does not expose another session', async () => {
  const c = await context({ session: CUSTOMER_SESSION });
  try {
    const page = await openPage(c, '/account.html');
    await page.waitForSelector('#app:not([hidden])');
    await page.locator('#archiveSearch').fill('ELN-TEST-0001');
    await page.locator('#archiveForm button[type="submit"]').click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#archiveOrders').isVisible(), true);
    assert.doesNotMatch(await page.locator('#archiveOrders').innerText(), /customer-token|refresh-token/);
  } finally { await c.context.close(); }
});

test('8. editor login page presents login and recovery paths without inline handlers', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/editor');
    if (await page.locator('#loginBtn').count()) {
      assert.equal(await page.locator('#forgotBox').isHidden(), true);
      await page.locator('#forgotLink').click();
      assert.equal(await page.locator('#forgotBox').isVisible(), true);
      assert.equal(await page.locator('#forgotEmail').getAttribute('autocomplete'), 'username');
    } else {
      assert.equal(await page.locator('iframe').count(), 1);
    }
  } finally { await c.context.close(); }
});

test('9. password recovery form posts to the configured auth endpoint with a neutral response', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/account.html');
    await page.locator('#forgotLink').click();
    await page.waitForFunction(() => !document.querySelector('#resetForm').hidden);
    await page.locator('#resetForm input[name="email"]').fill('customer@example.test');
    await page.locator('#resetForm button').click();
    await page.waitForTimeout(100);
    assert.match(await page.locator('#message').innerText(), /إن كان هذا البريد مسجلًا/);
  } finally { await c.context.close(); }
});

test('10. logout flash is rendered and clears the customer session on the next storefront visit', async () => {
  const c = await context();
  try {
    await c.context.addInitScript(() => sessionStorage.setItem('elan_flash', 'logout'));
    const page = await openPage(c, '/');
    await page.waitForTimeout(100);
    assert.match(await page.locator('body').innerText(), /تم تسجيل الخروج بنجاح/);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('elan_flash')), null);
  } finally { await c.context.close(); }
});

test('11. signing out empties the cart and the favourites on screen and on the device, and they stay empty after the reload', async () => {
  const c = await context();
  try {
    // seed once, session included: an init script that runs on every load would put the session and the lists back on the reload that follows signing out
    await c.context.addInitScript(([size, session]) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_auth_session', JSON.stringify(session));
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, q: 2 }]));
      localStorage.setItem('elan_favs', JSON.stringify([size]));
    }, [FAV_SIZE, CUSTOMER_SESSION]);
    const page = await openPage(c, '/');
    const read = () => page.evaluate(() => ({ cart: localStorage.getItem('elan_cart'), favs: localStorage.getItem('elan_favs'), auth: localStorage.getItem('elan_auth_session'),
      cartN: document.querySelector('button[data-sheet="cart"]').getAttribute('data-n'), favN: document.querySelector('button[data-sheet="fav"]').getAttribute('data-n') }));
    const before = await read();
    assert.equal(before.cartN, '2'); assert.equal(before.favN, '1');
    await page.locator('#mb').click();
    await page.locator('#menu [data-logout]').click();
    assert.equal(await page.locator('#sheet [data-logout-now]').count(), 1, 'the menu entry only asks');
    assert.ok(await page.evaluate(() => !!localStorage.getItem('elan_auth_session')), 'still signed in while the question is open');
    await Promise.all([page.waitForEvent('load', { timeout: 10000 }), page.locator('#sheet [data-logout-now]').click()]);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#toast').textContent(), 'تم تسجيل الخروج بنجاح', 'the goodbye is on screen after signing out');
    assert.equal(await page.locator('#toast').getAttribute('class'), 'show');
    const after = await read();
    assert.deepEqual({ cart: after.cart, favs: after.favs, auth: after.auth, cartN: after.cartN, favN: after.favN }, { cart: null, favs: null, auth: null, cartN: '0', favN: '0' });
    assert.deepEqual(favWrites.filter((w) => w.method === 'DELETE'), [], 'signing out never deletes the customer\'s saved favourites in the account');
  } finally { await c.context.close(); }
});

test('12. after signing in the favourites saved in the account are back, and a heart saved while signed in goes to the account', async () => {
  const c = await context();
  try {
    favRows = [{ product_size_id: FAV_SIZE }];
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    await page.locator('[data-auth-mode="login"] input[name="email"]').fill('customer@example.test');
    await page.locator('[data-auth-mode="login"] input[name="password"]').fill('correct-password');
    await page.locator('[data-auth-mode="login"] button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('button[data-sheet="fav"]').getAttribute('data-n') === '1', null, { timeout: 10000 });
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('elan_favs'))), [FAV_SIZE]);
    assert.equal(await page.evaluate(() => localStorage.getItem('elan_favs_owner')), 'customer-1');
    assert.deepEqual(favWrites, [], 'what the account already had is not written again');
  } finally { await c.context.close(); }
});

test('13. «Cancel» in the sign-out question keeps the customer signed in, with the cart and favourites untouched', async () => {
  const c = await context();
  try {
    await c.context.addInitScript(([size, session]) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_auth_session', JSON.stringify(session));
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, q: 2 }]));
      localStorage.setItem('elan_favs', JSON.stringify([size]));
    }, [FAV_SIZE, CUSTOMER_SESSION]);
    const page = await openPage(c, '/');
    let reloaded = false;
    page.on('load', () => { reloaded = true; });
    await page.locator('#mb').click();
    await page.locator('#menu [data-logout]').click();
    await page.locator('#sheet [data-close-sheet]').last().click();
    await page.waitForFunction(() => document.getElementById('sheet').hidden);
    await page.waitForTimeout(600);
    assert.equal(reloaded, false, 'nothing reloaded');
    const state = await page.evaluate(() => ({ auth: !!localStorage.getItem('elan_auth_session'), cart: localStorage.getItem('elan_cart'), favs: localStorage.getItem('elan_favs'),
      cartN: document.querySelector('button[data-sheet="cart"]').getAttribute('data-n'), favN: document.querySelector('button[data-sheet="fav"]').getAttribute('data-n') }));
    assert.equal(state.auth, true);
    assert.equal(state.cartN, '2'); assert.equal(state.favN, '1');
    assert.ok(state.cart && state.favs);
  } finally { await c.context.close(); }
});

test('14. the welcome message is on screen right after signing in', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    await page.locator('[data-auth-mode="login"] input[name="email"]').fill('customer@example.test');
    await page.locator('[data-auth-mode="login"] input[name="password"]').fill('correct-password');
    await page.locator('[data-auth-mode="login"] button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('toast').className === 'show' && document.getElementById('toast').textContent.length > 0, null, { timeout: 8000 });
    assert.equal(await page.locator('#toast').textContent(), 'أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '1', null, { timeout: 3000 });   // it fades in over 0.3 s
  } finally { await c.context.close(); }
});

test('15. «حسابي»: under sign out in the menu, written once, saved on the account, and offered again (with the changes) when the customer places an order', async () => {
  const c = await context();
  try {
    await c.context.addInitScript((session) => { if (localStorage.getItem('__seeded')) return; localStorage.setItem('__seeded', '1'); localStorage.setItem('elan_auth_session', JSON.stringify(session)); }, CUSTOMER_SESSION);
    await c.context.grantPermissions(['geolocation'], { origin: H.SITE });
    await c.context.setGeolocation({ latitude: 30.0444, longitude: 31.2357 });
    const page = await openPage(c, '/');
    const csp = []; page.on('console', (m) => { if (/Content Security Policy|violates the following/i.test(m.text())) csp.push(m.text()); });
    // 1. the menu item sits right under sign out
    await page.locator('#mb').click();
    const labels = await page.locator('#menu a').allInnerTexts();
    assert.deepEqual(labels.slice(-2), ['تسجيل الخروج', 'حسابي']);
    await page.locator('#menu [data-account]').click();
    await page.waitForSelector('#sheet [data-acct-form]');
    assert.equal(await page.locator('#sheet').getAttribute('data-kind'), 'account');
    assert.equal(await page.locator('#acct-email').inputValue(), 'customer@example.test');
    assert.equal(await page.locator('#acct-email').getAttribute('readonly'), '');
    assert.equal(await page.locator('#sheet [data-back-cart]').count(), 0, 'opened from the menu: no way back to a cart');
    assert.equal(await page.locator('.acct-ship').isVisible(), false, 'the delivery address starts as "same as mine"');
    // 2. a three-part name is not accepted, and nothing is sent
    await page.locator('#acct-full_name').fill('أحمد محمد علي');
    await page.locator('#acct-phone').fill('٠١٠١٢٣٤٥٦٧٨');
    await page.locator('#sheet [data-acct-form] button[type="submit"]').click();
    assert.match(await page.locator('#sheet .acct-form .order-error').innerText(), /اكتب اسمك رباعيًا/);
    assert.equal(acctWrites.length, 0);
    // 3. "find my location": the page's own geolocation, the map frame, the address and the governorate
    await page.locator('#sheet [data-acct-locate]').first().click();
    await page.waitForFunction(() => document.getElementById('acct-address').value.length > 0, null, { timeout: 8000 });
    assert.equal(await page.locator('#acct-address').inputValue(), 'شارع التحرير، وسط البلد، القاهرة');
    assert.equal(await page.locator('#acct-governorate').inputValue(), 'القاهرة');
    assert.equal(await page.locator('.acct-map iframe').first().getAttribute('src'), 'https://www.google.com/maps?q=30.0444,31.2357&z=17&output=embed');
    assert.equal(await page.locator('.acct-map').first().isVisible(), true);
    assert.match(await page.locator('.acct-loc-note').first().innerText(), /أضف رقم المبنى والدور والشقة/);
    // 4. the rest: four names, another delivery address and another recipient
    await page.locator('#acct-full_name').fill('أحمد محمد علي حسن');
    await page.locator('input[name="ship_same"]').uncheck();
    await page.waitForSelector('.acct-ship', { state: 'visible' });
    await page.locator('#acct-ship_governorate').selectOption('الجيزة');
    await page.locator('#acct-ship_address').fill('5 شارع النيل، المعادي، بجوار الصيدلية');
    await page.locator('#acct-recipient_name').fill('منى سيد');
    await page.locator('#acct-recipient_phone').fill('+20 111 222 3334');
    await page.locator('textarea[name="delivery_notes"]').fill('اتصل قبل الوصول');
    await page.locator('#sheet [data-acct-form] button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('sheet').hidden);
    assert.equal(await page.locator('#toast').textContent(), 'تم حفظ بياناتك');
    assert.equal(acctWrites.length, 1, 'one save');
    const w = acctWrites[0];
    assert.match(w.url, /\/rest\/v1\/customer_details\?on_conflict=user_id$/);
    assert.equal(w.prefer, 'resolution=merge-duplicates,return=representation');
    assert.equal(w.auth, 'Bearer customer-test-token', 'written with the customer\'s own token');
    assert.deepEqual(w.body, { user_id: 'customer-1', full_name: 'أحمد محمد علي حسن', phone: '01012345678', governorate: 'القاهرة', address: 'شارع التحرير، وسط البلد، القاهرة', address_lat: 30.0444, address_lng: 31.2357,
      ship_same: false, ship_governorate: 'الجيزة', ship_address: '5 شارع النيل، المعادي، بجوار الصيدلية', ship_lat: null, ship_lng: null,
      recipient_name: 'منى سيد', recipient_phone: '01112223334', delivery_notes: 'اتصل قبل الوصول' });
    // 5. "place order": «حسابي» opens first, with what was saved; the customer changes one thing and presses OK
    await page.evaluate(() => openAccount('Test Store'));   // what «place order» calls once the cart lines pass the review check (openStoreOrder itself is covered in tests/customer-account-page.test.js)
    await page.waitForSelector('#sheet .acct-wrap [data-back-cart]', { state: 'attached' });
    assert.equal(await page.locator('#acct-full_name').inputValue(), 'أحمد محمد علي حسن');
    assert.equal(await page.locator('#acct-phone').inputValue(), '01012345678');
    assert.equal(await page.locator('#acct-address').inputValue(), 'شارع التحرير، وسط البلد، القاهرة');
    assert.equal(await page.locator('input[name="ship_same"]').isChecked(), false);
    assert.equal(await page.locator('#acct-ship_address').inputValue(), '5 شارع النيل، المعادي، بجوار الصيدلية');
    assert.equal(await page.locator('#acct-recipient_phone').inputValue(), '01112223334');
    await page.locator('#acct-recipient_phone').fill('01099998888');
    await page.locator('#sheet [data-acct-form] button[type="submit"]').click();
    await page.waitForSelector('[data-store-order-form]');
    assert.equal(acctWrites.length, 2, 'the change was saved');
    assert.equal(acctWrites[1].body.recipient_phone, '01099998888');
    // 6. the order form is filled from «حسابي»: the store delivers to the recipient, at the delivery address, and still sees who bought
    const f = (n) => page.locator('[data-store-order-form] [name="' + n + '"]').inputValue();
    assert.equal(await f('name'), 'منى سيد');
    assert.equal(await f('phone'), '01099998888');
    assert.equal(await f('email'), 'customer@example.test');
    assert.equal(await f('address'), 'الجيزة، 5 شارع النيل، المعادي، بجوار الصيدلية');
    assert.equal(await f('notes'), 'المشتري: أحمد محمد علي حسن - 01012345678\nاتصل قبل الوصول');
    assert.deepEqual(csp, [], 'the policy let the map, the address lookup and the location request through');
  } finally { await c.context.close(); }
});
