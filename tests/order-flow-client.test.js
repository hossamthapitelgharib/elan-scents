// The storefront's order submission (app-core.js: sendStoreOrder): the customer sees "registered" only after the server has
// saved the order, a failure shows a clear Arabic message and keeps the form, and a retry after a lost answer reuses the same
// retry key. The real functions are cut out of app-core.js and run in a VM with stubs; no network, no real customer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lines = core.split('\n');
const line = (prefix) => { const found = lines.filter((l) => l.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0]; };
const SOURCE = [line('function esc('), line('var ORDER_UI='), line('function readOrders('), line('function saveOrders('), line('var ORDER_ERRORS='),
  line('function orderErrorKey('), line('async function sendStoreOrder(')].join('\n');

const SIZE = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
const SP = '9d7b2c1a-4e55-4b3a-8c11-1f2e3d4c5b6a';
const ANSWER = { id: 'req-1', trackingNumber: 'ELN-20261027-123456', checkoutSessionId: 'cs-1', currency: 'EGP', status: 'awaiting_store_confirmation' };

function setup({ auth = { access_token: 'token', user: { id: 'user-1' } }, fetchImpl } = {}) {
  const events = [], store = new Map();
  const context = {
    console, JSON, Date, Math, String, Number, Promise, Error, TypeError, Array, Object, encodeURIComponent,
    lang: 'ar', AUTH: auth, SB: { url: 'https://project.example.invalid', key: 'anon' }, CFG: {},
    ST: [['Store A', 'x', 'store-uuid-1']],
    authHeaders: () => ({ apikey: 'anon', Authorization: 'Bearer token', 'Content-Type': 'application/json' }),
    cartGroups: () => ({ 'Store A': [{ c: { q: 2 }, p: { id: SIZE, name: 'Perfume', brand: 'Brand', sz: '100 ml' }, b: { price: 150, cur: 'EGP', storeProductId: SP } }] }),
    loadData: () => events.push('loadData'),
    removeCompletedStoreItems: (order) => events.push('removed:' + order.trackingNumber),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { events.push('set:' + k); store.set(k, String(v)); }, removeItem: (k) => store.delete(k) },
    document: { getElementById: (id) => ({ set innerHTML(value) { events.push('html:' + id); context.shown = value; } }) },
    fetch: async (url, options) => { events.push('fetch'); context.requests.push({ url: String(url), options }); return fetchImpl(String(url), options); },
    requests: [], shown: ''
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, events, store };
}
const ok = (body) => ({ ok: true, json: async () => body });
const refused = (message) => ({ ok: false, json: async () => ({ code: 'P0001', message }) });

function formFor(key = 'retry-key-abcd-0001') {
  const box = { hidden: true, textContent: '' }, button = { disabled: false, textContent: 'إرسال طلب المتجر' };
  const form = {
    dataset: { store: 'Store A', orderKey: key }, box, button,
    elements: { name: { value: ' Test Customer ' }, phone: { value: '+201000000000' }, email: { value: '' }, address: { value: 'Test street 1' }, notes: { value: '' } },
    querySelector(selector) { return selector.includes('submit') ? button : selector === '.order-error' ? box : null; }
  };
  return form;
}

test('the order is sent in one server call without a tracking number, with the displayed lines and the retry key', async () => {
  const { context } = setup({ fetchImpl: async () => ok(ANSWER) });
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].url, 'https://project.example.invalid/rest/v1/rpc/place_store_order');
  const payload = JSON.parse(context.requests[0].options.body).p_payload;
  assert.equal(payload.storeId, 'store-uuid-1');
  assert.equal(payload.idempotencyKey, 'retry-key-abcd-0001');
  assert.equal(payload.subtotal, 300);
  assert.deepEqual(payload.items, [{ storeProductId: SP, productSizeId: SIZE, quantity: 2, unitPrice: 150 }]);
  assert.equal(payload.customer.name, 'Test Customer');
  assert.equal('trackingNumber' in payload, false, 'the browser no longer makes the tracking number');
});

test('"registered" is shown only after the server answered, with the server number, and the ordered lines leave the cart', async () => {
  const { context, events, store } = setup({ fetchImpl: async () => ok(ANSWER) });
  await vm.runInContext('sendStoreOrder', context)(formFor());
  assert.ok(events.indexOf('fetch') < events.indexOf('html:sheetB'), 'the confirmation comes after the call');
  assert.match(context.shown, /تم تسجيل طلبك/);
  assert.ok(context.shown.includes('ELN-20261027-123456'));
  assert.ok(context.shown.includes('href="/account.html"'), 'the customer is pointed to "طلباتي"');
  assert.ok(events.includes('removed:ELN-20261027-123456'));
  const saved = JSON.parse(store.get('elan_orders'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].trackingNumber, 'ELN-20261027-123456');
  assert.equal(saved[0].requestId, 'req-1');
  assert.equal(store.has('elan_order_outbox'), false, 'no second, write-only copy of the order is kept');
});

