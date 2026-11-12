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
const STORE_PRODUCT = '8c1b2d3e-4f50-4a61-8b72-9c0d1e2f3a41', NEW_ID = '5d6e7f80-91a2-4b3c-8d4e-5f6071829304';
let carry = null, tokenUser = null;     // what /api/signup-carry received and how it answers; the user a sign-in returns (null = the usual customer)
let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function context({ session = null } = {}) {
  favRows = []; favWrites = []; acctRow = null; acctWrites = [];
  carry = { calls: [], claimDelay: 0, claimAnswer: { ok: true, claimed: false, cart: 0, favs: 0 } }; tokenUser = null;
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
    body: JSON.stringify({ display_name: 'x', address: { house_number: '12', road: 'شارع التحرير', suburb: 'وسط البلد', city: 'القاهرة', state: 'محافظة القاهرة', country: 'مصر' } }) }));
  await page.route('https://www.google.com/maps*', route => H.safeFulfill(route, { status: 200, contentType: 'text/html', body: '<!doctype html><title>map</title><p>map</p>' }));
  await page.route('**/api/signup-carry', async route => {
    const request = route.request(), body = JSON.parse(request.postData() || '{}');
    carry.calls.push({ method: request.method(), auth: request.headers().authorization || '', cookie: request.headers().cookie || '', body });
    if (body.action === 'claim' && carry.claimDelay) await new Promise((resolve) => setTimeout(resolve, carry.claimDelay));
    return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(body.action === 'claim' ? carry.claimAnswer : { ok: true }) });
  });
  await page.route('**/api/customer-cart', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"ok":true,"items":[]}' }));
  await page.route('**/api/request-store-order-cancellation', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"requestId":"request-1","duplicate":false}' }));
  await page.route('**/sbgdtuqfrnfeggkwqtrw.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/auth/v1/token') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(tokenUser ? { ...CUSTOMER_SESSION, user: tokenUser } : CUSTOMER_SESSION) });
    if (url.pathname === '/auth/v1/signup') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ id: NEW_ID, email: 'new@example.test', identities: [{ id: 'identity-1' }], confirmation_sent_at: '2026-11-10T10:00:00Z' }) });
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
      acctRow = { ...body, ...(body.ship_same ? { ship_governorate: body.governorate, ship_city: body.city, ship_address: body.address, ship_building_no: body.building_no, ship_floor_no: body.floor_no, ship_apartment_no: body.apartment_no, ship_lat: body.address_lat, ship_lng: body.address_lng } : {}) };
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
    await page.waitForSelector('#sheet[data-kind="welcome"] .auth-done', { timeout: 8000 });
    assert.equal(await page.locator('#sheet [data-auth-mode="login"]').count(), 0, 'the login form is replaced by the welcome card, and the cart does not open by itself');
    await page.locator('#sheet [data-close-sheet].btn').click();
    assert.equal(await page.locator('#sheet').isHidden(), true, 'OK closes the card');
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
    assert.match(await page.locator('#ordersCount').innerText(), /واحد/);
    assert.match(await page.locator('#ordersHeadline').innerText(), /عندك طلب واحد/);
    assert.match(await page.locator('#activeOrders').innerText(), /ELN-TEST-0001/);
    // An order the store has not confirmed yet: its sentence, the four steps with the second one "now", its total, and no empty shipping box.
    assert.match(await page.locator('#activeOrders .acct-order h3').first().innerText(), /المتجر يراجع طلبك/);
    assert.equal(await page.locator('#activeOrders .acct-steps li').count(), 4);
    assert.match(await page.locator('#activeOrders .acct-steps li.current').innerText(), /أكّد المتجر/);
    assert.match(await page.locator('#activeOrders .acct-total').innerText(), /150\s*ج\.م/);
    assert.equal(await page.locator('#activeOrders .shipment-box').count(), 0);
    // The page is styled by its own sheet (the gold wordmark and the card), and the cart link sits in the top bar, not over the content.
    assert.equal(await page.locator('link[href^="/account.css"]').count(), 1);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#cartShortcut')).position), 'static');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.acct-order')).borderRadius !== '0px'), true);
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
    assert.equal(await page.locator('#sheet[data-kind="goodbye"] .auth-done h3').textContent(), 'تم تسجيل الخروج بنجاح', 'the goodbye card is on screen after signing out');
    assert.match(await page.locator('#sheet .auth-done p').textContent(), /كنا سعداء بوجودك معنا، وفي انتظارك دائمًا\./, 'with the farewell line');
    assert.equal(await page.locator('#sheet [data-close-sheet].btn').textContent(), 'موافق', 'it has its own OK button, like the first-time welcome');
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
    const yes = await page.locator('#sheet [data-logout-now]').boundingBox(), no = await page.locator('#sheet .auth-actions [data-close-sheet]').boundingBox();
    const [left, right] = yes.x < no.x ? [yes, no] : [no, yes];
    assert.ok(right.x - (left.x + left.width) >= 8, 'OK and Cancel are two separate buttons with room between them, not one on top of the other');
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
    await page.waitForSelector('#sheet[data-kind="welcome"] .auth-done', { timeout: 8000 });
    assert.equal(await page.locator('#sheet .auth-done h3').textContent(), 'تم تسجيل الدخول بنجاح');
    assert.match(await page.locator('#sheet .auth-done p').textContent(), /أهلًا ومرحبًا بك ونتمنى لك رحلة تسويقية ممتعة/);
    assert.equal(await page.locator('#sheet [data-close-sheet].btn').textContent(), 'موافق', 'the same card and OK button as the first-time welcome');
    assert.equal(await page.locator('#toast.show').count(), 0, 'no toast any more');
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
    // 3. "find my location": the page's own geolocation, the map frame, and the governorate, city, street and building from the lookup
    await page.locator('#sheet [data-acct-locate]').first().click();
    await page.waitForFunction(() => document.getElementById('acct-address').value.length > 0, null, { timeout: 8000 });
    assert.equal(await page.locator('#acct-address').inputValue(), 'شارع التحرير');
    assert.equal(await page.locator('#acct-city').inputValue(), 'وسط البلد', 'the governorate\'s own name is not repeated as the city');
    assert.equal(await page.locator('#acct-building_no').inputValue(), '12');
    assert.equal(await page.locator('#acct-floor_no').inputValue(), '', 'the floor and the flat are for the customer to write');
    assert.equal(await page.locator('#acct-governorate').inputValue(), 'القاهرة');
    assert.equal(await page.locator('.acct-map iframe').first().getAttribute('src'), 'https://www.google.com/maps?q=30.0444,31.2357&z=17&output=embed');
    assert.equal(await page.locator('.acct-map').first().isVisible(), true);
    assert.match(await page.locator('.acct-loc-note').first().innerText(), /راجع العنوان وأكمل المبنى والدور والشقة/);
    // 4. the rest: floor and flat, four names, another delivery address and another recipient
    await page.locator('#acct-full_name').fill('أحمد محمد علي حسن');
    await page.locator('#acct-floor_no').fill('3');
    await page.locator('#acct-apartment_no').fill('8');
    await page.locator('input[name="ship_same"]').uncheck();
    await page.waitForSelector('.acct-ship', { state: 'visible' });
    await page.locator('#acct-ship_governorate').selectOption('الجيزة');
    await page.locator('#acct-ship_city').fill('المعادي');
    await page.locator('#acct-ship_address').fill('شارع النيل، بجوار الصيدلية');
    await page.locator('#acct-ship_building_no').fill('5');
    await page.locator('#acct-ship_apartment_no').fill('2');
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
    assert.deepEqual(w.body, { user_id: 'customer-1', full_name: 'أحمد محمد علي حسن', phone: '01012345678', governorate: 'القاهرة', city: 'وسط البلد', address: 'شارع التحرير', building_no: '12', floor_no: '3', apartment_no: '8', address_lat: 30.0444, address_lng: 31.2357,
      ship_same: false, ship_governorate: 'الجيزة', ship_city: 'المعادي', ship_address: 'شارع النيل، بجوار الصيدلية', ship_building_no: '5', ship_floor_no: null, ship_apartment_no: '2', ship_lat: null, ship_lng: null,
      recipient_name: 'منى سيد', recipient_phone: '01112223334', delivery_notes: 'اتصل قبل الوصول' });
    // 5. "place order" with a complete «حسابي» opens the read-only review first (phase 1: no editable order form any more); «تعديل بياناتي» opens «حسابي» with a way back
    //    to the cart. The catalogue is empty in this mocked page, so the cart line the review needs is given by the page's own cartGroups().
    await page.evaluate(() => {
      window.cartGroups = function () { return { 'Test Store': [{ c: { q: 1 }, p: { name: 'Test Perfume', brand: 'Test Brand', sz: '50 ml' }, b: { store: 'Test Store', storeId: 'store-1', storeProductId: 'sp-1', price: 150, cur: 'EGP', review: false } }] }; };
      openStoreOrder('Test Store');
    });
    await page.waitForSelector('[data-store-order-form]');
    assert.equal(await page.locator('#sheet .acct-wrap').count(), 0, 'a complete account goes straight to the review, not to the editing form');
    assert.equal(await page.locator('[data-store-order-form] input, [data-store-order-form] textarea').count(), 0, 'the review is read only: the form holds the order button alone');
    await page.locator('[data-acct-edit]').click();
    await page.waitForSelector('#sheet .acct-wrap [data-back-cart]', { state: 'attached' });
    assert.equal(await page.locator('#acct-full_name').inputValue(), 'أحمد محمد علي حسن');
    assert.equal(await page.locator('#acct-phone').inputValue(), '01012345678');
    assert.equal(await page.locator('#acct-address').inputValue(), 'شارع التحرير');
    assert.equal(await page.locator('#acct-city').inputValue(), 'وسط البلد');
    assert.equal(await page.locator('#acct-apartment_no').inputValue(), '8');
    assert.equal(await page.locator('input[name="ship_same"]').isChecked(), false);
    assert.equal(await page.locator('#acct-ship_city').inputValue(), 'المعادي');
    assert.equal(await page.locator('#acct-ship_address').inputValue(), 'شارع النيل، بجوار الصيدلية');
    assert.equal(await page.locator('#acct-ship_building_no').inputValue(), '5');
    assert.equal(await page.locator('#acct-recipient_phone').inputValue(), '01112223334');
    await page.locator('#acct-recipient_phone').fill('01099998888');
    await page.locator('#sheet [data-acct-form] button[type="submit"]').click();
    await page.waitForSelector('[data-store-order-form]');
    assert.equal(acctWrites.length, 2, 'the change was saved');
    assert.equal(acctWrites[1].body.recipient_phone, '01099998888');
    // 6. the review shows what «حسابي» holds: the store delivers to the recipient, at the delivery address, and still sees who bought
    const review = await page.locator('.order-review').innerText();
    assert.match(review, /منى سيد/, 'the recipient');
    assert.match(review, /01099998888/, 'with the changed phone');
    assert.match(review, /customer@example\.test/);
    assert.match(review, /الجيزة، المعادي، شارع النيل، بجوار الصيدلية، مبنى 5، شقة 2/, 'the courier reads it in order: governorate, city, street, building, flat');
    assert.match(review, /المشتري: أحمد محمد علي حسن - 01012345678/);
    assert.match(review, /اتصل قبل الوصول/);
    assert.deepEqual(csp, [], 'the policy let the map, the address lookup and the location request through');
  } finally { await c.context.close(); }
});

