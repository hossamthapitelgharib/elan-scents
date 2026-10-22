const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// "طلباتي" (account.js), the orders dashboard (dashboard.js) and the customers dashboard (customers-dashboard.js)
// run here with a minimal fake page. All data below is fake.
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', className: '', disabled: false,
    dataset: {}, attributes: {}, listeners: {}, children: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return this.children[selector] || (this.children[selector] = makeNode()); },
    querySelectorAll() { return []; }
  };
}

function load(files, ids, fetchImpl) {
  const nodes = new Map(ids.map(id => [id, makeNode()]));
  const store = {};
  const document = {
    hidden: false,
    querySelector: selector => nodes.get(selector) || null,
    getElementById: id => nodes.get(`#${id}`) || null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const context = vm.createContext({
    document, console, URLSearchParams,
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
    location: { reload() {} },
    localStorage: { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); }, removeItem: key => { delete store[key]; } },
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); })
  });
  context.window = context;
  context.addEventListener = () => {};
  for (const file of files) vm.runInContext(read(file), context, { filename: file });
  return { context, nodes, store };
}
const signIn = store => { store.elan_auth_session = JSON.stringify({ access_token: 'fake-token' }); };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body });

const ACCOUNT_IDS = ['#loginForm', '#archiveForm', '#loadMoreOrders', '#loadMoreArchive', '#message', '#appMessage', '#login', '#app', '#logout',
  '#ordersCount', '#stats', '#activeOrders', '#recentOrders', '#archiveOrders', '#archiveSearch', '#archiveYear', '#cartShortcut'];
const DASHBOARD_IDS = ['#authForm', '#authCard', '#authError', '#dashboard', '#ordersError', '#logout', '#lastUpdated', '#refreshBtn', '#loadMoreOrders',
  '#saveSettingsBtn', '#statusFilter', '#matchFilter', '#searchFilter', '#stats', '#orders', '#storeSettings', '#settingsNotice'];
const CUSTOMERS_IDS = ['#customerTabs', '#registeredAnalytics', '#guestAnalytics', '#loginForm', '#login', '#app', '#logout', '#message', '#platformError', '#stats',
  '#registeredCount', '#visitorCount', '#registeredCustomers', '#guestCustomers', '#registeredPagination', '#visitorPagination'];

const cancelledSession = { id: 's1', created_at: '2026-01-01T00:00:00Z', store_order_requests: [{ id: 'r1', tracking_number: 'TEST-CANCELLED-1', status: 'cancelled', subtotal: 100, total_amount: 100, currency: 'EGP', stores: { name: 'Test Store' }, store_order_request_items: [], store_order_cart_restorations: [], store_shipments: [] }] };

test('portal turns API and sign-in error codes into Arabic and keeps unknown codes for support', () => {
  const { context } = load(['portal.js'], []);
  const text = (error, fallback) => vm.runInContext('Portal.errorText', context)(error, fallback);
  assert.match(text(new Error('forbidden')), /غير مصرح/);
  assert.match(text('invalid_credentials'), /غير صحيحة/);
  assert.equal(text(new Error('هذا نص عربي جاهز')), 'هذا نص عربي جاهز');
  assert.match(text(new TypeError('Failed to fetch')), /تعذر الاتصال/);
  assert.equal(text(new Error('brand_new_code'), 'تعذر تنفيذ العملية.'), 'تعذر تنفيذ العملية. (brand_new_code)');
  assert.equal(text(new Error('Unexpected token < in JSON'), 'تعذر تنفيذ العملية.'), 'تعذر تنفيذ العملية.');
  assert.equal(text(null, 'x'), 'x');
});

test('portal sign-in shows Arabic for a wrong password, a network failure and an unknown rejection, and stores the session on success', async () => {
  const form = { email: { value: ' person@example.test ' }, password: { value: 'fake-password' } };
  const attempt = async tokenResponse => {
    const { context, store } = load(['portal.js'], [], async url => {
      if (String(url) === '/api/config') return json(200, { url: 'https://project.example.test', key: 'fake-anon-key' });
      if (tokenResponse instanceof Error) throw tokenResponse;
      return tokenResponse;
    });
    let error = null, result = null;
    try { result = await vm.runInContext('Portal.login', context)(form); } catch (caught) { error = caught; }
    return { error, result, store };
  };

  const wrong = await attempt(json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }));
  assert.match(wrong.error.message, /غير صحيحة/);
  assert.doesNotMatch(wrong.error.message, /Invalid login credentials/);
  assert.equal(wrong.store.elan_auth_session, undefined);

  assert.match((await attempt(new TypeError('Failed to fetch'))).error.message, /تعذر الاتصال/);
  assert.match((await attempt(json(422, { error_code: 'weak_password', msg: 'Password is too weak' }))).error.message, /تعذر تسجيل الدخول/);

  const ok = await attempt(json(200, { access_token: 'fake-token', refresh_token: 'fake-refresh' }));
  assert.equal(ok.error, null);
  assert.equal(JSON.parse(ok.store.elan_auth_session).access_token, 'fake-token');
});

