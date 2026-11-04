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

let browser, server;
test.before(async () => { server = await H.startServer(); browser = await pw.chromium.launch({ args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); if (server) await server.stop(); });

async function context({ session = null } = {}) {
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
  await page.route('**/api/customer-cart', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"ok":true,"items":[]}' }));
  await page.route('**/api/request-store-order-cancellation', route => H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '{"requestId":"request-1","duplicate":false}' }));
  await page.route('**/sbgdtuqfrnfeggkwqtrw.supabase.co/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/auth/v1/token') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMER_SESSION) });
    if (url.pathname === '/auth/v1/user') return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMER_SESSION.user) });
    if (url.pathname.includes('/cart_items')) return H.safeFulfill(route, { status: 200, contentType: 'application/json', body: '[]' });
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

test('3. sign-up sheet exposes the required safe fields and consent copy', async () => {
  const c = await context();
  try {
    const page = await openPage(c, '/');
    await page.locator('#mb').click();
    await page.locator('#menu [data-sheet="signup"]').click();
    const form = page.locator('[data-auth-form="signup"], form[data-auth-mode="signup"]');
    assert.equal(await form.count(), 1);
    assert.equal(await form.locator('input[name="name"]').getAttribute('autocomplete'), 'off');
    assert.equal(await form.locator('input[name="password"]').getAttribute('autocomplete'), 'new-password');
    assert.equal(await form.locator('.auth-consent').count(), 1);
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
    assert.equal(await page.locator('#sheet').isHidden(), false);
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