test('a refusal keeps the form, shows a clear message, saves nothing and leaves the cart alone', async () => {
  const cases = [['Price changed for product x', 'ePrice'], ['Product is unavailable or has insufficient stock', 'eStock'], ['Customer details are required', 'eData'],
    ['Authentication required', 'eAuth'], ['Too many orders, try again later', 'eMany'], ['something unexpected', 'eGen']];
  for (const [message, key] of cases) {
    const { context, events, store } = setup({ fetchImpl: async () => refused(message) });
    const form = formFor();
    await vm.runInContext('sendStoreOrder', context)(form);
    const expected = vm.runInContext(`ORDER_UI.ar.${key}`, context);
    assert.equal(form.box.textContent, expected, message);
    assert.equal(form.box.hidden, false);
    assert.equal(form.button.disabled, false, 'the button works again');
    assert.equal(form.button.textContent, 'إرسال طلب المتجر');
    assert.equal(form.dataset.busy, undefined);
    assert.equal(form.dataset.orderKey, 'retry-key-abcd-0001', 'the retry key is kept');
    assert.equal(events.includes('html:sheetB'), false, 'no confirmation');
    assert.equal(store.has('elan_orders'), false, 'no local order copy');
    assert.equal(events.some((e) => e.startsWith('removed:')), false, 'the cart is untouched');
    assert.equal(events.includes('loadData'), key === 'ePrice' || key === 'eStock', 'prices and stock are reloaded after a price or stock refusal');
  }
});

test('a lost answer is retried with the same key and the duplicate answer is treated as success', async () => {
  let call = 0;
  const { context } = setup({ fetchImpl: async () => { call += 1; if (call === 1) throw new TypeError('Failed to fetch'); return ok({ ...ANSWER, duplicate: true }); } });
  const form = formFor();
  const send = vm.runInContext('sendStoreOrder', context);
  await send(form);
  assert.equal(form.box.textContent, vm.runInContext('ORDER_UI.ar.eNet', context));
  assert.equal(context.shown, '');
  await send(form);
  assert.equal(context.requests.length, 2);
  assert.equal(JSON.parse(context.requests[0].options.body).p_payload.idempotencyKey, JSON.parse(context.requests[1].options.body).p_payload.idempotencyKey);
  assert.match(context.shown, /تم تسجيل طلبك/);
});

test('a second tap while the call is in flight sends nothing more', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { context } = setup({ fetchImpl: async () => { await gate; return ok(ANSWER); } });
  const form = formFor();
  const send = vm.runInContext('sendStoreOrder', context);
  const first = send(form);
  await send(form);
  assert.equal(form.button.disabled, true);
  assert.equal(form.button.textContent, vm.runInContext('ORDER_UI.ar.sending', context));
  release();
  await first;
  assert.equal(context.requests.length, 1);
});

test('without a sign-in nothing is sent', async () => {
  const { context } = setup({ auth: null, fetchImpl: async () => { throw new Error('must not be called'); } });
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(context.requests.length, 0);
  assert.equal(form.box.textContent, vm.runInContext('ORDER_UI.ar.eAuth', context));
});

test('the order form no longer invents a tracking number, and the old write-only order copy is removed from the browser', () => {
  assert.doesNotMatch(core, /Date\.now\(\)\.toString\(\)\.slice\(-6\)/);
  assert.doesNotMatch(core, /data-order-number/);
  assert.doesNotMatch(core, /elan_order_outbox'\s*,\s*JSON/);
  assert.match(core, /data-order-key="'\+newOrderKey\(\)\+'"/);
  assert.match(core, /<p class="order-error" role="alert" hidden><\/p>/);
  assert.match(core, /localStorage\.removeItem\('elan_order_outbox'\)/);
  assert.doesNotMatch(core, /persistOrderToSupabase/);
});

test('every message of the order flow exists in Arabic and in English', () => {
  const { context } = setup({ fetchImpl: async () => ok(ANSWER) });
  for (const key of ['sent', 'saved', 'sending', 'afterConfirm', 'myOrders', 'eNet', 'eAuth', 'ePrice', 'eStock', 'eData', 'eMany', 'eGen']) {
    for (const language of ['ar', 'en']) assert.ok(vm.runInContext(`ORDER_UI.${language}.${key}`, context), `${language}.${key}`);
  }
});
