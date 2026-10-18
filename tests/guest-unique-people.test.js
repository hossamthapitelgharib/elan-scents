const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const handler = require(path.join(root, 'api', 'guest-analytics'));
const customerSource = fs.readFileSync(path.join(root, 'customers-dashboard.js'), 'utf8');

const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; } }; }
function mockAdmin({ peopleStatus = 200, peopleBody = { period: 'week', browsers: 5, people: 3 } } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = { summary: [], people: [] };
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (value.includes('/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (value.endsWith('/rpc/customer_activity_summary')) { calls.summary.push(JSON.parse(options.body)); return response({ people: 7, topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [] }); }
    if (value.endsWith('/rpc/guest_unique_people')) { calls.people.push(JSON.parse(options.body)); return response(peopleBody, peopleStatus); }
    throw new Error(`unexpected ${value}`);
  };
  return calls;
}
const ask = query => ({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query });

test('the guest summary carries the estimate of people after similar browsers are linked', async () => {
  const calls = mockAdmin();
  const res = recorder();
  await handler(ask({ actor: 'guest', period: 'week' }), res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body.analytics.uniquePeople, { browsers: 5, people: 3 });
  assert.equal(res.out.body.analytics.people, 7);
  assert.deepEqual(calls.people, [{ p_period: 'week' }]);
});

test('registered and total summaries do not ask for the guest people estimate', async () => {
  const calls = mockAdmin();
  for (const actor of ['customer', 'all']) {
    const res = recorder();
    await handler(ask({ actor, period: 'today' }), res);
    assert.equal(res.out.status, 200);
    assert.equal(res.out.body.analytics.uniquePeople, undefined);
  }
  assert.equal(calls.people.length, 0);
});

test('a failing estimate never hides the rest of the guest numbers', async () => {
  mockAdmin({ peopleStatus: 500, peopleBody: { error: 'boom' } });
  const res = recorder();
  await handler(ask({ actor: 'guest', period: 'today' }), res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.analytics.people, 7);
  assert.equal(res.out.body.analytics.uniquePeople, undefined);
});

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', dataset: {}, attributes: {}, listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
  };
}
function loadDashboard() {
  const selectors = [
    '#customerTabs', '#refreshCustomers', '#guestAnalyticsPeriod', '#registeredAnalyticsPeriod', '#allAnalyticsPeriod',
    '#loginForm', '#login', '#app', '#logout', '#stats', '#platformError', '#message',
    '#registeredTab', '#visitorsTab', '#allTab', '#registeredCustomers', '#guestCustomers', '#registeredCount', '#visitorCount',
    '#registeredPagination', '#visitorPagination', '#registeredAnalytics', '#guestAnalytics', '#allAnalytics',
    '#registeredBestSellersPeriod', '#registeredBestSellersError', '#registeredBestSellersAudit', '#registeredBestSellersTable',
    '#guestAnalyticsRange', '#guestAnalyticsStats', '#guestTopProducts', '#guestBasketProducts', '#guestAnalyticsError',
    '#registeredAnalyticsRange', '#registeredAnalyticsStats', '#registeredTopProducts', '#registeredBasketProducts', '#registeredAnalyticsError',
    '#allAnalyticsRange', '#allAnalyticsStats', '#allTopProducts', '#allBasketProducts', '#allAnalyticsError',
  ];
  const nodes = new Map(selectors.map(selector => [selector, makeNode()]));
  nodes.get('#guestCustomers').hidden = true;
  const document = { querySelector(selector) { return nodes.get(selector) || null; }, getElementById(id) { return nodes.get(`#${id}`) || null; }, addEventListener() {} };
  const context = vm.createContext({ document, Portal: { session: () => true, auth: () => ({}), login: async () => {} }, fetch: async () => { throw new Error('unexpected'); }, URLSearchParams, console });
  vm.runInContext(customerSource, context, { filename: 'customers-dashboard.js' });
  return { context, nodes };
}

test('the visitors tab shows the estimate of people next to the browser count, and the other tabs do not', async () => {
  const { context, nodes } = loadDashboard();
  context.fetch = async input => {
    const url = new URL(String(input), 'https://elan.test');
    if (url.pathname === '/api/guest-analytics') {
      const actor = url.searchParams.get('actor');
      const analytics = { period: 'today', startDate: '2026-10-18', endDate: '2026-10-18', people: 5, activeSessions: 0, visitCount: 6, activeSeconds: 30, productViews: 1, productSearches: 0, cartAdds: 0, cartRemoves: 0, topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [] };
      if (actor === 'guest') analytics.uniquePeople = { browsers: 5, people: 3 };
      return { ok: true, json: async () => ({ analytics }) };
    }
    return { ok: true, json: async () => ({ records: [], total: 0, hasMore: false }) };
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const click = tab => nodes.get('#customerTabs').listeners.click({ target: { closest: () => ({ dataset: { customerTab: tab } }) } });
  click('visitors');
  await flush();
  assert.match(nodes.get('#guestAnalyticsStats').innerHTML, /تقدير الأشخاص بعد ربط المتصفحات المتشابهة/);
  assert.match(nodes.get('#guestAnalyticsStats').innerHTML, /<b>٣<\/b>/);
  click('all');
  await flush();
  assert.doesNotMatch(nodes.get('#allAnalyticsStats').innerHTML, /تقدير الأشخاص/);
});
