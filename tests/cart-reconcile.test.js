// Cart reconciliation (app-core.js: reconcileCart and the cart message), the owner's rules of 2026-11-12:
//   * every cart line follows the platform eligible offer of its size (cheapest eligible store, stock > 0);
//   * a price change at the same store (up or down): the line stays at the new price;
//   * the cheapest store ran out: the line stays and moves to the next store's group at that store's price;
//   * the quantity is no longer fully available: it is cut to what is left, the line says «تم تخفيض الكمية» and stays purchasable;
//   * the size has no eligible offer any more: the line leaves the cart and the message says «المنتج غير متاح حاليًا»;
//     that perfume cannot be ordered until an eligible offer is back;
//   * one message above the cart («تم تغيير حالة بعض منتجات السلة») opens into the detail of every line;
//   * reaching the maximum of the cheapest offer shows the maximum available quantity and never jumps to a dearer store.
// The real functions are cut out of app-core.js and run in a VM with stubs; no network, no real customer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const core = fs.readFileSync(path.join(__dirname, '..', 'app-core.js'), 'utf8');
const lines = core.split('\n');
const line = (prefix) => { const found = lines.filter((l) => l.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0]; };
const between = (a, b) => { const i = core.indexOf(a); assert.ok(i >= 0, a); const j = core.indexOf(b, i); assert.ok(j > i, b); return core.slice(i, j); };

const SOURCE = [
  line('var LB='), line('en:{home:'), line('function esc('), line('var ORDER_UI='), line('function byId('),
  line('function platformEligibleOffer('), line('function cartGroups('), line('function cartHTML('),
  between('var CART_CHANGES=', 'function cartMovedNotice'),
  line('function addToCart('), line('function cartQty(')
].join('\n');

const offer = (store, storeId, storeProductId, price, stock, extra = {}) => ({ store, storeId, storeProductId, price, cur: 'EGP', avail: true, flags: [], stock, tax: true, ship: false, ...extra });
const perfume = (id, name, platform, extra = {}) => ({ id, pid: 'prod-' + id, name: name + ' · 100 مل', pn: name, sz: '100 مل', brand: 'Brand', platformEligibleOffer: platform, allEligibleOffers: platform ? [platform] : [], offersByStore: {}, ...extra });
const lineOf = (sid, o, q) => ({ sid, storeProductId: o.storeProductId, storeId: o.storeId, storeName: o.store, observedPrice: o.price, currency: 'EGP', q });

