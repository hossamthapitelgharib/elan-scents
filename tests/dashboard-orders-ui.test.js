const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const portalSource = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');

const IDS = ['orders', 'stats', 'searchFilter', 'statusFilter', 'matchFilter', 'attentionFilter', 'loadMoreOrders', 'authCard', 'dashboard', 'logout', 'authError', 'ordersError',
  'lastUpdated', 'authForm', 'refreshBtn', 'saveSettingsBtn', 'storeSettings', 'settingsNotice'];
function makeNode() {
  return { hidden: false, disabled: false, value: '', checked: false, textContent: '', innerHTML: '', className: '', listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await flush(); }

function boot(routes, { session = true } = {}) {
  const nodes = new Map(IDS.map(id => [`#${id}`, makeNode()]));
  nodes.get('#dashboard').hidden = true;
  nodes.get('#logout').hidden = true;
  nodes.get('#loadMoreOrders').hidden = true;
  const storage = new Map(session ? [['elan_auth_session', JSON.stringify({ access_token: 'admin-token' })]] : []);
  const calls = [];
  const timers = [];
  const document = {
    getElementById: id => nodes.get(`#${id}`) || null,
    querySelector: selector => nodes.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} }
  };
  const context = vm.createContext({
    document,
    localStorage: { getItem: key => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    location: { reload() {}, origin: 'https://example.test' },
    navigator: {},
    fetch: async (url, options = {}) => {
      const target = String(url);
      const key = `${options.method || 'GET'} ${target.split('?')[0]}`;
      const params = new URLSearchParams(target.includes('?') ? target.split('?')[1] : '');
      calls.push({ key, url: target, params, headers: options.headers || {} });
      const route = routes[key];
      if (!route) throw new Error(`unexpected request ${key}`);
      return typeof route === 'function' ? route(target, params) : route;
    },
    URLSearchParams, console,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].callback = null; },
    setInterval() {}, clearInterval() {}
  });
  context.window = context;
  context.window.addEventListener = () => {};
  vm.runInContext(portalSource, context, { filename: 'portal.js' });
  vm.runInContext(source, context, { filename: 'dashboard.js' });
  return { context, nodes, calls, timers, storage };
}

const ORDER = (n, extra = {}) => ({
  id: `o${n}`, store_id: 's1', tracking_number: `ELN-20261030-00000${n}`, checkout_tracking_number: null, status: 'awaiting_store_confirmation',
  subtotal: 100, shipping_amount: null, total_amount: null, currency: 'EGP', customer_name: `Customer ${n}`, customer_phone: '01000000000',
  customer_email: 'c@example.invalid', customer_address: 'Cairo', customer_notes: null, reconciliation_status: 'pending', created_at: '2026-10-30T10:00:00Z',
  stores: { name: 'Store A' }, store_order_request_items: [{ product_name: 'Perfume', brand_name: 'Brand', quantity: 2, line_total: 100, currency: 'EGP' }], store_order_notifications: [], ...extra
});
function ordersRoute(rows, { total = rows.length, hasMore = false } = {}) {
  return json(200, { ok: true, orders: rows, pagination: { limit: 100, offset: 0, total, hasMore } });
}
function baseRoutes(extra = {}) {
  return { 'GET /api/dashboard-orders': ordersRoute([ORDER(1), ORDER(2)], { total: 2 }), 'GET /api/store-integrations': json(200, { ok: true, stores: [] }), ...extra };
}
async function start(routes, options) { const page = boot(routes, options); await settle(); return page; }
const n = value => value.toLocaleString('ar-EG');

test('the first load reads the newest page with no filter and shows the server total next to the rows on screen', async () => {
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': ordersRoute([ORDER(1), ORDER(2)], { total: 250, hasMore: true }) }));
  const first = page.calls.find(call => call.key === 'GET /api/dashboard-orders');
  assert.equal(first.params.get('limit'), '100');
  assert.equal(first.params.get('offset'), '0');
  for (const key of ['status', 'matchStatus', 'q', 'attention']) assert.equal(first.params.has(key), false, `no ${key} filter yet`);
  assert.equal(first.headers.Authorization, 'Bearer admin-token');
  const stats = page.nodes.get('#stats').innerHTML;
  assert.match(stats, new RegExp(`الطلبات المطابقة للفلاتر</small><strong class="">${n(250)}`));
  assert.match(stats, new RegExp(`المعروضة الآن</small><strong class="">${n(2)}`));
  assert.equal(page.nodes.get('#dashboard').hidden, false);
  assert.equal(page.nodes.get('#authCard').hidden, true);
  assert.equal(page.nodes.get('#loadMoreOrders').hidden, false);
  assert.match(page.nodes.get('#orders').innerHTML, /ELN-20261030-000001/);
  assert.ok(page.calls.some(call => call.key === 'GET /api/store-integrations'), 'the store settings load after the orders');
});

