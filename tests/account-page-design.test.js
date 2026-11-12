// The redesigned orders page (account.html + account.css + the render half of account.js): the four steps of an order, the sentence at the top,
// money and dates in the shop's digits, Arabic counts, what each kind of card shows (and what it must not), and the sheet's own rules.
// account.js runs in a stub page; every order below is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('account.html');
const css = read('account.css');
const SIZE = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';

function node() {
  return { hidden: false, textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => node(), querySelectorAll: () => [], closest: () => null, reset() {}, focus() {} };
}
function load() {
  const nodes = new Map();
  const document = { hidden: false, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, addEventListener() {} };
  const context = { document, console, URLSearchParams, Date, Math, Number, String, JSON, Set, Array, Object, Promise, Error, encodeURIComponent, isNaN,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '', pathname: '/account.html', search: '', origin: 'https://shop.example.invalid' }, history: { replaceState() {} },
    Portal: { errorMessages: {}, session: () => null, auth: () => ({}), errorText: (e, f) => (e && e.message) || f },
    setTimeout: () => 0, fetch: async () => { throw new Error('no network in this test'); } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('account.js'), context, { filename: 'account.js' });
  return { run: code => vm.runInContext(code, context), el: selector => document.querySelector(selector) };
}
const order = (extra = {}) => ({ id: 'r1', tracking_number: 'ELN-TEST-0001', status: 'awaiting_store_confirmation', subtotal: 3450, shipping_amount: 60, total_amount: 3510, currency: 'EGP', created_at: '2026-10-28T10:00:00Z', stores: { name: 'Test Store' },
  store_order_request_items: [{ product_name: 'Test Perfume', brand_name: 'Test Brand', size_label: '100 ml', product_size_id: SIZE, quantity: 1, unit_price: 3450, line_total: 3450, currency: 'EGP' }], store_shipments: [], ...extra });
const card = (p, request) => p.run(`requestLine(${JSON.stringify(request)})`);
const steps = markup => [...markup.matchAll(/<li class="(done|current|todo)"/g)].map(match => match[1]);

