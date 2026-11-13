// The storefront's order submission (app-core.js: sendStoreOrder), phase 1 (docs/implementation-phase-1-purchase-core.ar.md):
// the browser saves the cart to the account and then sends ONLY the store, the retry key and the total it showed; the customer's data,
// the lines and the prices are rebuilt by the server. The customer sees "registered" only after the server has saved the order, the
// cart is NOT cleared, a failure shows a clear Arabic message and keeps the sheet, and a retry after a lost answer reuses the same
// retry key. The real functions are cut out of app-core.js and run in a VM with stubs; no network, no real customer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lines = core.split('\n');
const line = (prefix) => { const found = lines.filter((l) => l.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0]; };
const SOURCE = [line('function esc('), line('var ORDER_UI='), line('var ORDER_ERRORS='),
  line('function orderErrorKey('), line('function cartHTML('), line('async function cartFlush('), line('async function sendStoreOrder(')].join('\n');

const SIZE = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
const SP = '9d7b2c1a-4e55-4b3a-8c11-1f2e3d4c5b6a';
const ANSWER = { id: 'req-1', trackingNumber: 'ELN-20261027-123456', checkoutSessionId: 'cs-1', currency: 'EGP', status: 'awaiting_store_confirmation' };

function setup({ auth = { access_token: 'token', user: { id: 'user-1' } }, fetchImpl, cartGroups, flushFails = false } = {}) {
  const events = [], store = new Map();
  const context = {
    console, JSON, Date, Math, String, Number, Promise, Error, TypeError, Array, Object, encodeURIComponent,
    lang: 'ar', AUTH: auth, SB: { url: 'https://project.example.invalid', key: 'anon' }, CFG: {}, LB: { ar: { total: 'الإجمالي', taxnote: 'بيان الضريبة' }, en: { total: 'Total', taxnote: 'Tax note' } }, T: () => ({ she: { cart: 'Cart is empty' } }), window: {},
    ST: [['Store A', 'x', 'store-uuid-1']],
    authHeaders: () => ({ apikey: 'anon', Authorization: 'Bearer token', 'Content-Type': 'application/json' }),
    cartGroups: cartGroups || (() => ({ 'Store A': [{ c: { q: 2 }, p: { id: SIZE, name: 'Perfume', brand: 'Brand', sz: '100 ml' }, b: { price: 150, cur: 'EGP', storeProductId: SP } }] })),
    loadData: () => events.push('loadData'),
    reconcileCart: () => false, cartChangesHTML: () => '', cartQtyCut: () => false,
    CART_SYNCING: false, CART_PULLING: false, CART_PUSH_QUEUED: false, CART_LOCAL_DIRTY: false,
    pushCartToCloud: async () => { events.push('flush'); if (!flushFails) context.CART_LOCAL_DIRTY = false; },
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
  const box = { hidden: true, textContent: '' }, button = { disabled: false, textContent: 'تنفيذ الطلب' };
  const form = {
    // The sheet has no field to type in: the customer's data is the account's.
    dataset: { store: 'Store A', orderKey: key }, box, button,
    querySelector(selector) { return selector.includes('submit') ? button : selector === '.order-error' ? box : null; }
  };
  return form;
}

test('the order is sent in one server call with only the store, the retry key and the total shown, after the cart was saved', async () => {
  const { context, events } = setup({ fetchImpl: async () => ok(ANSWER) });
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].url, '/api/place-store-order');
  assert.ok(events.indexOf('flush') > -1 && events.indexOf('flush') < events.indexOf('fetch'), 'the cart is saved to the account before the order call');
  const payload = JSON.parse(context.requests[0].options.body).payload;
  assert.deepEqual(payload, { storeId: 'store-uuid-1', idempotencyKey: 'retry-key-abcd-0001', expectedSubtotal: 300 });
  for (const forbidden of ['customer', 'items', 'subtotal', 'currency', 'trackingNumber', 'unitPrice']) assert.equal(forbidden in payload, false, `the browser does not send ${forbidden}`);
});

test('"registered" is shown only after the server answered, with the server number, and the cart is NOT cleared', async () => {
  const { context, events, store } = setup({ fetchImpl: async () => ok(ANSWER) });
  await vm.runInContext('sendStoreOrder', context)(formFor());
  assert.ok(events.indexOf('fetch') < events.indexOf('html:sheetB'), 'the confirmation comes after the call');
  assert.match(context.shown, /تم تسجيل طلبك/);
  assert.ok(context.shown.includes('ELN-20261027-123456'));
  assert.ok(context.shown.includes(vm.runInContext('ORDER_UI.ar.trackNo', context)), 'the number is the Élan Scents tracking number');
  assert.ok(context.shown.includes(vm.runInContext('ORDER_UI.ar.keep', context)), 'the customer is told the products stay in the cart until payment');
  assert.ok(context.shown.includes('href="/account.html"'), 'the customer is pointed to "طلباتي"');
  assert.equal(store.size, 0, 'nothing is written to the browser: no local copy of the order');
  assert.equal(events.filter((e) => e.startsWith('flush')).length, 1, 'the cart was saved once, never emptied');
});