function setup({ perfumes = [], cart = [], saved = {} } = {}) {
  const store = new Map(Object.entries(saved)), toasts = [], tracked = [], sheets = [];
  const context = {
    console, JSON, Date, Math, String, Number, Array, Object, Promise, encodeURIComponent,
    lang: 'ar', AUTH: null, window: {}, T: () => ({ she: { cart: 'السلة فارغة' } }),
    PERFUMES: perfumes, ANNOUNCEMENTS: [], CART: cart,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
    saveCart: () => { context.saves = (context.saves || 0) + 1; }, cartBadge: () => {}, cartPulse: () => {},
    trackGuestProduct: (...a) => tracked.push(a), toast: (m) => toasts.push(m), sheet: (k) => sheets.push(k),
    saves: 0
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  const run = (src) => vm.runInContext(src, context);
  const json = (src) => JSON.parse(JSON.stringify(run(src)));
  return { context, store, toasts, tracked, sheets, run, json };
}

test('nothing changed: the cart is left exactly as it is and no message is made', () => {
  const o = offer('Store A', 'sa', 'sp-a', 100, 10);
  const h = setup({ perfumes: [perfume('s1', 'Oud', o)], cart: [lineOf('s1', o, 2)] });
  assert.equal(h.run('reconcileCart(false)'), false);
  assert.equal(h.run('CART_CHANGES.length'), 0);
  assert.equal(h.run('cartChangesHTML()'), '');
  assert.equal(h.store.has('elan_cart_changes'), false);
});

test('the same store lowers or raises the price: the line stays at the new price and the change shows old and new', () => {
  for (const [from, to] of [[100, 80], [100, 130]]) {
    const old = offer('Store A', 'sa', 'sp-a', from, 10), now = offer('Store A', 'sa', 'sp-a', to, 10);
    const h = setup({ perfumes: [perfume('s1', 'Oud', now)], cart: [lineOf('s1', old, 2)] });
    assert.equal(h.run('reconcileCart(true)'), true);
    const cart = h.json('CART');
    assert.equal(cart.length, 1, 'the line stays');
    assert.equal(cart[0].observedPrice, to);
    assert.equal(cart[0].storeId, 'sa');
    assert.equal(cart[0].q, 2, 'the quantity is untouched');
    const [change] = h.json('CART_CHANGES');
    assert.deepEqual([change.sid, change.name, change.oldPrice, change.newPrice, change.storeChanged, change.priceChanged, change.gone], ['s1', 'Oud', from, to, false, true, undefined]);
    assert.equal(h.context.saves, 1, 'push=true saves the cart to the account too');
    // after the move the line is current: it can be ordered, nothing asks for a review
    assert.equal(h.json('cartGroups()').sa[0].b.review, false);
  }
});

test('the cheapest store ran out: the line moves to the next store (new group, new price) and says which store it left', () => {
  const was = offer('Store A', 'sa', 'sp-a', 100, 10), next = offer('Store B', 'sb', 'sp-b', 120, 7);
  const h = setup({ perfumes: [perfume('s1', 'Oud', next)], cart: [lineOf('s1', was, 3), lineOf('s2', offer('Store A', 'sa', 'sp-a2', 50, 9), 1)] });
  h.context.PERFUMES.push(perfume('s2', 'Musk', offer('Store A', 'sa', 'sp-a2', 50, 9)));
  assert.equal(h.run('reconcileCart(false)'), true);
  const groups = h.json('cartGroups()');
  assert.deepEqual(Object.keys(groups).sort(), ['sa', 'sb'], 'the moved line has its own store group; the other line keeps its group');
  assert.equal(groups.sb[0].c.sid, 's1');
  assert.equal(groups.sb[0].b.price, 120);
  assert.equal(groups.sb[0].b.store, 'Store B');
  assert.equal(groups.sb[0].b.review, false, 'the line is current at its new store, so it can be ordered');
  assert.equal(groups.sa.length, 1);
  assert.equal(h.json('CART').find((c) => c.sid === 's1').storeProductId, 'sp-b');
  const [change] = h.json('CART_CHANGES');
  assert.deepEqual([change.oldStore, change.newStore, change.oldPrice, change.newPrice, change.storeChanged, change.priceChanged], ['Store A', 'Store B', 100, 120, true, true]);
  // the store header shows the store NAME, not its identifier
  const html = h.run('cartHTML()');
  assert.match(html, /<div class="cart-store-head"><div><b>Store B<\/b>/);
  assert.match(html, /<div class="cart-store-head"><div><b>Store A<\/b>/);
  assert.doesNotMatch(html, /<b>sb<\/b>|<b>sa<\/b>/);
});

test('less stock than the cart holds: the quantity is cut to what is left, the line says so and stays purchasable', () => {
  const o = offer('Store A', 'sa', 'sp-a', 100, 3);
  const h = setup({ perfumes: [perfume('s1', 'Oud', o)], cart: [lineOf('s1', offer('Store A', 'sa', 'sp-a', 100, 9), 5)] });
  assert.equal(h.run('reconcileCart(false)'), true);
  assert.equal(h.json('CART')[0].q, 3);
  assert.equal(h.run('cartQtyCut("s1")'), true);
  const html = h.run('cartHTML()');
  assert.match(html, /<small class="cart-qtycut" role="status">تم تخفيض الكمية<\/small>/, 'the notice sits beside the item');
  assert.doesNotMatch(html, /store-order-btn"[^>]*disabled/, 'the order button is still enabled');
  assert.doesNotMatch(html, /cart-review/);
  const [change] = h.json('CART_CHANGES');
  assert.deepEqual([change.qOld, change.qNew, change.storeChanged, change.priceChanged], [5, 3, false, false]);
  // a quantity cut never raises a quantity: a cart that holds less than the stock is left alone
  const small = setup({ perfumes: [perfume('s1', 'Oud', o)], cart: [lineOf('s1', o, 2)] });
  assert.equal(small.run('reconcileCart(false)'), false);
});

test('the notice beside the item goes when the customer changes that quantity by hand, and the message keeps its other lines', () => {
  const o = offer('Store A', 'sa', 'sp-a', 100, 3);
  const h = setup({ perfumes: [perfume('s1', 'Oud', o)], cart: [lineOf('s1', offer('Store A', 'sa', 'sp-a', 100, 9), 5)] });
  h.run('reconcileCart(false)');
  h.run('cartQty("s1|-1")');
  assert.equal(h.run('cartQtyCut("s1")'), false);
  assert.equal(h.json('CART')[0].q, 2);
  assert.equal(h.run('CART_CHANGES.length'), 1, 'the detail stays in the message until dismissed');
  h.run('cartChangeDrop("s1")');
  assert.equal(h.run('CART_CHANGES.length'), 0);
  assert.equal(h.store.has('elan_cart_changes'), false, 'nothing left to remember');
});

test('no eligible offer left: the line leaves the cart, the message says «المنتج غير متاح حاليًا», and the perfume cannot be added until an offer is back', () => {
  const was = offer('Store A', 'sa', 'sp-a', 100, 4);
  const h = setup({ perfumes: [perfume('s1', 'Oud', was), perfume('s2', 'Musk', offer('Store A', 'sa', 'sp-m', 50, 9))], cart: [lineOf('s1', was, 2), lineOf('s2', offer('Store A', 'sa', 'sp-m', 50, 9), 1)] });
  h.run('reconcileCart(false)'); // both are fine: this remembers the names
  assert.equal(h.run('CART_CHANGES.length'), 0);
  h.context.PERFUMES[0].platformEligibleOffer = null; // the last eligible store sold out
  h.context.PERFUMES[0].allEligibleOffers = [];
  assert.equal(h.run('reconcileCart(false)'), true);
  assert.deepEqual(h.json('CART').map((c) => c.sid), ['s2'], 'only the unavailable line leaves');
  const [change] = h.json('CART_CHANGES');
  assert.deepEqual([change.sid, change.name, change.gone, change.oldStore, change.oldPrice], ['s1', 'Oud', true, 'Store A', 100]);
  const html = h.run('cartHTML()');
  assert.match(html, /المنتج غير متاح حاليًا/);
  assert.match(html, /<b>Oud<\/b>/, 'the message names the perfume that went');
  // ordering it is blocked
  h.run('addToCart("s1")');
  assert.deepEqual(h.json('CART').map((c) => c.sid), ['s2'], 'not added');
  assert.equal(h.toasts.pop(), h.run('LB.ar.unav'));
  // the offer is back: it can be added again
  h.context.PERFUMES[0].platformEligibleOffer = offer('Store C', 'sc', 'sp-c', 90, 5);
  h.run('addToCart("s1")');
  assert.deepEqual(h.json('CART').map((c) => c.sid).sort(), ['s1', 's2']);
});

test('a perfume whose only line is gone: the cart is empty but the message is still shown', () => {
  const was = offer('Store A', 'sa', 'sp-a', 100, 4);
  const h = setup({ perfumes: [perfume('s1', 'Oud', null)], cart: [lineOf('s1', was, 1)], saved: { elan_cart_names: JSON.stringify({ s1: { n: 'Oud', s: '100 مل' } }) } });
  assert.equal(h.run('reconcileCart(false)'), true);
  assert.equal(h.json('CART').length, 0);
  const html = h.run('cartHTML()');
  assert.match(html, /class="cart-changes"/);
  assert.match(html, /السلة فارغة/);
  assert.match(html, /<b>Oud<\/b> <small>100 مل<\/small>/, 'the name comes from the saved names when the perfume is no longer listed');
});

test('an announcement («قريبًا») is never a cart line: its size has no offer, so a stale line for it is removed', () => {
  const h = setup({ cart: [lineOf('s1', offer('Store A', 'sa', 'sp-a', 100, 4), 1)] });
  h.context.ANNOUNCEMENTS.push({ id: 's1', pid: 'prod-s1', pn: 'Oud', name: 'Oud', announcement: true, platformEligibleOffer: null });
  assert.equal(h.run('reconcileCart(false)'), true);
  assert.equal(h.json('CART').length, 0);
  h.run('addToCart("s1")');
  assert.equal(h.json('CART').length, 0, 'an announcement cannot be added to the cart');
  assert.equal(h.toasts.pop(), h.run('LB.ar.unav'));
});

test('the message is closed by default, counts the changed perfumes, escapes names, and the detail has old and new store and price', () => {
  const was = offer('Store A', 'sa', 'sp-a', 100, 10), next = offer('Store <B>', 'sb', 'sp-b', 120.5, 7);
  const h = setup({ perfumes: [perfume('s1', '<img src=x onerror=1>', next)], cart: [lineOf('s1', was, 1)] });
  h.run('reconcileCart(false)');
  const html = h.run('cartChangesHTML()');
  assert.match(html, /<button type="button" class="cart-changes-bar" data-cart-changes aria-expanded="false">تم تغيير حالة بعض منتجات السلة <span>\(1\)<\/span>/);
  assert.match(html, /<div class="cart-changes-list" hidden>/);
  assert.doesNotMatch(html, /<img|<B>/, 'names and stores are text, never markup');
  for (const part of ['السعر السابق', 'السعر الحالي', 'المتجر السابق', 'المتجر الحالي', '100 EGP', '120.5 EGP', 'Store A', 'Store B']) assert.ok(html.includes(part), part);
  h.run('CART_CHANGES_OPEN=true');
  assert.match(h.run('cartChangesHTML()'), /aria-expanded="true">[\s\S]*<div class="cart-changes-list">/);
  assert.match(html, /data-cart-changes-dismiss/, 'the customer can hide the message');
});

test('the message and its detail survive a reload, and a second look at the same line replaces its record instead of piling up', () => {
  const was = offer('Store A', 'sa', 'sp-a', 100, 10), now = offer('Store A', 'sa', 'sp-a', 90, 10), later = offer('Store A', 'sa', 'sp-a', 85, 10);
  const h = setup({ perfumes: [perfume('s1', 'Oud', now)], cart: [lineOf('s1', was, 1)] });
  h.run('reconcileCart(false)');
  const saved = h.store.get('elan_cart_changes');
  assert.ok(saved && JSON.parse(saved).length === 1);
  const again = setup({ perfumes: [perfume('s1', 'Oud', now)], cart: h.json('CART'), saved: { elan_cart_changes: saved } });
  assert.equal(again.run('CART_CHANGES.length'), 1, 'read back after the page loads');
  assert.equal(again.run('reconcileCart(false)'), false, 'nothing new to say');
  again.context.PERFUMES[0].platformEligibleOffer = later;
  assert.equal(again.run('reconcileCart(false)'), true);
  const records = again.json('CART_CHANGES');
  assert.equal(records.length, 1, 'one record per perfume');
  assert.deepEqual([records[0].oldPrice, records[0].newPrice], [90, 85]);
});

test('the max quantity of the cheapest offer is reported and never moves the customer to a dearer store', () => {
  const cheap = offer('Store A', 'sa', 'sp-a', 100, 3), dear = offer('Store B', 'sb', 'sp-b', 140, 50);
  const p = perfume('s1', 'Oud', cheap, { allEligibleOffers: [cheap, dear], offersByStore: { sa: cheap, sb: dear } });
  const h = setup({ perfumes: [p], cart: [lineOf('s1', cheap, 3)] });
  h.run('cartQty("s1|1")');
  assert.equal(h.json('CART')[0].q, 3, 'stays at the maximum');
  assert.equal(h.json('CART')[0].storeId, 'sa', 'stays at the cheapest store');
  assert.equal(h.json('CART')[0].observedPrice, 100);
  assert.equal(h.toasts.pop(), 'أقصى كمية متاحة: 3 فقط.');
  // the product page and the "add" button say the same
  const fresh = setup({ perfumes: [p], cart: [lineOf('s1', cheap, 2)] });
  fresh.run('addToCart("s1", 5)');
  assert.equal(fresh.json('CART')[0].q, 3);
  assert.equal(fresh.json('CART')[0].storeId, 'sa');
  assert.equal(fresh.toasts.pop(), 'أقصى كمية متاحة: 3 فقط.');
  assert.equal(fresh.run('reconcileCart(false)'), false, 'a full cart at the maximum is not a change');
});

test('a catalog that answered with nothing at all never empties a cart (it looks like an outage, not a decision)', () => {
  const o = offer('Store A', 'sa', 'sp-a', 100, 4);
  const h = setup({ perfumes: [], cart: [lineOf('s1', o, 2), { sid: 's9', q: 1 }] });
  assert.equal(h.run('reconcileCart(true)'), false);
  assert.equal(h.json('CART').length, 2, 'both lines are still there');
  assert.equal(h.run('CART_CHANGES.length'), 0);
  assert.equal(h.context.saves, 0, 'and nothing is pushed to the account');
  // the moment the catalog has any perfume, the same cart is reconciled as usual
  h.context.PERFUMES.push(perfume('other', 'Other', offer('Store A', 'sa', 'sp-o', 10, 3)));
  assert.equal(h.run('reconcileCart(false)'), true);
  assert.deepEqual(h.json('CART').map((c) => c.sid).filter((x) => x !== 's9'), [], 'the stale size is gone now');
});