test('choosing a status, a match state or "needs review" asks the server again from the first page', async () => {
  const page = await start(baseRoutes());
  page.nodes.get('#statusFilter').value = 'shipped';
  await page.nodes.get('#statusFilter').listeners.change();
  page.nodes.get('#matchFilter').value = 'mismatched';
  await page.nodes.get('#matchFilter').listeners.change();
  page.nodes.get('#attentionFilter').checked = true;
  await page.nodes.get('#attentionFilter').listeners.change();
  await settle();
  const last = page.calls.filter(call => call.key === 'GET /api/dashboard-orders').pop();
  assert.equal(last.params.get('status'), 'shipped');
  assert.equal(last.params.get('matchStatus'), 'mismatched');
  assert.equal(last.params.get('attention'), '1');
  assert.equal(last.params.get('offset'), '0');
});

test('the search box waits for a pause in typing, then sends the trimmed text', async () => {
  const page = await start(baseRoutes());
  const before = page.calls.length;
  const box = page.nodes.get('#searchFilter');
  box.value = ' أح';
  box.listeners.input();
  box.value = '  أحمد 0100  ';
  box.listeners.input();
  await settle();
  assert.equal(page.calls.length, before, 'nothing is sent while the admin is typing');
  const live = page.timers.filter(timer => timer.callback);
  assert.equal(live.length, 1, 'the first timer was cancelled by the second keystroke');
  assert.equal(live[0].ms, 350);
  live[0].callback();
  await settle();
  const last = page.calls.filter(call => call.key === 'GET /api/dashboard-orders').pop();
  assert.equal(last.params.get('q'), 'أحمد 0100');
  assert.equal(last.params.get('offset'), '0');
});

test('"more orders" asks for the next page with the same filters and adds the rows', async () => {
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': (url, params) => (params.get('offset') === '0' ? ordersRoute([ORDER(1), ORDER(2)], { total: 3, hasMore: true }) : ordersRoute([ORDER(3)], { total: 3, hasMore: false })) }));
  page.nodes.get('#statusFilter').value = 'awaiting_store_confirmation';
  await page.nodes.get('#statusFilter').listeners.change();
  await settle();
  await page.nodes.get('#loadMoreOrders').listeners.click();
  await settle();
  const last = page.calls.filter(call => call.key === 'GET /api/dashboard-orders').pop();
  assert.equal(last.params.get('offset'), '2');
  assert.equal(last.params.get('status'), 'awaiting_store_confirmation', 'the filters stay');
  const markup = page.nodes.get('#orders').innerHTML;
  assert.equal((markup.match(/class="order-card"/g) || []).length, 3);
  assert.equal(page.nodes.get('#loadMoreOrders').hidden, true);
  assert.equal(page.nodes.get('#loadMoreOrders').disabled, false);
});

test('an answer that arrives after the filters changed is thrown away', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  let call = 0;
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': (url, params) => {
    call += 1;
    if (call === 1) return json(200, { ok: true, orders: [ORDER(1)], pagination: { total: 1, hasMore: false } });
    if (params.get('status') === 'shipped') return slow;
    return ordersRoute([ORDER(9, { tracking_number: 'ELN-FRESH' })], { total: 1 });
  } }));
  page.nodes.get('#statusFilter').value = 'shipped';
  const pending = page.nodes.get('#statusFilter').listeners.change();
  page.nodes.get('#statusFilter').value = 'delivered';
  await page.nodes.get('#statusFilter').listeners.change();
  await settle();
  assert.match(page.nodes.get('#orders').innerHTML, /ELN-FRESH/);
  release(json(200, { ok: true, orders: [ORDER(5, { tracking_number: 'ELN-STALE' })], pagination: { total: 1, hasMore: false } }));
  await pending;
  await settle();
  assert.doesNotMatch(page.nodes.get('#orders').innerHTML, /ELN-STALE/, 'the older answer does not replace the newer one');
  assert.match(page.nodes.get('#orders').innerHTML, /ELN-FRESH/);
});