// 16. the e-mail confirmation link. It used to sync the cart but never the favourites, and an older account's session left in the browser
//     could put that account's lists on screen (and refresh its token over the new one) while the link was being opened.
const CONFIRM_HASH = '#access_token=new-token&refresh_token=new-refresh&expires_in=3600&token_type=bearer&type=signup';
async function openConfirmLink(c, { oldAccountFavs = [] } = {}) {
  const page = await c.context.newPage();
  await mockPage(page);
  await page.route('**/auth/v1/user', async route => {
    await new Promise((resolve) => setTimeout(resolve, 1500));   // the catalogue and the startup sync are done before the link's answer arrives, as on a phone
    return H.safeFulfill(route, { status: 200, contentType: 'application/json',
      body: JSON.stringify(/new-token/.test(route.request().headers().authorization || '') ? { id: 'new-1', email: 'new@example.test' } : CUSTOMER_SESSION.user) });
  });
  await page.route('**/rest/v1/favorites*', route => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(request.url().includes('user_id=eq.old-1') ? oldAccountFavs : []) });
  });
  await page.goto(H.SITE + '/' + CONFIRM_HASH, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('sheet') && document.getElementById('sheet').dataset.kind === 'confirmed', null, { timeout: 10000 });
  await page.waitForTimeout(800);
  return page;
}
const badges = (page) => page.evaluate(() => ({
  cartN: document.querySelector('button[data-sheet="cart"]').getAttribute('data-n'), favN: document.querySelector('button[data-sheet="fav"]').getAttribute('data-n'),
  cartOwner: localStorage.getItem('elan_cart_owner'), favOwner: localStorage.getItem('elan_favs_owner'), auth: (JSON.parse(localStorage.getItem('elan_auth_session') || 'null') || {}).user }));

