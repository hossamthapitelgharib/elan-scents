const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const rankings = require(path.join(root, 'api', 'customer-product-rankings'));
const analyticsApi = require(path.join(root, 'api', 'guest-analytics'));
const customerSource = fs.readFileSync(path.join(root, 'customers-dashboard.js'), 'utf8');
const customerHtml = fs.readFileSync(path.join(root, 'customers-dashboard.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261017062830_customer_activity_totals_and_guest_cleanup_on_claim.sql'), 'utf8');

const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
function adminFetch(rpcName, rpcResult, calls) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (url.includes('/profiles?')) return response([{ id: adminId, role: 'platform_admin' }]);
    if (url.endsWith(`/rpc/${rpcName}`)) { calls.push(JSON.parse(options.body)); return response(rpcResult); }
    throw new Error(`unexpected ${url}`);
  };
}

test('ranking and summary APIs accept the total (all) scope and pass it to the database unchanged', async () => {
  const rankingCalls = [];
  adminFetch('customer_product_ranking', { records: [{ product: { id: 'p1', name: 'Rose' }, operations: 3, people: 2 }], total: 1, hasMore: false }, rankingCalls);
  const ranked = recorder();
  await rankings({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { actor: 'all', period: 'week', eventType: 'cart_remove' } }, ranked);
  assert.equal(ranked.out.status, 200);
  assert.equal(ranked.out.body.actorType, 'all');
  assert.deepEqual(rankingCalls[0], { p_actor_type: 'all', p_period: 'week', p_event_type: 'cart_remove', p_limit: 20, p_offset: 0 });

  const summaryCalls = [];
  adminFetch('customer_activity_summary', { actorType: 'all', people: 5, topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [] }, summaryCalls);
  const summary = recorder();
  await analyticsApi({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query: { actor: 'all', period: 'month' } }, summary);
  assert.equal(summary.out.status, 200);
  assert.deepEqual(summaryCalls[0], { p_actor_type: 'all', p_period: 'month' });
});

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', dataset: {}, attributes: {}, listeners: {}, controls: [],
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return this.controls; },
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
  nodes.get('#allAnalytics').hidden = true;
  nodes.get('#registeredBestSellersPeriod').value = 'all';
  const document = {
    querySelector(selector) { return nodes.get(selector) || null; },
    getElementById(id) { return nodes.get(`#${id}`) || null; },
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    Portal: { session: () => false, auth: () => ({}), login: async () => {} },
    fetch: async () => { throw new Error('Unexpected fetch in UI unit test'); },
    URLSearchParams,
    console,
  });
  vm.runInContext(customerSource, context, { filename: 'customers-dashboard.js' });
  return { context, nodes };
}

test('the total tab shows only the total analytics and hides both customer lists', () => {
  const { nodes } = loadDashboard();
  const tabHandler = nodes.get('#customerTabs').listeners.click;
  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'all' } }) } });
  assert.equal(nodes.get('#allAnalytics').hidden, false);
  assert.equal(nodes.get('#registeredAnalytics').hidden, true);
  assert.equal(nodes.get('#guestAnalytics').hidden, true);
  assert.equal(nodes.get('#registeredCustomers').hidden, true);
  assert.equal(nodes.get('#guestCustomers').hidden, true);
  assert.equal(nodes.get('#registeredPagination').hidden, true);
  assert.equal(nodes.get('#visitorPagination').hidden, true);
  assert.equal(nodes.get('#allTab').attributes['aria-selected'], 'true');
  assert.equal(nodes.get('#registeredTab').attributes['aria-selected'], 'false');
  assert.equal(nodes.get('#visitorsTab').attributes['aria-selected'], 'false');

  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'visitors' } }) } });
  assert.equal(nodes.get('#allAnalytics').hidden, true);
  assert.equal(nodes.get('#guestAnalytics').hidden, false);
  assert.equal(nodes.get('#allTab').attributes['aria-selected'], 'false');
});

test('the total tab loads its numbers and the four rankings with the all scope, once, and reuses them', async () => {
  const { context, nodes } = loadDashboard();
  context.Portal.session = () => true;
  const requests = [];
  context.fetch = async input => {
    const url = new URL(String(input), 'https://elan.test');
    requests.push(url);
    if (url.pathname === '/api/guest-analytics') return { ok: true, json: async () => ({ analytics: {
      period: url.searchParams.get('period'), startDate: '2026-10-17', endDate: '2026-10-17', people: 3,
      activeSessions: 0, visitCount: 4, activeSeconds: 60, productViews: 6, productSearches: 2, cartAdds: 1, cartRemoves: 1,
      topViewed: [], topSearched: [], topCartAdded: [], topCartRemoved: [],
    } }) };
    if (url.pathname === '/api/customer-product-rankings') {
      const rows = url.searchParams.get('eventType') === 'view' ? [{ product: { name: 'Rose <b>' }, operations: 5, people: 3 }] : [];
      return { ok: true, json: async () => ({ records: rows, total: rows.length, hasMore: false }) };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const tabHandler = nodes.get('#customerTabs').listeners.click;
  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'all' } }) } });
  await flush(); await flush();
  const analytics = requests.filter(url => url.pathname === '/api/guest-analytics');
  const ranks = requests.filter(url => url.pathname === '/api/customer-product-rankings');
  assert.equal(analytics.length, 1);
  assert.equal(analytics[0].searchParams.get('actor'), 'all');
  assert.equal(ranks.length, 4);
  assert.ok(ranks.every(url => url.searchParams.get('actor') === 'all'));
  assert.match(nodes.get('#allAnalyticsStats').innerHTML, /زوار وعملاء لديهم نشاط/);
  assert.match(nodes.get('#allTopProducts').innerHTML, /Rose &lt;b&gt;/);
  assert.match(nodes.get('#allTopProducts').innerHTML, /عدد الأشخاص/);
  assert.doesNotMatch(nodes.get('#allTopProducts').innerHTML, /<b>Rose/);

  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'visitors' } }) } });
  tabHandler({ target: { closest: () => ({ dataset: { customerTab: 'all' } }) } });
  await flush();
  assert.equal(requests.filter(url => url.pathname === '/api/guest-analytics' && url.searchParams.get('actor') === 'all').length, 1);
});

test('the dashboard page has the total tab and its own analytics section', () => {
  assert.match(customerHtml, /id="allTab"[^>]*data-customer-tab="all"/);
  for (const id of ['allAnalytics', 'allAnalyticsPeriod', 'allAnalyticsRange', 'allAnalyticsStats', 'allTopProducts', 'allBasketProducts', 'allAnalyticsError']) {
    assert.match(customerHtml, new RegExp(`id="${id}"`));
  }
});

test('the migration deletes every trace of a guest when it registers and totals guests + customers', () => {
  assert.match(migration, /delete from public\.guest_fingerprints where analytics_hash = p_analytics_hash;/);
  assert.match(migration, /delete from public\.guest_identity_links where hash_a = p_analytics_hash or hash_b = p_analytics_hash;/);
  assert.match(migration, /insert into public\.guest_conversions \(visitor_hash, user_id, first_seen_date, converted_on\)\s+values \(\s+encode\(sha256\(/);
  assert.match(migration, /p_actor_type not in \('guest','customer','all'\)/);
  assert.match(migration, /delete from public\.guest_fingerprints where analytics_hash = p_from_analytics;/);
});
