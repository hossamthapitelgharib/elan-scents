const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The store's own panel (store-dashboard.js) runs here with a minimal fake page. All data below is fake.
// The panel is READ ONLY: the order reaches the store through its technical link and the store's system answers it by itself
// (accept with a payment window, or reject with a reason). Nobody presses anything here, so no test presses anything.
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
    docListeners,
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

test('the payment box shows the frozen amount, the method, the reference and the time, escaped', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({
    id: 'q1', status: 'processing', payment_status: 'paid', payable_amount: 1250.5, payment_method: 'card', payment_reference: 'PAY-<b>1</b>', paid_at: '2026-11-12T10:00:00Z'
  })]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.match(html, /تم الدفع/);
  assert.match(html, /بطاقة/);
  assert.match(html, /PAY-&lt;b&gt;1&lt;\/b&gt;/, 'the payment reference is escaped');
  assert.doesNotMatch(html, /PAY-<b>1/);
});

test('the shipment events of an order are listed with their source', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({
    id: 'e1', status: 'shipped', payment_status: 'paid',
    store_shipment_events: [{ id: 'ev1', shipping_status: 'in_transit', occurred_at: '2026-11-12T10:00:00Z', carrier_name: 'ناقل <i>x</i>', tracking_code: 'WB-1', source: 'merchant_api', note: null }]
  })]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.match(html, /سجل أحداث الشحن/);
  assert.match(html, /WB-1/);
  assert.match(html, /واجهة المتجر/);
  assert.doesNotMatch(html, /<i>x<\/i>/, 'the carrier name is escaped');
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

test('customer text is escaped on the order cards', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({ customer_name: '<img src=x onerror=alert(1)>', customer_address: '"><script>x</script>' })]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the panel is read only: it only ever reads, draws no action button or form, and listens for no update or shipment click', async () => {
  const statuses = ['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'store_cancelled', 'cancelled'];
  const page = boot({ 'GET /api/store-dashboard-orders': list(statuses.map((status, index) => order({ id: `o${index}`, status, payment_status: 'paid' }))) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.doesNotMatch(html, /data-update|data-status=|data-shipment-form|<form|<button|<textarea|<select/, 'no control on any card');
  assert.deepEqual([...new Set(page.calls.map(call => call.method))], ['GET'], 'the panel writes nothing');
  assert.equal(page.calls.some(call => /store-order-update|store-shipment-update|store-payment-methods/.test(call.url)), false);
  const source = read('store-dashboard.js');
  assert.doesNotMatch(source, /store-order-update|store-shipment-update|store-payment-methods|data-update|data-shipment-form|prompt\(/);
  assert.doesNotMatch(read('store-dashboard.html'), /id="paymentMethods"|paymentMethodForm|orderActionError/, 'no payment-methods panel in the page either');
  for (const type of ['submit']) assert.equal((page.docListeners[type] || []).length, 0, `no document-level ${type} handler for actions`);
});

test('an unpaid order says that preparing starts after a neutral payment confirmation, not after anything the store presses', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([order({ id: 'u1', status: 'store_confirmed', payment_status: 'awaiting_payment', payable_amount: 130 })]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.match(html, /بانتظار تأكيد الدفع/);
  assert.match(html, /يُجهَّز الطلب بعد تأكيد الدفع من جهة محايدة/);
  const paid = boot({ 'GET /api/store-dashboard-orders': list([order({ id: 'u2', status: 'store_confirmed', payment_status: 'paid', payable_amount: 130 })]) });
  await tick();
  assert.doesNotMatch(paid.get('#orders').innerHTML, /يُجهَّز الطلب بعد تأكيد الدفع/);
});

test('why an order ended without a sale is shown: the merchant\'s own reason when it declined (escaped), a plain note when it was cancelled', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([
    order({ id: 'r1', status: 'store_rejected', failure_reason: 'نفد المخزون <b>x</b>' }),
    order({ id: 'c1', status: 'cancelled' }),
    order({ id: 'a1', status: 'awaiting_store_confirmation' })
  ]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.match(html, /ردّ المتجر[\s\S]*نفد المخزون &lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /أُلغي الطلب/);
  assert.equal((html.match(/cancel-box/g) || []).length, 2, 'an order still waiting shows neither note');
});

test('a shipment recorded by the carrier link is summarised on the card; an order without one shows no shipment box', async () => {
  const page = boot({ 'GET /api/store-dashboard-orders': list([
    order({ id: 's1', status: 'shipped', payment_status: 'paid', store_shipments: [{ shipping_status: 'in_transit', carrier_name: 'ناقل <u>y</u>' }] }),
    order({ id: 's2', status: 'processing', payment_status: 'paid' })
  ]) });
  await tick();
  const html = page.get('#orders').innerHTML;
  assert.match(html, /الشحنة[\s\S]*في الطريق/);
  assert.doesNotMatch(html, /<u>y<\/u>/);
  assert.equal((html.match(/store-shipment-box/g) || []).length >= 3, true, 'two payment boxes and one shipment box');
});