test('16. the confirmation link keeps what the visitor put in the cart and the favourites, and saves both on the new account', async () => {
  const c = await context();
  try {
    await c.context.addInitScript((size) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, q: 2 }]));
      localStorage.setItem('elan_favs', JSON.stringify([size]));
    }, FAV_SIZE);
    const page = await openConfirmLink(c);
    const after = await badges(page);
    assert.equal(after.auth && after.auth.id, 'new-1');
    assert.equal(after.cartN, '2'); assert.equal(after.favN, '1');
    assert.equal(after.favOwner, 'new-1', 'the favourites now belong to the new account');
    const posted = favWrites.filter((w) => w.method === 'POST').flatMap((w) => JSON.parse(w.body));
    assert.deepEqual(posted, [{ user_id: 'new-1', product_size_id: FAV_SIZE }], 'the heart the visitor pressed is saved on the account');
  } finally { await c.context.close(); }
});

test('16b. an older account left signed in on the device never lends its cart or favourites to the account being confirmed', async () => {
  const c = await context();
  try {
    await c.context.addInitScript(([size, session]) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_auth_session', JSON.stringify(session));
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, q: 2 }]));
      localStorage.setItem('elan_cart_owner', 'old-1');
      localStorage.setItem('elan_favs', JSON.stringify([size]));
      localStorage.setItem('elan_favs_owner', 'old-1');
    }, [FAV_SIZE, { access_token: 'old-token', refresh_token: 'old-refresh', user: { id: 'old-1', email: 'old@example.test' } }]);
    const page = await openConfirmLink(c, { oldAccountFavs: [{ product_size_id: FAV_SIZE }] });
    const after = await badges(page);
    assert.equal(after.auth && after.auth.id, 'new-1', 'the session is the new account\'s');
    assert.equal(after.cartN, '0'); assert.equal(after.favN, '0');
    assert.equal(after.cartOwner, 'new-1'); assert.equal(after.favOwner, 'new-1');
    assert.deepEqual(favWrites.filter((w) => w.method !== 'GET'), [], 'nothing of the old account is written onto the new one');
  } finally { await c.context.close(); }
});