test('my orders: an error after sign-in is shown on the orders page, not in the hidden sign-in box', async () => {
  const { context, nodes } = load(['portal.js', 'account.js'], ACCOUNT_IDS);
  nodes.get('#login').hidden = true;
  nodes.get('#app').hidden = false;
  vm.runInContext('showMessage', context)(new Error('supabase_read_failed'));
  assert.equal(nodes.get('#appMessage').hidden, false);
  assert.match(nodes.get('#appMessage').textContent, /تعذر تحميل الطلبات/);
  assert.equal(nodes.get('#message').textContent, '');
  vm.runInContext('showMessage', context)('');
  assert.equal(nodes.get('#appMessage').hidden, true);
});

test('my orders: a sign-in error stays in the sign-in box and is Arabic', () => {
  const { context, nodes } = load(['portal.js', 'account.js'], ACCOUNT_IDS);
  nodes.get('#app').hidden = true;
  vm.runInContext('showMessage', context)(new Error('invalid_credentials'));
  assert.match(nodes.get('#message').textContent, /غير صحيحة/);
  assert.equal(nodes.get('#appMessage').hidden, true);
});

test('my orders: a failed archive search never leaves "searching…" on screen, and a retry works', async () => {
  let fail = true;
  const { context, nodes } = load(['portal.js', 'account.js'], ACCOUNT_IDS, async () => (fail
    ? json(502, { ok: false, error: 'supabase_read_failed' })
    : json(200, { sessions: [cancelledSession], pagination: { total: 1, hasMore: false } })));
  nodes.get('#app').hidden = false;
  nodes.get('#archiveSearch').value = ' TEST ';

  await vm.runInContext('loadArchive', context)(null, false).catch(vm.runInContext('showMessage', context));
  const box = nodes.get('#archiveOrders');
  assert.doesNotMatch(box.innerHTML, /جارٍ البحث/);
  assert.match(box.innerHTML, /تعذر إكمال البحث/);
  assert.equal(nodes.get('#appMessage').hidden, false);
  assert.equal(nodes.get('#loadMoreArchive').disabled, false);

  fail = false;
  await vm.runInContext('loadArchive', context)(null, false);
  assert.match(box.innerHTML, /TEST-CANCELLED-1/);
  assert.equal(nodes.get('#appMessage').hidden, true);
});

test('my orders: a cancelled order is closed (archive, "cancelled" label), not listed as an order to follow', async () => {
  const { context, nodes } = load(['portal.js', 'account.js'], ACCOUNT_IDS);
  vm.runInContext('renderAccount', context)([cancelledSession]);
  assert.doesNotMatch(nodes.get('#activeOrders').innerHTML, /TEST-CANCELLED-1/);
  assert.match(nodes.get('#activeOrders').innerHTML, /لا توجد طلبات حالية/);
  assert.doesNotMatch(nodes.get('#recentOrders').innerHTML, /TEST-CANCELLED-1/);
  assert.match(vm.runInContext('badgeA', context)('cancelled'), /أُلغي الطلب/);
  assert.equal(vm.runInContext('terminalA', context).has('cancelled'), true);
});

test('orders dashboard: a failed refresh or "load more" keeps the orders on screen and shows an Arabic error above them', async () => {
  const { context, nodes, store } = load(['portal.js', 'dashboard.js'], DASHBOARD_IDS, async () => json(502, { ok: false, error: 'dashboard_read_failed' }));
  signIn(store);
  nodes.get('#dashboard').hidden = false;
  nodes.get('#authCard').hidden = true;
  await vm.runInContext('loadOrders', context)(true);
  assert.equal(nodes.get('#dashboard').hidden, false, 'the admin is not thrown back to the sign-in card');
  assert.equal(nodes.get('#authCard').hidden, true);
  assert.equal(nodes.get('#ordersError').hidden, false);
  assert.match(nodes.get('#ordersError').textContent, /تعذر تحميل الطلبات/);
  assert.equal(nodes.get('#loadMoreOrders').disabled, false);
});