test('the four steps follow what happened to the order: the first one that has not happened is "now"', () => {
  const p = load();
  const at = (status, extra) => steps(card(p, order({ status, ...extra })));
  assert.deepEqual(at('awaiting_store_confirmation'), ['done', 'current', 'todo', 'todo']);
  assert.deepEqual(at('needs_review'), ['done', 'current', 'todo', 'todo']);
  assert.deepEqual(at('store_confirmed'), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(at('processing'), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(at('shipped'), ['done', 'done', 'done', 'current']);
  // a shipment the carrier already has moves the steps even before the order's own status does
  assert.deepEqual(at('processing', { store_shipments: [{ shipping_status: 'in_transit' }] }), ['done', 'done', 'done', 'current']);
  assert.deepEqual(at('processing', { store_shipments: [{ shipping_status: 'preparing' }] }), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(at('shipped', { store_shipments: [{ shipping_status: 'delivered' }] }), ['done', 'done', 'done', 'done']);
  const marked = card(p, order({ status: 'processing' }));
  assert.equal((marked.match(/aria-current="step"/g) || []).length, 1, 'exactly one step is announced as the current one');
  assert.match(marked, /aria-label="مراحل الطلب"/);
});

test('an open order shows its sentence, the steps and the total; a finished one is a compact row with "order again" in reach and no steps', () => {
  const p = load();
  const open = card(p, order({ status: 'shipped' }));
  assert.match(open, /class="acct-order is-active"/);
  assert.match(open, /<h3>طلبك في الطريق إليك<\/h3>/);
  assert.match(open, /<b>3,510<i>ج\.م<\/i><\/b>/);
  assert.equal(open.includes('class="badge'), false, 'the sentence says it; no second label next to it');
  assert.equal((open.match(/data-reorder/g) || []).length, 1);
  assert.match(open.slice(open.indexOf('<details')), /data-reorder/, 'for an open order "order again" waits inside the details');

  for (const status of ['delivered', 'completed', 'store_cancelled', 'store_rejected', 'cancelled']) {
    const done = card(p, order({ status }));
    assert.match(done, /class="acct-order is-past"/, status);
    assert.equal(done.includes('acct-steps'), false, `${status}: no steps once it is over`);
    assert.match(done, /class="badge/);
    assert.match(done.slice(0, done.indexOf('<details')), /data-reorder/, `${status}: "order again" is visible without opening anything`);
    assert.match(done, /ELN-TEST-0001/, 'the number is on the row (the search by number relies on it)');
  }
});

test('the shipping box: the carrier\'s data when there is a shipment; what to expect while shipping is next; nothing otherwise', () => {
  const p = load();
  const shipment = { carrier_name: 'Test Carrier', tracking_code: 'TC-1', shipping_status: 'in_transit', estimated_delivery_at: '2026-12-20T00:00:00Z', status_note: 'At the sorting centre', updated_at: '2026-11-10T08:00:00Z' };
  const withShipment = card(p, order({ status: 'shipped', store_shipments: [shipment] }));
  for (const text of ['Test Carrier', 'TC-1', 'At the sorting centre', 'رقم تتبع الشحنة', 'موعد التسليم المتوقع', 'في الطريق']) assert.ok(withShipment.includes(text), text);
  assert.equal((withShipment.match(/class="shipment-box/g) || []).length, 1);
  for (const status of ['awaiting_store_confirmation', 'delivered', 'store_cancelled']) assert.equal(card(p, order({ status })).includes('shipment-box'), false, `${status} without a shipment shows no shipping box`);
  assert.match(card(p, order({ status: 'processing' })), /shipment-empty[^>]*><span>المتجر يجهّز طلبك/);
  assert.match(card(p, order({ status: 'shipped' })), /shipment-empty[^>]*><span>خرج طلبك من المتجر/);
  // a finished order keeps its shipment, once, behind "details"
  const past = card(p, order({ status: 'delivered', store_shipments: [{ ...shipment, shipping_status: 'delivered' }] }));
  assert.equal((past.match(/class="shipment-box/g) || []).length, 1);
  assert.ok(past.indexOf('shipment-box') > past.indexOf('<details'));
  assert.match(past, /جارٍ تحقق المنصة من بيانات شركة الشحن/);
});

test('an open order lists its first three items and says how many more wait in the details; the details carry every price and the numbers to quote', () => {
  const p = load();
  const items = [1, 2, 3, 4, 5].map(n => ({ product_name: `Item ${n}`, quantity: n, unit_price: 100, line_total: 100 * n, currency: 'EGP', product_size_id: SIZE }));
  const open = card(p, order({ status: 'processing', store_order_request_items: items, merchant_order_number: 'M-77', merchant_invoice_number: 'INV-9' }));
  const preview = open.slice(open.indexOf('<ul class="acct-items">'), open.indexOf('</ul>'));
  assert.equal((preview.match(/<li>/g) || []).length, 3);
  assert.match(preview, /ومنتجان آخران في التفاصيل/);
  const details = open.slice(open.indexOf('<details'));
  for (const text of ['Item 5', '500 ج.م', 'رقم الطلب', 'ELN-TEST-0001', 'M-77', 'INV-9', 'المنتجات', 'الشحن', 'الإجمالي', 'وقت الطلب']) assert.ok(details.includes(text), text);
  const four = card(p, order({ status: 'processing', store_order_request_items: items.slice(0, 4) }));
  assert.match(four, /ومنتج آخر في التفاصيل/);
  assert.equal(card(p, order({ status: 'processing', store_order_request_items: items.slice(0, 3) })).includes('class="more"'), false);
});

test('money reads "3,450 ج.م" and dates use the shop\'s digits; a broken date shows nothing instead of "Invalid Date"', () => {
  const p = load();
  assert.equal(p.run("moneyA(3450, 'EGP')"), '3,450 ج.م');
  assert.equal(p.run("moneyA(1234567.5, 'EGP')"), '1,234,567.5 ج.م');
  assert.equal(p.run("moneyA(12.5)"), '12.5 ج.م');
  assert.equal(p.run("moneyA(null, null)"), '0 ج.م');
  assert.equal(p.run("moneyA('abc', 'EGP')"), '0 ج.م');
  assert.equal(p.run("moneyA(10, 'USD')"), '10 USD');
  assert.equal(p.run("moneyA(10, '<b>')"), '10 &lt;b&gt;');
  const old = p.run("dateA('2020-03-05T10:00:00Z')");
  assert.match(old, /2020/);
  assert.match(old, /مارس/);
  assert.doesNotMatch(old, /[٠-٩]/, 'no Arabic-Indic digits');
  const thisYear = p.run("dateA(new Date().toISOString())");
  assert.equal(thisYear.includes(String(new Date().getFullYear())), false, 'the year is left out for this year');
  assert.doesNotMatch(p.run("dateTimeA('2020-03-05T10:00:00Z')"), /[٠-٩]/);
  assert.match(p.run("dateTimeA('2020-03-05T10:00:00Z')"), /\d{1,2}:\d{2}/);
  assert.equal(p.run("dateA('not a date')"), '');
  assert.equal(p.run("dateTimeA(undefined)"), '');
});

test('Arabic counts: one, two, three to ten, eleven and more', () => {
  const p = load();
  const count = n => p.run(`countA(${n}, 'طلب واحد', 'طلبان', 'طلبات', 'طلبًا')`);
  assert.deepEqual([1, 2, 3, 10, 11, 25].map(count), ['طلب واحد', 'طلبان', '3 طلبات', '10 طلبات', '11 طلبًا', '25 طلبًا']);
});

test('the sentence at the top and the little counts follow the orders', () => {
  const p = load();
  const render = requests => { p.run(`renderAccount([{ id: 's', store_order_requests: ${JSON.stringify(requests)} }])`); return { headline: p.el('#ordersHeadline').textContent, count: p.el('#ordersCount').textContent, stats: p.el('#stats').innerHTML, active: p.el('#activeOrders').innerHTML, recent: p.el('#recentOrders').innerHTML }; };
  const none = render([]);
  assert.match(none.headline, /لم تطلب شيئًا بعد/);
  assert.equal(none.count, '');
  assert.equal(none.stats, '');
  assert.match(none.active, /لا توجد طلبات جارية الآن\.<a href="\/">تصفّح العطور<\/a>/, 'an empty list points back to the shop');
  assert.match(none.recent, /لم تصلك طلبات بعد/);

  const one = render([order({ status: 'processing' })]);
  assert.equal(one.headline, 'عندك طلب واحد قيد المتابعة.');
  assert.equal(one.count, 'طلب واحد');
  assert.equal(render([order({ status: 'shipped' })]).headline, 'طلبك في الطريق إليك.');
  assert.equal(render([order({ id: 'a' }), order({ id: 'b', status: 'processing' })]).headline, 'عندك طلبان قيد المتابعة.');
  assert.equal(render([1, 2, 3].map(n => order({ id: `x${n}` }))).headline, 'عندك 3 طلبات قيد المتابعة.');

  const mixed = render([order({ id: 'a' }), order({ id: 'b', status: 'delivered' }), order({ id: 'c', status: 'delivered' }), order({ id: 'd', status: 'store_cancelled' })]);
  assert.equal(mixed.count, '4 طلبات');
  assert.deepEqual([...mixed.stats.matchAll(/<b>(\d+)<\/b> ([^<]+)</g)].map(match => `${match[1]} ${match[2]}`), ['1 جارية', '2 وصلت', '1 ملغاة']);
  const allDone = render([order({ status: 'delivered' })]);
  assert.match(allDone.headline, /وصلتك كل طلباتك/);
  assert.equal(allDone.stats.includes('جارية'), false, 'a count of zero is not shown');
  assert.match(render([order({ status: 'store_cancelled' })]).headline, /لا توجد طلبات جارية الآن/);
});

test('every value in the new cards is escaped (store, number, items, shipment, notes)', () => {
  const p = load();
  const evil = '<img src=x onerror=alert(1)>';
  const shipment = { carrier_name: evil, tracking_code: evil, shipping_status: 'in_transit', status_note: evil, updated_at: '2026-11-10T08:00:00Z' };
  for (const status of ['shipped', 'delivered']) {
    const markup = card(p, order({ status, tracking_number: evil, stores: { name: evil }, merchant_order_number: evil, merchant_invoice_number: evil, store_shipments: [shipment],
      store_order_request_items: [{ product_name: evil, brand_name: evil, size_label: evil, product_size_id: null, quantity: 1, line_total: 1 }, { product_name: evil, quantity: 1 }, { product_name: evil, quantity: 1 }, { product_name: evil, quantity: 1 }] }));
    assert.equal(markup.includes('<img'), false, status);
  }
});

test('account.html is the new page: its own sheet and wordmark, the same ids the script drives, and none of the old summary', () => {
  assert.match(html, /<body class="acct">/);
  assert.equal((html.match(/<link rel="stylesheet" href="\/account\.css\?v=[\w-]+">/g) || []).length, 1);
  assert.ok(html.indexOf('/account.css') > html.indexOf('/portal.css'), 'the page sheet comes after the shared one so it wins');
  assert.match(html, /<h1 class="acct-h1">طلباتي<\/h1>/);
  assert.match(html, /THE HOME OF GULF FRAGRANCES/);
  for (const id of ['login', 'loginForm', 'app', 'appMessage', 'ordersHeadline', 'ordersCount', 'stats', 'refreshOrders', 'lastUpdated', 'activeOrders', 'recentOrders', 'loadMoreOrders', 'archiveForm', 'archiveSearch', 'archiveYear', 'archiveOrders', 'loadMoreArchive', 'cartShortcut', 'logout']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal(html.includes('orders-welcome'), false);
  assert.equal(html.includes('مساحة مختصرة'), false);
  assert.ok(html.indexOf('<header') < html.indexOf('<main'), 'the first <header> is the top bar: the notification bell is added to it by portal.js');
  assert.equal((html.match(/<header/g) || []).length, 1);
  assert.ok(html.indexOf('id="cartShortcut"') < html.indexOf('<main'), 'the cart link is in the top bar, not floating over the orders');
  assert.match(html, /<footer class="acct-foot">\s*<p class="privacy-links"><a href="\/privacy\.html">[^<]+<\/a><\/p>\s*<\/footer>/);
});

test('account.css keeps the identity of the shop, is served as an immutable shared file, and touches nothing outside this page', () => {
  assert.match(css, /#c8962a/);
  assert.match(css, /IBM Plex Sans Arabic/);
  assert.match(css, /El Messiri/);
  assert.match(css, /Playfair Display/);
  const vercel = JSON.parse(read('vercel.json'));
  const immutable = vercel.headers.find(rule => rule.headers.some(header => /immutable/.test(header.value)) && /portal\.css/.test(rule.source));
  assert.ok(immutable && /\|account\.css\|/.test(immutable.source), 'account.css is on the immutable list (asset-manifest.json carries its fingerprint)');
  assert.ok(JSON.parse(read('asset-manifest.json')).files['account.css'] || JSON.parse(read('asset-manifest.json'))['account.css'], 'its fingerprint is recorded');
  // every selector starts with body.acct (portal.css is shared with the dashboards; this sheet is loaded by one page, but a loose rule would still be a trap)
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const loose = [];
  for (const match of rules.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith('@') || /^(\d+%|from|to)(\s*,\s*(\d+%|from|to))*$/.test(selector)) continue;
    for (const part of selector.split(',')) if (!part.trim().startsWith('body.acct')) loose.push(part.trim());
  }
  assert.deepEqual(loose, []);
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/, 'no outside file is loaded by the sheet');
  assert.match(css, /prefers-reduced-motion/, 'the pulse of the current step respects reduced motion');
});