// 17. «forgot password»: the e-mail link opens a card on the shop itself where the new password is written (owner, 8 Nov 2026); no second page.
const RECOVERY_HASH = '#access_token=rec-token&refresh_token=rec-refresh&expires_in=3600&token_type=bearer&type=recovery';
test('17. the reset link opens the new-password card on the shop, the password is saved with the link\'s token, and the customer stays on the shop signed in', async () => {
  const c = await context();
  try {
    const page = await c.context.newPage();
    await mockPage(page);
    const puts = [];
    await page.route('**/auth/v1/user', route => {
      const request = route.request();
      const bearer = request.headers().authorization || '';
      if (request.method() === 'PUT') {
        puts.push({ bearer, body: JSON.parse(request.postData() || '{}') });
        return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'rec-1', email: 'rec@example.test' }) });
      }
      return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(/rec-token/.test(bearer) ? { id: 'rec-1', email: 'rec@example.test' } : CUSTOMER_SESSION.user) });
    });
    await page.goto(H.SITE + '/' + RECOVERY_HASH, { waitUntil: 'load' });
    await page.waitForSelector('#sheet[data-kind="newpass"] form[data-newpass-form]', { timeout: 10000 });
    assert.equal(new URL(page.url()).pathname, '/', 'on the shop, not on the orders page');
    assert.equal(new URL(page.url()).hash, '', 'the token is out of the address bar');
    assert.equal(await page.evaluate(() => localStorage.getItem('elan_auth_session')), null, 'not signed in before the password is saved');
    const fields = page.locator('#sheet form[data-newpass-form] input[type="password"]');
    assert.equal(await fields.count(), 2);
    await page.locator('#sheet form[data-newpass-form] input[name="password"]').fill('a-brand-new-password');
    await page.locator('#sheet form[data-newpass-form] input[name="confirm"]').fill('a-different-one');
    await page.locator('#sheet form[data-newpass-form] button[type="submit"]').click();
    await page.waitForSelector('#toast.show', { timeout: 4000 });
    assert.equal(await page.locator('#toast').textContent(), 'كلمتا المرور غير متطابقتين.');
    assert.deepEqual(puts, [], 'a mismatch is caught in the page');
    await page.locator('#sheet form[data-newpass-form] input[name="confirm"]').fill('a-brand-new-password');
    await page.locator('#sheet form[data-newpass-form] button[type="submit"]').click();
    await page.waitForSelector('#sheet[data-kind="passChanged"] .auth-done', { timeout: 10000 });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].bearer, 'Bearer rec-token');
    assert.deepEqual(puts[0].body, { password: 'a-brand-new-password' });
    assert.equal(await page.locator('#sheet .auth-done h3').textContent(), 'تم تغيير كلمة المرور');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('elan_auth_session'))).user.id, 'rec-1', 'signed in with the new password');
    assert.equal(new URL(page.url()).pathname, '/', 'still on the shop: no second page');
    await page.locator('#sheet [data-close-sheet].btn').click();
    assert.equal(await page.locator('#sheet').isHidden(), true);
  } finally { await c.context.close(); }
});

