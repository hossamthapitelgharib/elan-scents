const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The store's own panel (store-dashboard.js) runs here with a minimal fake page. All data below is fake.
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body });
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function makeNode() {
  return {
    hidden: false, value: '', textContent: '', innerHTML: '', className: '', disabled: false, dataset: {}, attributes: {}, listeners: {}, children: {},
    classList: { toggle() {}, add() {}, remove() {} }, elements: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return this.children[selector] || (this.children[selector] = makeNode()); },
    querySelectorAll() { return []; }
  };
}
function order(overrides = {}) {
  return {
    id: 'o1', tracking_number: 'ELAN-100', customer_name: 'عميل تجريبي', customer_phone: '01000000000', customer_address: 'عنوان', status: 'awaiting_store_confirmation',
    subtotal: 100, total_amount: 100, currency: 'EGP', reconciliation_status: 'pending', stores: { name: 'متجر' }, store_order_request_items: [], store_shipments: [], store_order_cancellation_requests: [], ...overrides
  };
}
function boot(routes) {
  const nodes = new Map();
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode()); return nodes.get(selector); };
  const docListeners = {};
  const calls = [];
  const store = { elan_auth_session: JSON.stringify({ access_token: 'fake-token' }) };
  const document = { hidden: false, querySelector: get, getElementById: id => get(`#${id}`), querySelectorAll: () => [], addEventListener(type, callback) { (docListeners[type] = docListeners[type] || []).push(callback); } };
  const context = vm.createContext({
    document, console, URLSearchParams, URL, JSON, FormData: class { constructor(form) { this.entries = form.__entries || []; } *[Symbol.iterator]() { yield* this.entries; } },
    setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, location: { reload() {} },
    localStorage: { getItem: key => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); }, removeItem: key => { delete store[key]; } },
    fetch: async (url, options = {}) => {
      const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      const route = routes[`${call.method} ${call.url.split('?')[0]}`];
      if (!route) throw new Error(`unexpected fetch ${call.method} ${call.url}`);
      return typeof route === 'function' ? route(call) : route;
    }
  });
  context.window = context;
  context.addEventListener = () => {};
  context.prompt = () => '';
  for (const file of ['portal.js', 'store-dashboard.js']) vm.runInContext(read(file), context, { filename: file });
  const dispatch = (type, event) => (docListeners[type] || []).forEach(callback => callback(event));
  return {
    context, calls, get,
    clickUpdate: button => dispatch('click', { target: { closest: selector => (selector === '[data-update]' ? button : null) } }),
    submitShipment: form => dispatch('submit', { preventDefault() {}, target: { closest: selector => (selector === '[data-shipment-form]' ? form : null) } }),
    ordersGets: () => calls.filter(call => call.method === 'GET' && call.url.startsWith('/api/store-dashboard-orders'))
  };
}
const list = (orders, extra = {}) => json(200, { ok: true, stores: ['s1'], orders, pagination: { limit: 50, offset: 0, total: orders.length, hasMore: false }, ...extra });

test('an account with no linked store sees a clear notice instead of an empty list', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([], { stores: [] }) });
  await tick();
  assert.equal(page.get('#noStoreNotice').hidden, false);
  const page2 = boot({ 'GET /api/store-dashboard-orders': list([order()]) });
  await tick();
  assert.equal(page2.get('#noStoreNotice').hidden, true);
});

test('the shipment form appears only after the store confirmed and never for rejected or cancelled orders', async () => {
  const statuses = ['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'store_cancelled', 'cancelled'];
  const page = boot({ 'GET /api/store-dashboard-orders': list(statuses.map((status, index) => order({ id: `o${index}`, status }))) });
  await tick();
  const html = page.get('#orders').innerHTML;
  for (const [index, status] of statuses.entries()) {
    const shown = html.includes(`data-shipment-form="o${index}"`);
    assert.equal(shown, ['store_confirmed', 'processing', 'shipped', 'delivered'].includes(status), status);
  }
});

test('the reconciliation state is Arabic', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({ reconciliation_status: 'mismatched' })]) });
  await tick();
  assert.match(page.get('#orders').innerHTML, /المطابقة: غير مطابق/);
  assert.doesNotMatch(page.get('#orders').innerHTML, /mismatched/);
});

test('the filters send the status and the search text, and an empty result says it is a search', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([]) });
  await tick();
  const form = { elements: { status: { value: 'processing' }, q: { value: '  ELAN-100 ' } } };
  page.get('#orderFilters').listeners.submit({ preventDefault() {}, target: form });
  await tick();
  const last = page.ordersGets().at(-1).url;
  assert.match(last, /status=processing/);
  assert.match(last, /q=ELAN-100(&|$)/, 'the search text is trimmed');
  assert.match(page.get('#orders').innerHTML, /لا توجد طلبات تطابق هذا البحث/);
  page.get('#orderFilters').listeners.submit({ preventDefault() {}, target: { elements: { status: { value: '' }, q: { value: '' } } } });
  await tick();
  assert.doesNotMatch(page.ordersGets().at(-1).url, /status=|q=/);
  assert.match(page.get('#orders').innerHTML, /لا توجد طلبات لهذا المتجر/);
});

