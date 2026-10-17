const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');
const customerSource = fs.readFileSync(path.join(root, 'customers-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'platform-dashboard.html'), 'utf8');
const customerHtml = fs.readFileSync(path.join(root, 'customers-dashboard.html'), 'utf8');
const orderSummaryApi = fs.readFileSync(path.join(root, 'api', 'platform-order-summary.js'), 'utf8');

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', dataset: {}, attributes: {}, listeners: {}, controls: [],
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return this.controls; },
  };
}

function loadDashboard(dashboard = 'customers') {
  const selectors = [
    '#customerTabs', '#refreshCustomers', '#guestAnalyticsPeriod', '#registeredAnalyticsPeriod',
    '#loginForm', '#login', '#app', '#logout', '#stats', '#platformError', '#platformStoreError', '#platformStoreStats',
    '#registeredTab', '#visitorsTab', '#registeredCustomers', '#guestCustomers', '#registeredCount', '#visitorCount',
    '#registeredPagination', '#visitorPagination', '#registeredAnalytics',
    '#registeredBestSellersPeriod', '#registeredBestSellersError', '#registeredBestSellersAudit', '#registeredBestSellersTable',
    '#guestAnalyticsRange', '#guestAnalyticsStats', '#guestTopProducts', '#guestBasketProducts', '#guestAnalyticsError',
    '#registeredAnalyticsRange', '#registeredAnalyticsStats', '#registeredTopProducts', '#registeredBasketProducts', '#registeredAnalyticsError', '#guestAnalytics', '#message',
  ];
  const nodes = new Map(selectors.map(selector => [selector, makeNode()]));
  nodes.get('#guestCustomers').hidden = true;
  nodes.get('#registeredBestSellersPeriod').value = 'all';
  const documentListeners = {};
  const document = {
    querySelector(selector) { return nodes.get(selector) || null; },
    getElementById(id) { return nodes.get(`#${id}`) || null; },
    addEventListener(type, callback) { documentListeners[type] = callback; },
  };
  const context = vm.createContext({
    document,
    Portal: { session: () => false, auth: () => ({}), login: async () => {} },
    fetch: async () => { throw new Error('Unexpected fetch in UI unit test'); },
    URLSearchParams,
    console,
  });
  vm.runInContext(dashboard === 'platform' ? source : customerSource, context, { filename: dashboard === 'platform' ? 'platform-dashboard.js' : 'customers-dashboard.js' });
  return { context, nodes, documentListeners };
}