// 18. the eye on every password field: hidden by default, shown only while the customer asks for it.
test('18. every password field has an eye: hidden by default, one tap shows what was typed, a second tap hides it again', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    for (const sheetName of ['login', 'signup']) {
      await page.locator('#mb').click();
      await page.locator(`#menu [data-sheet="${sheetName}"]`).click();
      const field = page.locator(`[data-auth-mode="${sheetName}"] input[name="password"]`);
      await field.fill('Typed-Secret-1');
      assert.equal(await field.getAttribute('type'), 'password', sheetName + ': hidden by default');
      const eye = page.locator(`[data-auth-mode="${sheetName}"] .pw-wrap .pw-eye`);
      assert.equal(await eye.count(), 1, sheetName + ': one eye');
      assert.equal(await eye.getAttribute('aria-pressed'), 'false');
      await eye.click();
      assert.equal(await field.getAttribute('type'), 'text', sheetName + ': shown after the tap');
      assert.equal(await field.inputValue(), 'Typed-Secret-1', 'what he typed is kept');
      assert.equal(await eye.getAttribute('aria-pressed'), 'true');
      await eye.click();
      assert.equal(await field.getAttribute('type'), 'password', sheetName + ': hidden again after the second tap');
      assert.equal(await eye.getAttribute('aria-pressed'), 'false');
      await page.locator('#sheet [data-close-sheet]').first().click();
    }
  } finally { await c.context.close(); }
});

// 19. two tabs of one browser: signing out in one makes the other forget the account's lists (before, the left-open tab kept them in memory
//     and could write them back to the device as a visitor's lists after the sign-out).
test('19. signing out in one tab makes another open tab reload as a visitor, without the account\'s cart and hearts', async () => {
  const c = await context();
  try {
    await c.context.addInitScript(([size, session]) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_auth_session', JSON.stringify(session));
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, q: 2 }]));
      localStorage.setItem('elan_favs', JSON.stringify([size]));
    }, [FAV_SIZE, CUSTOMER_SESSION]);
    const first = await openPage(c, '/');
    const second = await openPage(c, '/');
    const badges = (p) => p.evaluate(() => ({ cartN: document.querySelector('button[data-sheet="cart"]').getAttribute('data-n'), favN: document.querySelector('button[data-sheet="fav"]').getAttribute('data-n') }));
    assert.deepEqual(await badges(first), { cartN: '2', favN: '1' });
    await second.locator('#mb').click();
    await second.locator('#menu [data-logout]').click();
    await Promise.all([first.waitForEvent('load', { timeout: 10000 }), second.waitForEvent('load', { timeout: 10000 }), second.locator('#sheet [data-logout-now]').click()]);
    await first.waitForTimeout(800);
    assert.deepEqual(await badges(first), { cartN: '0', favN: '0' }, 'the left-open tab shows a visitor');
    const device = await first.evaluate(() => ({ auth: localStorage.getItem('elan_auth_session'), cart: localStorage.getItem('elan_cart'), favs: localStorage.getItem('elan_favs'), owner: localStorage.getItem('elan_cart_owner') }));
    assert.deepEqual(device, { auth: null, cart: null, favs: null, owner: null }, 'nothing of the account is written back to the device');
  } finally { await c.context.close(); }
});