test('orders dashboard: a wrong account at sign-in sees the sign-in card with an Arabic message', async () => {
  const { context, nodes, store } = load(['portal.js', 'dashboard.js'], DASHBOARD_IDS, async () => json(403, { ok: false, error: 'forbidden' }));
  signIn(store);
  nodes.get('#dashboard').hidden = true;
  nodes.get('#authCard').hidden = true;
  await vm.runInContext('loadOrders', context)();
  assert.equal(nodes.get('#authCard').hidden, false);
  assert.equal(nodes.get('#dashboard').hidden, true);
  assert.match(nodes.get('#authError').textContent, /غير مصرح/);
});

test('orders dashboard: failing store settings do not lock the admin out of the orders', async () => {
  const { context, nodes, store } = load(['portal.js', 'dashboard.js'], DASHBOARD_IDS, async url => (String(url).includes('/api/store-integrations')
    ? json(502, { ok: false, error: 'role_check_failed' })
    : json(200, { ok: true, orders: [], pagination: { hasMore: false } })));
  signIn(store);
  nodes.get('#dashboard').hidden = true;
  await vm.runInContext('loadOrders', context)();
  assert.equal(nodes.get('#dashboard').hidden, false);
  assert.equal(nodes.get('#authCard').hidden, true);
  assert.equal(nodes.get('#settingsNotice').hidden, false);
  assert.match(nodes.get('#settingsNotice').className, /error/);
  assert.match(nodes.get('#settingsNotice').textContent, /تعذر التحقق/);
});

test('customers dashboard: a wrong account keeps the sign-in box with an Arabic message instead of an empty dashboard', async () => {
  const { context, nodes, store } = load(['portal.js', 'customers-dashboard.js'], CUSTOMERS_IDS, async () => json(403, { ok: false, error: 'forbidden' }));
  signIn(store);
  nodes.get('#login').hidden = false;
  nodes.get('#app').hidden = true;
  nodes.get('#logout').hidden = true;
  nodes.get('#platformError').hidden = true;
  await vm.runInContext('loadCustomersDashboard', context)(false).catch(vm.runInContext('reportError', context));
  assert.equal(nodes.get('#login').hidden, false);
  assert.equal(nodes.get('#app').hidden, true);
  assert.equal(nodes.get('#logout').hidden, true);
  assert.match(nodes.get('#message').textContent, /غير مصرح/);
  assert.equal(nodes.get('#platformError').hidden, true);
});

test('customers dashboard: it appears only after the data arrives, and an error after that goes to the page error box', async () => {
  const payload = { ok: true, counts: { registered: 1, visitors: 0 },
    registeredCustomers: [{ id: '11111111-1111-4111-8111-111111111111', full_name: 'عميل تجريبي', phone: '0000', created_at: '2026-01-01T00:00:00Z', cartItems: 0, cartUnits: 0 }],
    guestVisitors: [], pagination: { registered: { offset: 0, limit: 50, total: 1, hasMore: false }, visitors: { offset: 0, limit: 50, total: 0, hasMore: false } } };
  const { context, nodes, store } = load(['portal.js', 'customers-dashboard.js'], CUSTOMERS_IDS, async () => json(200, payload));
  signIn(store);
  nodes.get('#login').hidden = false;
  nodes.get('#app').hidden = true;
  nodes.get('#logout').hidden = true;
  nodes.get('#message').textContent = 'old message';
  await vm.runInContext('loadCustomersDashboard', context)(false);
  assert.equal(nodes.get('#login').hidden, true);
  assert.equal(nodes.get('#app').hidden, false);
  assert.equal(nodes.get('#logout').hidden, false);
  assert.equal(nodes.get('#message').textContent, '');
  assert.match(nodes.get('#registeredCustomers').innerHTML, /عميل تجريبي/);

  vm.runInContext('reportError', context)(new Error('customer_data_unavailable'));
  assert.equal(nodes.get('#platformError').hidden, false);
  assert.match(nodes.get('#platformError').textContent, /تعذر تحميل بيانات العملاء/);
});

test('the pages carry the elements the error handling writes to', () => {
  const account = read('account.html');
  assert.match(account, /<section id="app"[^>]*hidden>\s*<p id="appMessage"[^>]*role="alert"[^>]*hidden>/, 'the orders page has its own error line inside the part that stays visible');
  assert.match(account, /<p id="message" role="alert">/);
  assert.match(read('dashboard.html'), /<section id="ordersPanel">\s*<p id="ordersError"[^>]*role="alert"[^>]*hidden>/);
});