test('platform dashboard links to detailed admin tools and contains only aggregate order/customer/store sections', () => {
  assert.doesNotMatch(html, /platformFilters|id="orders"|بيانات العميل/);
  assert.match(html, /href="\/dashboard\.html"/);
  assert.match(html, /customers-dashboard\.html/);
  assert.match(html, /id="platformStoreStats"/);
  assert.match(html, /href="\/stores-dashboard\.html"/);
  assert.match(html, /src="\/platform-dashboard\.js\?v=/);
  assert.doesNotMatch(html, /id="registeredCustomers"|id="guestCustomers"|id="guestTopProducts"/);
  assert.doesNotMatch(source, /customer_(?:name|phone|address|email)|dashboard-orders/);
  assert.match(source, /platform-order-summary/);
  assert.doesNotMatch(orderSummaryApi, /customer_(?:name|phone|address|email)|store_order_request_items|initial_payload|customer_address/);
  assert.match(customerHtml, /id="registeredCustomers"/);
  assert.match(customerHtml, /id="guestCustomers"/);
  assert.match(customerHtml, /id="guestTopProducts"/);
  assert.match(customerHtml, /id="guestBasketProducts"/);
  assert.match(customerHtml, /id="registeredAnalyticsPeriod"/);
  assert.match(customerHtml, /id="registeredTopProducts"/);
  assert.match(customerHtml, /id="registeredBasketProducts"/);
  assert.match(customerHtml, /id="registeredBestSellersTable"/);
  assert.match(customerHtml, /id="registeredBestSellersAudit"/);
  assert.match(customerHtml, /src="\/customers-dashboard\.js\?v=/);
  assert.doesNotMatch(customerHtml, /src="\/platform-dashboard\.js\?v=/);
  assert.doesNotMatch(source, /renderCustomers|loadCustomersDashboard|customerOffsets|customer_product_events/);
  assert.match(customerSource, /loadCustomersDashboard/);
  assert.match(customerHtml, /الأكثر إضافةً أو حذفًا من سلال الزوار/);
  assert.match(customerHtml, /حذفها\/تقليلها/);
  assert.doesNotMatch(customerHtml, /المنتجات الموجودة في سلال الزوار الآن/);
});

test('platform dashboard requests aggregate-only counts and does not render customer order details', async () => {
  const { context, nodes } = loadDashboard('platform');
  context.Portal.session = () => true;
  const requests = [];
  context.fetch = async url => {
    requests.push(String(url));
    if (String(url).includes('platform-order-summary')) return { ok: true, json: async () => ({ counts: { orders: 70, completed: 18, open: 47, needsReview: 5 } }) };
    if (String(url).includes('platform-customer-summary')) return { ok: true, json: async () => ({ counts: { registered: 12, visitors: 25 } }) };
    if (String(url).includes('platform-stores')) return { ok: true, json: async () => ({ stores: [{ status: 'active', summary: { available_product_count: 80, active_offer_count: 16, open_order_count: 7, review_order_count: 2 } }] }) };
    throw new Error(`unexpected request: ${url}`);
  };
  await context.loadPlatform();
  assert.ok(requests.some(url => url.includes('/api/platform-order-summary')));
  assert.ok(!requests.some(url => url.includes('/api/dashboard-orders')));
  assert.match(nodes.get('#stats').innerHTML, /طلبات المتاجر/);
  assert.match(nodes.get('#stats').innerHTML, /٧٠/);
  assert.match(nodes.get('#stats').innerHTML, /تحتاج مراجعة/);
  assert.doesNotMatch(nodes.get('#stats').innerHTML, /محمول|عميل خاص|0100/);
});

test('customer tabs toggle visitor and registered-customer lists', () => {
  const { context, nodes } = loadDashboard();
  const tabHandler = nodes.get('#customerTabs').listeners.click;
  const visitorButton = { dataset: { customerTab: 'visitors' } };
  tabHandler({ target: { closest: () => visitorButton } });
  assert.equal(nodes.get('#registeredCustomers').hidden, true);
  assert.equal(nodes.get('#guestCustomers').hidden, false);
  assert.equal(nodes.get('#registeredPagination').hidden, true);
  assert.equal(nodes.get('#visitorPagination').hidden, false);
  assert.equal(nodes.get('#registeredTab').attributes['aria-selected'], 'false');
  assert.equal(nodes.get('#visitorsTab').attributes['aria-selected'], 'true');

  const registeredButton = { dataset: { customerTab: 'registered' } };
  tabHandler({ target: { closest: () => registeredButton } });
  assert.equal(nodes.get('#registeredCustomers').hidden, false);
  assert.equal(nodes.get('#guestCustomers').hidden, true);
  assert.equal(nodes.get('#registeredPagination').hidden, false);
  assert.equal(nodes.get('#visitorPagination').hidden, true);
  assert.equal(nodes.get('#registeredTab').attributes['aria-selected'], 'true');
  assert.equal(nodes.get('#visitorsTab').attributes['aria-selected'], 'false');
  assert.equal(nodes.get('#registeredAnalytics').hidden, false);
  assert.equal(nodes.get('#guestAnalytics').hidden, true);
  assert.ok(context);
});

test('customer dashboard loads insights lazily for the active tab and reuses the cached tab results', async () => {
  const { context, nodes } = loadDashboard();
  context.Portal.session = () => true;
  const requests = [];
  context.fetch = async input => {
    const url = new URL(String(input), 'https://elan.test');
    requests.push(url);
    if (url.pathname === '/api/platform-customers') return { ok: true, json: async () => ({
      registeredCustomers: [], guestVisitors: [], counts: { registered: 0, visitors: 0 },
      pagination: { registered: { offset: 0, limit: 50, total: 0 }, visitors: { offset: 0, limit: 50, total: 0 } }
    }) };
    if (url.pathname === '/api/guest-analytics') return { ok: true, json: async () => ({ analytics: {
      period: url.searchParams.get('period'), startDate: '2026-10-13', endDate: '2026-10-13', people: 0,
      activeSessions: 0, visitCount: 0, activeSeconds: 0, productViews: 0, productSearches: 0, cartAdds: 0, cartRemoves: 0,
      topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: []
    } }) };
    if (url.pathname === '/api/customer-product-rankings') return { ok: true, json: async () => ({ records: [], total: 0, hasMore: false }) };
    if (url.pathname === '/api/customer-best-sellers') return { ok: true, json: async () => ({ records: [], total: 0, hasMore: false, audit: { eligiblePurchases: 0, eligibleUnits: 0, rankedUnits: 0, unlinkedEligibleUnits: 0 } }) };
    throw new Error(`unexpected request: ${url}`);
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await context.loadCustomersDashboard();
  await flush();
  assert.equal(requests.filter(url => url.pathname === '/api/guest-analytics').length, 1);
  assert.equal(requests.find(url => url.pathname === '/api/guest-analytics').searchParams.get('actor'), 'customer');
  assert.equal(requests.filter(url => url.pathname === '/api/customer-product-rankings').length, 4);
  assert.equal(requests.filter(url => url.pathname === '/api/customer-best-sellers').length, 1);

  const tabHandler = nodes.get('#customerTabs').listeners.click;
  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'visitors' } }) } });
  await flush();
  assert.equal(requests.filter(url => url.pathname === '/api/guest-analytics').length, 2);
  assert.equal(requests.filter(url => url.pathname === '/api/customer-product-rankings').length, 8);
  assert.equal(requests.filter(url => url.pathname === '/api/guest-analytics' && url.searchParams.get('actor') === 'guest').length, 1);
  assert.equal(requests.filter(url => url.pathname === '/api/customer-best-sellers').length, 1);

  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'registered' } }) } });
  await flush();
  assert.equal(requests.filter(url => url.pathname === '/api/guest-analytics').length, 2);
  assert.equal(requests.filter(url => url.pathname === '/api/customer-best-sellers').length, 1);
});