// 20. the cart and hearts follow the account to the browser that confirms it (owner, 9 Nov 2026): he registered in one browser and the e-mail link opened in another.
//     The registering browser leaves its lists for the new account (no session, no browser key); the confirming browser takes them BEFORE it reads the cart.
async function signUpForm(page) {
  await page.locator('#mb').click();
  await page.locator('#menu [data-sheet="signup"]').click();
  await page.locator('[data-auth-mode="signup"] input[name="name"]').fill('Test Buyer');
  await page.locator('[data-auth-mode="signup"] input[name="email"]').fill('new@example.test');
  await page.locator('[data-auth-mode="signup"] input[name="password"]').fill('a-test-password');
  await page.locator('[data-auth-mode="signup"] button[type="submit"]').click();
}
test('20. browser A leaves its cart and hearts for the new account, and browser B takes them before it reads the cart', async () => {
  const a = await context();
  try {
    await a.context.addInitScript(([size, sp]) => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('elan_cart', JSON.stringify([{ sid: size, storeProductId: sp, q: 2 }]));
      localStorage.setItem('elan_favs', JSON.stringify([size]));
    }, [FAV_SIZE, STORE_PRODUCT]);
    const page = await openPage(a, '/');
    await signUpForm(page);
    await page.waitForSelector('#sheet[data-kind="signupDone"]', { timeout: 8000 });
    for (let i = 0; i < 40 && !carry.calls.length; i++) await page.waitForTimeout(100);
    assert.equal(carry.calls.length, 1, 'one hand-over right after the sign-up');
    const left = carry.calls[0];
    assert.equal(left.method, 'POST');
    assert.deepEqual(left.body, { action: 'stash', userId: NEW_ID, cart: [{ sid: FAV_SIZE, storeProductId: STORE_PRODUCT, q: 2 }], favs: [FAV_SIZE] });
    assert.equal(left.auth, '', 'no token: the account has no session before it is confirmed');
    assert.doesNotMatch(left.cookie, /elan_vk|elan_gid/, 'no visitor cookie travels with it');
    assert.equal(await page.evaluate(() => localStorage.getItem('elan_auth_session')), null, 'nobody is signed in');
  } finally { await a.context.close(); }

  // browser B: empty device, the link opens here; the claim answer is slow on purpose
  const b = await context();
  try {
    carry.claimDelay = 900; carry.claimAnswer = { ok: true, claimed: true, cart: 1, favs: 1 };
    const order = [];
    b.context.on('response', (response) => { if (new URL(response.url()).pathname === '/api/signup-carry') order.push('claim-answered'); });
    b.context.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/signup-carry') order.push('claim');
      else if (url.pathname.includes('/rest/v1/cart_items') && request.method() === 'GET') order.push('read-cart');
      else if (url.pathname.includes('/rest/v1/favorites') && request.method() === 'GET') order.push('read-favs');
    });
    await openConfirmLink(b);
    const claims = carry.calls.filter((call) => call.body.action === 'claim');
    assert.equal(claims.length, 1, 'the confirming browser takes the lists once');
    assert.equal(claims[0].auth, 'Bearer new-token', 'with the new account\'s own token');
    assert.deepEqual(claims[0].body, { action: 'claim' }, 'it names no account: the token decides');
    assert.ok(order.includes('read-cart') && order.includes('read-favs'));
    assert.ok(order.indexOf('claim-answered') >= 0 && order.indexOf('claim-answered') < order.indexOf('read-cart') && order.indexOf('claim-answered') < order.indexOf('read-favs'), 'the claim is answered before the cart and hearts are read: ' + order.join(','));
  } finally { await b.context.close(); }
});

test('20b. signing in takes the carried lists only for an account made in the last three days, and a failing claim never blocks the welcome', async () => {
  const signIn = async (c) => {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    await page.locator('[data-auth-mode="login"] input[name="email"]').fill('customer@example.test');
    await page.locator('[data-auth-mode="login"] input[name="password"]').fill('correct-password');
    await page.locator('[data-auth-mode="login"] button[type="submit"]').click();
    await page.waitForSelector('#sheet[data-kind="welcome"] .auth-done', { timeout: 8000 });
    await page.waitForTimeout(600);
  };
  const old = await context();
  try {
    tokenUser = { ...CUSTOMER_SESSION.user, created_at: '2026-01-01T00:00:00Z' };
    await signIn(old);
    assert.deepEqual(carry.calls, [], 'an old account never asks');
  } finally { await old.context.close(); }
  const unknown = await context();
  try {
    await signIn(unknown);
    assert.deepEqual(carry.calls, [], 'an account whose age is not known never asks');
  } finally { await unknown.context.close(); }
  const young = await context();
  try {
    tokenUser = { ...CUSTOMER_SESSION.user, created_at: new Date(Date.now() - 3600 * 1000).toISOString() };
    await signIn(young);
    assert.equal(carry.calls.length, 1);
    assert.equal(carry.calls[0].auth, 'Bearer ' + CUSTOMER_SESSION.access_token);
    assert.deepEqual(carry.calls[0].body, { action: 'claim' });
  } finally { await young.context.close(); }
  const failing = await context();
  try {
    tokenUser = { ...CUSTOMER_SESSION.user, created_at: new Date().toISOString() };
    const page = await failing.context.newPage();
    await mockPage(page);
    await page.route('**/api/signup-carry', (route) => H.safeFulfill(route, { status: 500, contentType: 'application/json', body: '{"ok":false}' }));
    await page.goto(H.SITE + '/', { waitUntil: 'load' });
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="login"]').click();
    await page.locator('[data-auth-mode="login"] input[name="email"]').fill('customer@example.test');
    await page.locator('[data-auth-mode="login"] input[name="password"]').fill('correct-password');
    await page.locator('[data-auth-mode="login"] button[type="submit"]').click();
    await page.waitForSelector('#sheet[data-kind="welcome"] .auth-done', { timeout: 8000 });
    assert.ok(await page.evaluate(() => !!JSON.parse(localStorage.getItem('elan_auth_session') || 'null')), 'signed in although the hand-over failed');
  } finally { await failing.context.close(); }
});

