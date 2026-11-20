// What is left of the storefront's order code in app-core.js now that the order page lives in order-page.js (tests/order-page.test.js covers the
// page itself): the mapping of every refusal to a clear Arabic message (database messages and API keys alike), the cart rules the page relies on
// (a stale line blocks the order button; the quantity function can hand the redraw to the order page), the fact that the browser keeps no copy of
// an order and takes no part in the sale, and the rule that restoring a cancelled order never adds a quantity twice.
// The real functions are cut out of app-core.js and run in a VM with stubs; no network, no real customer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lines = core.split('\n');
const line = (prefix) => { const found = lines.filter((l) => l.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0]; };
const SOURCE = [line('function esc('), line('var ORDER_UI='), line('var ORDER_ERRORS='), line('function orderErrorKey('), line('function cartHTML(')].join('\n');

const SIZE = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
const SP = '9d7b2c1a-4e55-4b3a-8c11-1f2e3d4c5b6a';

function setup({ cartGroups, ready } = {}) {
  const context = {
    console, JSON, Date, Math, String, Number, Promise, Error, TypeError, Array, Object, encodeURIComponent,
    lang: 'ar', AUTH: { access_token: 'token', user: { id: 'user-1' } },
    LB: { ar: { total: 'الإجمالي', taxnote: 'بيان الضريبة' }, en: { total: 'Total', taxnote: 'Tax note' } }, T: () => ({ she: {} }),
    ST: [['Store A', 'x', 'store-uuid-1']],
    cartGroups: cartGroups || (() => ({ 'Store A': [{ c: { q: 2 }, p: { id: SIZE, name: 'Perfume', brand: 'Brand', sz: '100 ml' }, b: { store: 'Store A', storeId: 'store-uuid-1', price: 150, cur: 'EGP', storeProductId: SP } }] })),
    reconcileCart: () => false, cartChangesHTML: () => '', cartQtyCut: () => false
  };
  context.window = context;
  if (ready) context.ElanOrderPage = ready;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context;
}

test('a stale cart line is visibly flagged and the order button is blocked before any order request', () => {
  const rows = [{ c: { sid: SIZE, q: 1 }, p: { id: SIZE, name: 'Perfume', brand: 'Brand', sz: '100 ml' }, b: { store: 'Store A', storeId: 'store-uuid-1', price: 150, cur: 'EGP', storeProductId: SP, review: true } }];
  const context = setup({ cartGroups: () => ({ 'Store A': rows }) });
  const html = vm.runInContext('cartHTML()', context);
  assert.match(html, /class="cart-review" role="status"/);
  assert.match(html, /data-order-store="Store A"[^>]*disabled/);
});

test('a store that is not connected shows «غير متاح حاليًا» on a disabled button; a store that is, or is not known yet, keeps «تنفيذ الطلب»', () => {
  const closed = setup({ ready: { ready: () => false, warm() {} } });
  const html = vm.runInContext('cartHTML()', closed);
  assert.match(html, /data-order-store="Store A"[^>]*disabled aria-disabled="true"[^>]*>غير متاح حاليًا<\/button>/);
  assert.doesNotMatch(html, /تنفيذ الطلب <span>/);
  for (const ready of [{ ready: () => true, warm() {} }, undefined]) {
    const open = setup({ ready });
    const page = vm.runInContext('cartHTML()', open);
    assert.match(page, /data-order-store="Store A"[^>]*>تنفيذ الطلب <span>→<\/span><\/button>/);
    assert.doesNotMatch(page, /data-order-store="Store A"[^>]*disabled/);
  }
});

test('the cart asks the order page which stores are connected, once per render (the page keeps the answer for a minute)', () => {
  let warmed = 0;
  const context = setup({ ready: { ready: () => true, warm: () => { warmed += 1; } } });
  vm.runInContext('cartHTML()', context);
  assert.equal(warmed, 1);
});

test('every refusal maps to a clear message, database messages and API keys alike', () => {
  const cases = [['Price changed for product x', 'ePrice'], ['price_changed', 'ePrice'], ['subtotal_mismatch', 'ePrice'], ['Product is unavailable or has insufficient stock', 'eStock'], ['stock_unavailable', 'eStock'],
    ['Account details are incomplete', 'eAcct'], ['account_incomplete', 'eAcct'], ['Cart is empty for this store', 'eEmpty'], ['cart_empty', 'eEmpty'], ['Only EGP orders are supported', 'eCur'],
    ['Customer details are required', 'eData'], ['Authentication required', 'eAuth'], ['unauthorized', 'eAuth'], ['Too many orders, try again later', 'eMany'], ['order_rate_limited', 'eMany'], ['something unexpected', 'eGen']];
  const context = setup();
  for (const [message, key] of cases) assert.equal(vm.runInContext('orderErrorKey', context)(new Error(message)), key, message);
  assert.equal(vm.runInContext('orderErrorKey', context)(Object.assign(new TypeError('Failed to fetch'), { network: true })), 'eNet');
});

test('the browser keeps no copy of the order and takes no part in the sale: the old local order code is gone', () => {
  assert.doesNotMatch(core, /Date\.now\(\)\.toString\(\)\.slice\(-6\)/);
  assert.doesNotMatch(core, /data-order-number|data-order-key|newOrderKey/);
  assert.doesNotMatch(core, /elan_orders|readOrders|saveOrders|receiveStoreNotification|compareOrder|removeCompletedStoreItems/, 'no local order list, no browser-side match, no cart clearing at creation');
  assert.doesNotMatch(core, /orderEndpoint\)\s*fetch|fetch\(endpoint/, 'the order is not posted to any other address from the browser');
  assert.doesNotMatch(core, /confirm-store-order-purchase|customer_confirmed/, 'the page has no customer purchase confirmation');
  assert.doesNotMatch(core, /persistOrderToSupabase/);
  assert.doesNotMatch(core, /sendStoreOrder|orderFormHTML|orderRows|data-store-order-form/, 'the old order form and its submit are gone');
  assert.match(core, /localStorage\.removeItem\('elan_order_outbox'\)/);
});

test('restoring a cancelled order takes the larger quantity, because the cart was never emptied by the order', () => {
  const restore = lines.find((l) => l.startsWith('function restoreCancelledStoreItems(order)'));
  assert.ok(restore);
  assert.match(restore, /it\.q=Math\.max\(\+it\.q\|\|0,q\)/);
  assert.doesNotMatch(restore, /it\.q\+=q/, 'the quantity is not added a second time');
});

test('every message the cart and the order page take from ORDER_UI exists in Arabic and in English', () => {
  const context = setup();
  for (const key of ['execute', 'notNow', 'notNowWhy', 'cartMoved', 'eNet', 'eAuth', 'ePrice', 'eStock', 'eData', 'eMany', 'eReview', 'eGen', 'eAcct', 'eEmpty', 'eCur', 'trackNo']) {
    for (const language of ['ar', 'en']) assert.ok(vm.runInContext(`ORDER_UI.${language}.${key}`, context), `${language}.${key}`);
  }
});