test('customer list paging renders exact totals and enables only valid previous/next controls', () => {
  const { context, nodes } = loadDashboard();
  context.customerFixture = {
    registeredCustomers: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, full_name: `عميل ${i}`, cartItems: 0, cartUnits: 0 })),
    guestVisitors: [], counts: { registered: 501, visitors: 0 },
    pagination: {
      registered: { offset: 50, limit: 50, total: 501, hasMore: true },
      visitors: { offset: 0, limit: 50, total: 0, hasMore: false },
    },
  };
  vm.runInContext('renderCustomers(customerFixture)', context);
  assert.equal(nodes.get('#registeredCount').textContent, '501');
  assert.match(nodes.get('#registeredPagination').innerHTML, /الصفحة [٠-٩]+ من [٠-٩]+/);
  assert.match(nodes.get('#registeredPagination').innerHTML, /data-offset="0"/);
  assert.match(nodes.get('#registeredPagination').innerHTML, /data-offset="100"/);
  assert.match(nodes.get('#visitorPagination').innerHTML, /لا توجد صفحات/);
});

test('customer search history escapes the query and renders complete product snapshots', () => {
  const { context } = loadDashboard();
  context.searchFixture = [{
    searchText: '<script>alert(1)</script>', occurredAt: '2026-10-15T03:00:00Z', resultCount: 1,
    results: [{ product: { name: 'Rose', brand_name: 'Brand', selectedSize: { size_label: '50ml' }, selectedOffer: { storeName: 'Store', price: 80, currency: 'EGP' } } }]
  }];
  const html = vm.runInContext('searchRows(searchFixture)', context);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Rose/);
  assert.match(html, /50ml/);
  assert.match(html, /Store/);
  assert.match(html, /80 EGP/);
});