test('21. the orders page shows every state in the shop\'s own look on a phone: steps for what is open, a compact row with "order again" for what is over, and nothing wider than the screen', async () => {
  const c = await context({ session: CUSTOMER_SESSION });
  try {
    const item = (name, q, price) => ({ product_name: name, brand_name: 'Test Brand', size_label: '100 ml', product_size_id: FAV_SIZE, quantity: q, unit_price: price, line_total: price * q, currency: 'EGP' });
    const order = (id, no, status, extra = {}) => ({ id, tracking_number: no, status, subtotal: 3450, shipping_amount: 60, total_amount: 3510, currency: 'EGP', created_at: '2026-10-28T10:00:00Z', stores: { name: 'Test Store' }, store_order_request_items: [item('Test Perfume', 1, 3450)], store_shipments: [], store_order_cart_restorations: [], store_order_cancellation_requests: [], ...extra });
    const orders = [
      order('o1', 'ELN-TEST-AAAA', 'shipped', { store_order_request_items: [item('One', 2, 1000), item('Two', 1, 500), item('Three', 1, 400), item('Four', 1, 300), item('Five', 1, 200)],
        store_shipments: [{ carrier_name: 'Test Carrier', tracking_code: 'TC-1', shipping_status: 'in_transit', estimated_delivery_at: '2026-12-20T00:00:00Z', updated_at: '2026-11-10T08:00:00Z' }] }),
      order('o2', 'ELN-TEST-BBBB', 'processing'),
      order('o3', 'ELN-TEST-CCCC', 'delivered', { store_shipments: [{ carrier_name: 'Test Carrier', tracking_code: 'TC-2', shipping_status: 'delivered', delivery_verified_at: '2026-11-02T10:00:00Z', updated_at: '2026-11-02T10:00:00Z' }] }),
      order('o4', 'ELN-TEST-DDDD', 'store_cancelled')
    ];
    const page = await c.context.newPage();
    await mockPage(page);
    await page.route('**/api/customer-orders*', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sessions: [{ id: 's1', store_order_requests: orders }], pagination: { total: 4, hasMore: false } }) }));
    await page.goto(H.SITE + '/account.html', { waitUntil: 'load' });
    await page.waitForSelector('#app:not([hidden]) .acct-order');
    assert.match(await page.locator('#ordersHeadline').innerText(), /عندك طلبان قيد المتابعة/);
    assert.deepEqual(await page.locator('#stats .acct-stat').allInnerTexts().then(list => list.map(text => text.replace(/\s+/g, ' ').trim())), ['2 جارية', '1 وصلت', '1 ملغاة']);

    // shipped: three steps done, the last one "now"; the shipment box and only the first three items (the rest is behind "details")
    const shipped = page.locator('#activeOrders .acct-order').nth(0);
    assert.deepEqual(await shipped.locator('.acct-steps li').evaluateAll(list => list.map(li => li.className)), ['done', 'done', 'done', 'current']);
    assert.equal(await shipped.locator('.shipment-box').count(), 1);
    assert.equal(await shipped.locator('.acct-items li:not(.more)').count(), 3);
    assert.match(await shipped.locator('.acct-items .more').innerText(), /منتجان آخران/);
    // processing without a shipment yet: the shipping box says what to expect
    assert.match(await page.locator('#activeOrders .acct-order').nth(1).locator('.shipment-empty').innerText(), /يجهّز طلبك/);
    // an order that is over is a compact row, "order again" is visible, the shipping box is behind "details" (closed)
    const past = page.locator('#recentOrders .acct-order.is-past').first();
    assert.equal(await past.locator('.order-reorder').isVisible(), true);
    assert.equal(await past.locator('.shipment-box').isVisible(), false);
    await past.locator('summary').click();
    assert.equal(await past.locator('.shipment-box').isVisible(), true);
    // a cancelled order is in the list of finished orders (with its own label), not among the open ones
    assert.equal(await page.locator('#recentOrders').innerText().then(text => text.includes('ELN-TEST-DDDD')), true);
    assert.equal(await page.locator('#activeOrders').innerText().then(text => text.includes('ELN-TEST-DDDD')), false);
    // the details the customer opened stay open when the page draws the list again
    assert.equal(await past.locator('details').evaluate(node => node.open), true);
    await page.click('#refreshOrders');
    await page.waitForFunction(() => document.querySelector('#refreshOrders').disabled === false);
    assert.equal(await page.locator('#recentOrders .acct-order.is-past').first().locator('details').evaluate(node => node.open), true, 'an opened card is not shut by a refresh');

    // the look: the wordmark in gold, the order cards rounded and white, nothing wider than the phone
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.acct-mark b')).fontFamily.includes('Playfair')), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal scrolling');
    assert.equal(await page.evaluate(() => document.fonts.check("16px 'IBM Plex Sans Arabic'")), true);
  } finally { await c.context.close(); }
});

