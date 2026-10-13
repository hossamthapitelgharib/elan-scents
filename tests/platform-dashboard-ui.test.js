const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'platform-dashboard.html'), 'utf8');
const customerHtml = fs.readFileSync(path.join(root, 'customers-dashboard.html'), 'utf8');

function makeNode() {
  return {
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    attributes: {},
    listeners: {},
    controls: [],
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return this.controls; },
  };
}

function loadDashboard() {
  const selectors = [
    '#customerTabs', '#platformFilters', '#refreshCustomers', '#guestAnalyticsPeriod', '#registeredAnalyticsPeriod',
    '#loginForm', '#login', '#app', '#logout', '#stats', '#platformError',
    '#registeredTab', '#visitorsTab', '#registeredCustomers', '#guestCustomers',
    '#registeredAnalytics',
    '#guestAnalyticsRange', '#guestAnalyticsStats', '#guestTopProducts',
    '#guestBasketProducts', '#guestAnalyticsError', '#registeredAnalyticsRange', '#registeredAnalyticsStats',
    '#registeredTopProducts', '#registeredBasketProducts', '#registeredAnalyticsError', '#guestAnalytics', '#orders', '#message',
  ];
  const nodes = new Map(selectors.map(selector => [selector, makeNode()]));
  nodes.get('#guestCustomers').hidden = true;
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
  vm.runInContext(source, context, { filename: 'platform-dashboard.js' });
  return { context, nodes, documentListeners };
}

test('platform dashboard shows links and summaries while the separate customers page owns customer records', () => {
  assert.match(html, /<form id="platformFilters"[^>]*>/);
  assert.match(html, /<button[^>]*type="submit">تطبيق<\/button>/);
  assert.match(html, /customers-dashboard\.html/);
  assert.match(html, /id="platformStoreStats"/);
  assert.match(html, /href="\/stores-dashboard\.html"/);
  assert.doesNotMatch(html, /id="registeredCustomers"|id="guestCustomers"|id="guestTopProducts"/);
  assert.match(customerHtml, /id="registeredCustomers"/);
  assert.match(customerHtml, /id="guestCustomers"/);
  assert.match(customerHtml, /id="guestTopProducts"/);
  assert.match(customerHtml, /id="guestBasketProducts"/);
  assert.match(customerHtml, /id="registeredAnalyticsPeriod"/);
  assert.match(customerHtml, /id="registeredTopProducts"/);
  assert.match(customerHtml, /id="registeredBasketProducts"/);
});

test('platform filters serialize named values and omit empty or unchecked fields', () => {
  const { context, nodes } = loadDashboard();
  nodes.get('#platformFilters').controls = [
    { name: 'tracking', type: 'text', value: '  TRK-45  ' },
    { name: 'status', type: 'select-one', value: 'processing' },
    { name: 'attention', type: 'checkbox', value: '1', checked: false },
    { name: 'unused', type: 'text', value: '   ' },
  ];
  assert.equal(vm.runInContext('filterQuery()', context), '?tracking=TRK-45&status=processing');
  nodes.get('#platformFilters').controls[2].checked = true;
  assert.equal(vm.runInContext('filterQuery()', context), '?tracking=TRK-45&status=processing&attention=1');
});

test('customer tabs toggle visitor and registered-customer lists', () => {
  const { context, nodes } = loadDashboard();
  const tabHandler = nodes.get('#customerTabs').listeners.click;
  const visitorButton = { dataset: { customerTab: 'visitors' } };
  tabHandler({ target: { closest: () => visitorButton } });
  assert.equal(nodes.get('#registeredCustomers').hidden, true);
  assert.equal(nodes.get('#guestCustomers').hidden, false);
  assert.equal(nodes.get('#registeredTab').attributes['aria-selected'], 'false');
  assert.equal(nodes.get('#visitorsTab').attributes['aria-selected'], 'true');

  const registeredButton = { dataset: { customerTab: 'registered' } };
  tabHandler({ target: { closest: () => registeredButton } });
  assert.equal(nodes.get('#registeredCustomers').hidden, false);
  assert.equal(nodes.get('#guestCustomers').hidden, true);
  assert.equal(nodes.get('#registeredTab').attributes['aria-selected'], 'true');
  assert.equal(nodes.get('#visitorsTab').attributes['aria-selected'], 'false');
  assert.equal(nodes.get('#registeredAnalytics').hidden, false);
  assert.equal(nodes.get('#guestAnalytics').hidden, true);
  assert.ok(context);
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