test('guest analytics render the four available rankings into the current two-panel layout safely', () => {
  const { context, nodes } = loadDashboard();
  context.analyticsFixture = {
    period: 'week', startDate: '2026-10-06', endDate: '2026-10-12', people: 4,
    activeSessions: 1, visitCount: 7, activeSeconds: 125, productViews: 9,
    productSearches: 3, cartAdds: 2, cartRemoves: 1,
    topViewed: [{ product: { name: 'Rose <script>', brand_name: 'Élan' }, operations: 5, people: 3 }],
    topSearched: [{ product: { name: 'Musk' }, operations: 2, people: 1 }],
    topCartAdded: [{ product: { name: 'Amber' }, operations: 2, people: 2 }],
    topCartRemoved: [{ product: { name: 'Cedar' }, operations: 1, people: 1 }],
  };
  vm.runInContext("renderAnalytics('guest', analyticsFixture)", context);
  assert.match(nodes.get('#guestAnalyticsRange').textContent, /آخر 7 أيام/);
  assert.match(nodes.get('#guestAnalyticsStats').innerHTML, /زوار لديهم نشاط/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /الأكثر مشاهدة/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /الأكثر ظهورًا في نتائج البحث/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /Rose &lt;script&gt;/);
  assert.doesNotMatch(nodes.get('#guestTopProducts').innerHTML, /<script>/);
  assert.match(nodes.get('#guestBasketProducts').innerHTML, /الأكثر إضافةً إلى السلة/);
  assert.match(nodes.get('#guestBasketProducts').innerHTML, /الأكثر حذفًا أو تقليلًا من السلة/);
  assert.match(nodes.get('#guestBasketProducts').innerHTML, /Amber/);
  assert.match(nodes.get('#guestBasketProducts').innerHTML, /Cedar/);
});

test('registered customer analytics render all four product rankings safely', () => {
  const { context, nodes } = loadDashboard();
  context.analyticsFixture = {
    period: 'month', startDate: '2026-09-14', endDate: '2026-10-13', people: 12,
    activeSessions: 2, visitCount: 20, activeSeconds: 950, productViews: 31,
    productSearches: 8, cartAdds: 5, cartRemoves: 3,
    topViewed: [{ product: { name: 'Rose' }, operations: 10, people: 6 }],
    topSearched: [{ product: { name: 'Musk' }, operations: 4, people: 3 }],
    topCartAdded: [{ product: { name: 'Amber' }, operations: 5, people: 4 }],
    topCartRemoved: [{ product: { name: 'Cedar' }, operations: 3, people: 2 }],
  };
  vm.runInContext("renderAnalytics('customer', analyticsFixture)", context);
  assert.match(nodes.get('#registeredAnalyticsRange').textContent, /آخر 30 يومًا/);
  assert.match(nodes.get('#registeredAnalyticsStats').innerHTML, /عملاء مسجلون لديهم نشاط/);
  assert.match(nodes.get('#registeredTopProducts').innerHTML, /Rose/);
  assert.match(nodes.get('#registeredTopProducts').innerHTML, /Musk/);
  assert.match(nodes.get('#registeredBasketProducts').innerHTML, /Amber/);
  assert.match(nodes.get('#registeredBasketProducts').innerHTML, /Cedar/);
});

test('customer analytics fetch and append additional pages for each ranked product list', async () => {
  const { context, nodes } = loadDashboard();
  context.Portal.session = () => true;
  nodes.get('#guestAnalyticsPeriod').value = 'week';
  const requests = [];
  context.fetch = async url => {
    requests.push(String(url));
    const parsed = new URL(String(url), 'https://test.local');
    if (parsed.pathname === '/api/guest-analytics') return { ok: true, json: async () => ({ analytics: {
      period: 'week', startDate: '2026-10-06', endDate: '2026-10-12', people: 2, activeSessions: 0, visitCount: 2, activeSeconds: 90,
      productViews: 3, productSearches: 1, cartAdds: 0, cartRemoves: 0,
      topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [],
    } }) };
    if (parsed.pathname === '/api/customer-product-rankings') {
      const eventType = parsed.searchParams.get('eventType'), offset = Number(parsed.searchParams.get('offset'));
      const rows = eventType === 'view' ? (offset === 0
        ? [{ product: { id: 'p1', name: 'Rose' }, operations: 2, people: 2 }]
        : [{ product: { id: 'p2', name: 'Musk' }, operations: 1, people: 1 }]) : [];
      return { ok: true, json: async () => ({ records: rows, total: eventType === 'view' ? 2 : 0, hasMore: eventType === 'view' && offset === 0 }) };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await context.loadAnalytics('guest');
  assert.equal(requests.filter(url => url.includes('/api/customer-product-rankings')).length, 4);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /Rose/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /عرض ١ من ٢/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /data-rank-key="topViewed"/);

  const button = { dataset: { rankActor: 'guest', rankKey: 'topViewed' }, disabled: false };
  await context.loadMoreProductRanking(button);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /Rose/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /Musk/);
  assert.match(nodes.get('#guestTopProducts').innerHTML, /عرض ٢ من ٢/);
  assert.doesNotMatch(nodes.get('#guestTopProducts').innerHTML, /data-rank-more/);
});