test('21b. the sign-in state of the orders page is centred in the same look, and the page never overflows', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/account.html');
    await page.waitForSelector('#login:not([hidden])');
    assert.equal(await page.locator('#app').isHidden(), true);
    assert.equal(await page.locator('#portalNotifications').isHidden(), true, 'the bell is for a signed-in customer');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.acct-h1')).textAlign), 'center');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const box = await page.locator('#loginForm').boundingBox();
    assert.ok(box.width > 250 && box.width <= 390, 'the form fits the phone');
  } finally { await c.context.close(); }
});


test('21c. asking to cancel an order: the box opens inside the card (no browser dialog), the typed reason is kept when the list is drawn again, going back closes it, send posts it once', async () => {
  const c = await context({ session: CUSTOMER_SESSION });
  try {
    const page = await c.context.newPage();
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
    await mockPage(page);
    const bodies = [];
    let cancelled = false;
    const waiting = { id: 'w1', tracking_number: 'ELN-TEST-WAIT', status: 'awaiting_store_confirmation', subtotal: 150, shipping_amount: 0, total_amount: 150, currency: 'EGP', created_at: '2026-11-10T10:00:00Z', stores: { name: 'Test Store' },
      store_order_request_items: [{ product_name: 'Test Perfume', brand_name: 'Test Brand', size_label: '100 ml', quantity: 1, unit_price: 150, line_total: 150, currency: 'EGP' }], store_shipments: [], store_order_cart_restorations: [] };
    await page.route('**/api/customer-orders*', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sessions: [{ id: 's1', store_order_requests: [{ ...waiting, store_order_cancellation_requests: cancelled ? [{ id: 'c1', status: 'requested' }] : [] }] }], pagination: { total: 1, hasMore: false } }) }));
    await page.route('**/api/request-store-order-cancellation', route => { bodies.push(JSON.parse(route.request().postData() || '{}')); cancelled = true; return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"requestId":"w1","duplicate":false}' }); });
    await page.goto(H.SITE + '/account.html', { waitUntil: 'load' });
    await page.waitForSelector('#activeOrders .order-cancel');

    await page.click('#activeOrders [data-cancel="w1"]');
    await page.waitForSelector('#cancelReason');
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'cancelReason', 'the cursor is in the reason field');
    assert.match(await page.locator('.cancel-open').innerText(), /ما سبب طلب الإلغاء/);
    assert.equal(bodies.length, 0, 'opening the box sends nothing');
    await page.fill('#cancelReason', 'اخترت المقاس الخطأ');
    // the list drawn again (a refresh by hand) keeps the box and what was typed
    await page.click('#refreshOrders');
    await page.waitForFunction(() => document.querySelector('#refreshOrders').disabled === false);
    assert.equal(await page.inputValue('#cancelReason'), 'اخترت المقاس الخطأ');
    // back closes it, the button is back, and nothing was sent
    await page.click('[data-cancel-back="w1"]');
    assert.equal(await page.locator('#cancelReason').count(), 0);
    assert.equal(await page.locator('[data-cancel="w1"]').count(), 1);
    assert.equal(bodies.length, 0);
    // open again (empty), type, send: one request with the reason, then the card shows that the request is waiting
    await page.click('[data-cancel="w1"]');
    assert.equal(await page.inputValue('#cancelReason'), '');
    await page.fill('#cancelReason', 'غيّرت رأيي');
    await page.click('[data-cancel-send="w1"]');
    await page.waitForSelector('#activeOrders .cancel-pending');
    assert.deepEqual(bodies, [{ requestId: 'w1', reason: 'غيّرت رأيي' }]);
    assert.match(await page.locator('#activeOrders .cancel-pending').innerText(), /بانتظار رده/);
    assert.equal(await page.locator('#cancelReason').count(), 0);
    assert.deepEqual(dialogs, [], 'no browser dialog was shown');
  } finally { await c.context.close(); }
});