test('every customer or database text in an order card is escaped', async () => {
  const hostile = ORDER(1, {
    customer_name: '<img src=x onerror=alert(1)>', customer_phone: '"><script>alert(2)</script>', customer_address: '<b>addr</b>', customer_notes: "'><svg onload=1>", customer_email: '<i>mail</i>',
    stores: { name: '<u>store</u>' }, store_order_request_items: [{ product_name: '<script>p</script>', brand_name: '<em>brand</em>', quantity: 1, line_total: 10, currency: '<x>' }],
    store_order_notifications: [{ event_type: 'store_completed', match_status: '<b>weird</b>', received_at: '2026-10-30T11:00:00Z' }]
  });
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': ordersRoute([hostile]) }));
  const markup = page.nodes.get('#orders').innerHTML;
  assert.doesNotMatch(markup, /<img|<script|<svg|<b>addr|<i>mail|<u>store|<em>|<x>|<b>weird/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('match states show in Arabic, also in the notice list', async () => {
  const withNotice = ORDER(1, { reconciliation_status: 'mismatched', store_order_notifications: [{ event_type: 'store_completed', match_status: 'matched', received_at: '2026-10-30T11:00:00Z' }] });
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': ordersRoute([withNotice, ORDER(2, { reconciliation_status: 'pending' })]) }));
  const markup = page.nodes.get('#orders').innerHTML;
  assert.match(markup, /غير مطابق/);
  assert.match(markup, /قيد المطابقة/);
  assert.match(markup, /إشعار الإتمام · مطابق/);
  assert.doesNotMatch(markup, /· matched|· pending|>mismatched</);
});

test('no match shows the plain empty message, without the old "loaded pages only" wording', async () => {
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': ordersRoute([], { total: 0 }) }));
  assert.match(page.nodes.get('#orders').innerHTML, /لا توجد طلبات مطابقة للفلاتر الحالية<\/div>/);
  assert.match(page.nodes.get('#stats').innerHTML, new RegExp(`<strong class="">${n(0)}`));
});

test('a failed first load shows an Arabic reason on the sign-in card; a failed refresh keeps the orders and shows a banner', async () => {
  const failed = await start(baseRoutes({ 'GET /api/dashboard-orders': json(502, { ok: false, error: 'store_order_read_failed' }) }));
  assert.equal(failed.nodes.get('#authCard').hidden, false);
  assert.equal(failed.nodes.get('#authError').textContent, 'تعذر تحميل الطلبات الآن، حاول بعد قليل.');

  let call = 0;
  const page = await start(baseRoutes({ 'GET /api/dashboard-orders': () => { call += 1; return call === 1 ? ordersRoute([ORDER(1)]) : json(502, { ok: false, error: 'store_order_read_failed' }); } }));
  page.nodes.get('#statusFilter').value = 'shipped';
  await page.nodes.get('#statusFilter').listeners.change();
  await settle();
  assert.equal(page.nodes.get('#ordersError').hidden, false);
  assert.equal(page.nodes.get('#ordersError').textContent, 'تعذر تحميل الطلبات الآن، حاول بعد قليل.');
  assert.match(page.nodes.get('#orders').innerHTML, /ELN-20261030-000001/, 'the rows already on screen stay');
  assert.equal(page.nodes.get('#dashboard').hidden, false, 'the admin is not thrown back to the sign-in card');
});

test('the status list holds every status the API accepts, and the page has the new controls and no inline script', () => {
  const api = fs.readFileSync(path.join(root, 'api', 'dashboard-orders.js'), 'utf8');
  const accepted = [...api.slice(api.indexOf('ORDER_STATUSES'), api.indexOf(']);')).matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.equal(accepted.length, 10);
  const select = html.slice(html.indexOf('<select id="statusFilter">'), html.indexOf('</select>'));
  for (const status of accepted) assert.ok(select.includes(`value="${status}"`), `${status} can be chosen`);
  assert.match(html, /id="attentionFilter" type="checkbox"/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});