test('a stale cart line is visibly flagged and blocked before any order request', async () => {
  const rows = [{ c: { sid: SIZE, q: 1 }, p: { id: SIZE, name: 'Perfume', brand: 'Brand', sz: '100 ml' }, b: { price: 150, cur: 'EGP', storeProductId: SP, review: true } }];
  const groups = () => ({ 'Store A': rows });
  const { context } = setup({ cartGroups: groups, fetchImpl: async () => { throw new Error('stale item must not reach the API'); } });
  const html = vm.runInContext('cartHTML()', context);
  assert.match(html, /class="cart-review" role="status"/);
  assert.match(html, /data-order-store="Store A"[^>]*disabled/);
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(context.requests.length, 0);
  assert.equal(form.box.textContent, vm.runInContext('ORDER_UI.ar.eReview', context));
  assert.equal(form.box.hidden, false);
});

test('a refusal keeps the sheet, shows a clear message, saves nothing and leaves the cart alone (database messages and API keys alike)', async () => {
  const cases = [['Price changed for product x', 'ePrice'], ['price_changed', 'ePrice'], ['subtotal_mismatch', 'ePrice'], ['Product is unavailable or has insufficient stock', 'eStock'], ['stock_unavailable', 'eStock'],
    ['Account details are incomplete', 'eAcct'], ['account_incomplete', 'eAcct'], ['Cart is empty for this store', 'eEmpty'], ['cart_empty', 'eEmpty'], ['Only EGP orders are supported', 'eCur'],
    ['Customer details are required', 'eData'], ['Authentication required', 'eAuth'], ['unauthorized', 'eAuth'], ['Too many orders, try again later', 'eMany'], ['order_rate_limited', 'eMany'], ['something unexpected', 'eGen']];
  for (const [message, key] of cases) {
    const { context, events, store } = setup({ fetchImpl: async () => refused(message) });
    const form = formFor();
    await vm.runInContext('sendStoreOrder', context)(form);
    const expected = vm.runInContext(`ORDER_UI.ar.${key}`, context);
    assert.equal(form.box.textContent, expected, message);
    assert.equal(form.box.hidden, false);
    assert.equal(form.button.disabled, false, 'the button works again');
    assert.equal(form.button.textContent, 'تنفيذ الطلب');
    assert.equal(form.dataset.busy, undefined);
    assert.equal(form.dataset.orderKey, 'retry-key-abcd-0001', 'the retry key is kept');
    assert.equal(events.includes('html:sheetB'), false, 'no confirmation');
    assert.equal(store.size, 0, 'no local order copy');
    assert.equal(events.includes('loadData'), key === 'ePrice' || key === 'eStock', 'prices and stock are reloaded after a price or stock refusal');
  }
});

test('the API answers with an error key, and the page maps it too', async () => {
  const { context } = setup({ fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'account_incomplete' }) }) });
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(form.box.textContent, vm.runInContext('ORDER_UI.ar.eAcct', context));
});

test('when the cart cannot be saved to the account, the order is not sent and the retry is safe', async () => {
  const { context, events } = setup({ flushFails: true, fetchImpl: async () => { throw new Error('must not be called'); } });
  const form = formFor();
  await vm.runInContext('sendStoreOrder', context)(form);
  assert.equal(context.requests.length, 0, 'no order call without a saved cart');
  assert.equal(form.box.textContent, vm.runInContext('ORDER_UI.ar.eNet', context));
  assert.equal(form.button.disabled, false);
  assert.equal(events.includes('html:sheetB'), false);
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
  assert.equal(JSON.parse(context.requests[0].options.body).payload.idempotencyKey, JSON.parse(context.requests[1].options.body).payload.idempotencyKey);
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

test('the browser keeps no copy of the order and takes no part in the sale: the old local order code is gone', () => {
  assert.doesNotMatch(core, /Date\.now\(\)\.toString\(\)\.slice\(-6\)/);
  assert.doesNotMatch(core, /data-order-number/);
  assert.doesNotMatch(core, /elan_orders|readOrders|saveOrders|receiveStoreNotification|compareOrder|removeCompletedStoreItems/, 'no local order list, no browser-side match, no cart clearing at creation');
  assert.doesNotMatch(core, /elan_order_outbox'\s*,\s*JSON/);
  assert.doesNotMatch(core, /orderEndpoint\)\s*fetch|fetch\(endpoint/, 'the order is not posted to any other address from the browser');
  assert.doesNotMatch(core, /confirm-store-order-purchase|customer_confirmed/, 'the page has no customer purchase confirmation');
  assert.match(core, /data-order-key="'\+newOrderKey\(\)\+'"/);
  assert.match(core, /<p class="order-error" role="alert" hidden><\/p>/);
  assert.match(core, /localStorage\.removeItem\('elan_order_outbox'\)/);
  assert.doesNotMatch(core, /persistOrderToSupabase/);
});

test('restoring a cancelled order takes the larger quantity, because the cart was never emptied by the order', () => {
  const restore = lines.find((l) => l.startsWith('function restoreCancelledStoreItems(order)'));
  assert.ok(restore);
  assert.match(restore, /it\.q=Math\.max\(\+it\.q\|\|0,q\)/);
  assert.doesNotMatch(restore, /it\.q\+=q/, 'the quantity is not added a second time');
});

test('every message of the order flow exists in Arabic and in English', () => {
  const { context } = setup({ fetchImpl: async () => ok(ANSWER) });
  for (const key of ['sent', 'saved', 'sending', 'myOrders', 'eNet', 'eAuth', 'ePrice', 'eStock', 'eData', 'eMany', 'eReview', 'eGen', 'eAcct', 'eEmpty', 'eCur', 'trackNo', 'keep', 'reviewTitle', 'reviewNote', 'recipient', 'editAcct', 'execute']) {
    for (const language of ['ar', 'en']) assert.ok(vm.runInContext(`ORDER_UI.${language}.${key}`, context), `${language}.${key}`);
  }
});