test('the refresh button reloads the first page', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order()]) });
  await tick();
  const before = page.ordersGets().length;
  page.get('#refreshOrders').listeners.click();
  await tick();
  assert.equal(page.ordersGets().length, before + 1);
});

test('load failures are Arabic, never the raw code', async () => {
  for (const [status, error, pattern] of [[502, 'store_access_check_failed', /تعذر التحقق من ربط حسابك/], [502, 'supabase_read_failed', /تعذر تحميل الطلبات/], [403, 'forbidden', /غير مصرح/], [401, 'unauthorized', /انتهت جلسة الدخول/], [502, 'store_dashboard_failed', /تعذر تحميل طلبات المتجر/]]) {
    const page = boot({ 'GET /api/store-dashboard-orders': json(status, { ok: false, error }) });
    await tick();
    const box = page.get('#storeOrdersError');
    assert.equal(box.hidden, false, error);
    assert.match(box.textContent, pattern, error);
    assert.doesNotMatch(box.textContent, /[a-z]+_[a-z_]+/);
  }
});

test('rejecting asks first: a cancel sends nothing, a yes sends the reason', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order()]), 'PATCH /api/store-order-update': json(200, { ok: true }) });
  await tick();
  const button = { dataset: { update: 'o1', status: 'store_rejected' }, disabled: false };
  let asked = '';
  page.context.prompt = text => { asked = text; return null; };
  page.clickUpdate(button);
  await tick();
  assert.match(asked, /رفض هذا الطلب/);
  assert.equal(page.calls.some(call => call.method === 'PATCH'), false, 'cancel changes nothing');
  assert.equal(button.disabled, false);
  page.context.prompt = () => '  المنتج غير متوفر  ';
  page.clickUpdate(button);
  await tick();
  const patch = page.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { requestId: 'o1', status: 'store_rejected', reason: 'المنتج غير متوفر' });
  page.context.prompt = () => '';
  page.calls.length = 0;
  page.clickUpdate(button);
  await tick();
  assert.deepEqual(page.calls.find(call => call.method === 'PATCH').body, { requestId: 'o1', status: 'store_rejected' }, 'an empty reason is not sent');
});

test('confirming does not ask', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order()]), 'PATCH /api/store-order-update': json(200, { ok: true }) });
  await tick();
  page.context.prompt = () => { throw new Error('no question for a confirmation'); };
  page.clickUpdate({ dataset: { update: 'o1', status: 'store_confirmed' }, disabled: false });
  await tick();
  assert.deepEqual(page.calls.find(call => call.method === 'PATCH').body, { requestId: 'o1', status: 'store_confirmed' });
});

test('a refused update shows an Arabic message on the page (no alert), and a changed status refreshes the list', async () => {
  let alerts = 0;
  const cases = [
    ['store_access_denied', 403, /لا يتبع متجرك/, false],
    ['financial_update_locked', 409, /لا يمكن تعديل المبالغ/, false],
    ['order_not_found', 404, /لم يعد موجودًا/, false],
    ['order_status_changed', 409, /تغيّرت حالة الطلب/, true],
    ['invalid_status_transition', 409, /تغيّرت حالة الطلب/, true]
  ];
  for (const [error, status, pattern, refreshes] of cases) {
    const page = boot({ 'GET /api/store-dashboard-orders': list([order()]), 'PATCH /api/store-order-update': json(status, { ok: false, error }) });
    page.context.alert = () => { alerts++; };
    await tick();
    const button = { dataset: { update: 'o1', status: 'store_confirmed' }, disabled: false };
    const before = page.ordersGets().length;
    page.clickUpdate(button);
    await tick();
    const box = page.get('#orderActionError');
    assert.equal(box.hidden, false, error);
    assert.match(box.textContent, pattern, error);
    assert.equal(button.disabled, false);
    assert.equal(page.ordersGets().length > before, refreshes, `${error} refresh`);
  }
  assert.equal(alerts, 0);
  assert.doesNotMatch(read('store-dashboard.js'), /\balert\(/);
});

test('a refused shipment update shows an Arabic message', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({ status: 'processing' })]), 'PATCH /api/store-shipment-update': json(409, { ok: false, error: 'order_not_shippable' }) });
  await tick();
  const button = { disabled: false };
  page.submitShipment({ dataset: { shipmentForm: 'o1' }, __entries: [['shippingStatus', 'in_transit']], querySelector: () => button });
  await tick();
  assert.match(page.get('#orderActionError').textContent, /لا يمكن تسجيل شحن لطلب مرفوض أو ملغى/);
  assert.equal(button.disabled, false);
  assert.deepEqual(page.calls.find(call => call.method === 'PATCH').body, { shippingStatus: 'in_transit', requestId: 'o1' });
});

test('customer text is escaped on the order cards', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({ customer_name: '<img src=x onerror=alert(1)>', customer_address: '"><script>x</script>' })]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
