const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'platform-dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'platform-dashboard.html'), 'utf8');

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
    '#customerTabs', '#platformFilters', '#refreshCustomers', '#guestAnalyticsPeriod',
    '#loginForm', '#login', '#app', '#logout', '#stats', '#platformError',
    '#registeredTab', '#visitorsTab', '#registeredCustomers', '#guestCustomers',
    '#guestAnalyticsRange', '#guestAnalyticsStats', '#guestTopProducts',
    '#guestBasketProducts', '#guestAnalyticsError', '#orders', '#message',
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

test('platform dashboard markup provides its current form, customer-tab, and guest-analytics targets', () => {
  assert.match(html, /<form id="platformFilters"[^>]*>/);
  assert.match(html, /<button[^>]*type="submit">تطبيق<\/button>/);
  assert.match(html, /id="registeredCustomers"/);
  assert.match(html, /id="guestCustomers"/);
  assert.match(html, /id="guestTopProducts"/);
  assert.match(html, /id="guestBasketProducts"/);
  assert.doesNotMatch(html, /id="registeredAnalyticsPeriod"|id="registeredPanel"|id="guestPanel"/);
  assert.doesNotMatch(source, /registeredAnalyticsPeriod|registeredPanel|guestPanel/);
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

test('customer tabs toggle the list elements that exist in the current HTML', () => {
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
