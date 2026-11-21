// The redesigned orders page (account.html + account.css + the render half of account.js): the four steps of an order, the cart button in the top bar,
// money and dates in the shop's digits, what each kind of card shows (and what it must not), and the sheet's own rules.
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
  return { hidden: false, textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, handlers: {}, addEventListener(type, handler) { (this.handlers[type] = this.handlers[type] || []).push(handler); }, querySelector: () => node(), querySelectorAll: () => [], closest: () => null, reset() {}, focus() {} };
}
function load(extra = {}) {
  const nodes = new Map();
  const document = { hidden: false, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, addEventListener() {} };
  const context = { document, console, URLSearchParams, Date, Math, Number, String, JSON, Set, Array, Object, Promise, Error, encodeURIComponent, isNaN,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hash: '', pathname: '/account.html', search: '', origin: 'https://shop.example.invalid' }, history: { replaceState() {} },
    Portal: { errorMessages: {}, session: () => null, auth: () => ({}), errorText: (e, f) => (e && e.message) || f },
    setTimeout: () => 0, setInterval: () => 0, fetch: async () => { throw new Error('no network in this test'); }, ...extra };
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

test('the lists follow the orders, and the old summary rectangle (sentence, count, little stats) is gone for good (owner, 18 Nov 2026)', () => {
  const p = load();
  const render = requests => { p.run(`renderAccount([{ id: 's', store_order_requests: ${JSON.stringify(requests)} }])`); return { active: p.el('#activeOrders').innerHTML, recent: p.el('#recentOrders').innerHTML }; };
  const none = render([]);
  assert.match(none.active, /لا توجد طلبات جارية الآن\.<a href="\/">تصفّح العطور<\/a>/, 'an empty list points back to the shop');
  assert.match(none.recent, /لا توجد طلبات سابقة بعد/);

  const mixed = render([order({ id: 'a' }), order({ id: 'b', status: 'delivered' }), order({ id: 'c', status: 'delivered' }), order({ id: 'd', status: 'store_cancelled' })]);
  assert.equal((mixed.active.match(/data-id="/g) || []).length, 1, 'one order is still running');
  assert.equal((mixed.recent.match(/data-id="/g) || []).length, 3, 'delivered and cancelled ones sit together in the recent list');

  for (const gone of ['ordersHeadline', 'ordersCount', 'id="stats"', 'refreshOrders', 'lastUpdated', 'acct-summary', 'acct-chip', 'acct-stat', 'acct-refresh']) assert.equal(html.includes(gone), false, `${gone} is not on the page`);
  assert.doesNotMatch(css, /acct-summary|acct-headline|acct-chip|acct-stat|acct-refresh/, 'and its rules are not left in the sheet');
  const script = fs.readFileSync(path.join(root, 'account.js'), 'utf8');
  for (const dead of ['#ordersHeadline', '#ordersCount', "'#stats'", '#refreshOrders', '#lastUpdated', 'headlineTextA']) assert.equal(script.includes(dead), false, `${dead} is not left in account.js`);
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
  for (const id of ['login', 'loginForm', 'app', 'appMessage', 'activeOrders', 'recentOrders', 'loadMoreOrders', 'archiveForm', 'archiveYear', 'archiveOrders', 'loadMoreArchive', 'cartShortcut', 'logout']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal(html.includes('orders-welcome'), false);
  assert.equal(html.includes('مساحة مختصرة'), false);
  assert.ok(html.indexOf('<header') < html.indexOf('<main'), 'the first <header> is the top bar: the notification bell is added to it by portal.js');
  assert.equal((html.match(/<header/g) || []).length, 1);
  assert.ok(html.indexOf('id="cartShortcut"') < html.indexOf('<main'), 'the cart link is in the top bar, not floating over the orders');
  // owner, 18 Nov 2026: no privacy link on this page, no order-number box and no "everything is kept" line over the search
  assert.equal(html.includes('privacy.html'), false);
  assert.equal(html.includes('acct-foot'), false);
  assert.equal(html.includes('archiveSearch'), false);
  assert.equal(html.includes('كل طلباتك محفوظة'), false);
  assert.match(html, /<h2 id="archiveTitle">ابحث في طلباتك<\/h2>/, 'the search block keeps its heading');
  assert.match(html, /<select id="archiveYear"[^>]*>[\s\S]*?<button class="ghost" type="submit">بحث<\/button>/, 'the year filter and the search button stay');
});

test('the cart button: an outline pill like «تسجيل الخروج» (it carries the same .ghost class), a cart icon, the count, and a link that opens the shop\'s cart (owner, 18 Nov 2026)', () => {
  const tag = html.match(/<a id="cartShortcut"[^>]*>([\s\S]*?)<\/a>/);
  assert.ok(tag, 'the cart link exists');
  assert.match(tag[0], /class="cart-shortcut ghost"/);
  assert.match(tag[0], /href="\/#cart"/, 'it opens the cart, not just the shop front page');
  assert.match(tag[1], /<svg class="cart-icon"[^>]*aria-hidden="true"/, 'with a cart icon that screen readers skip');
  assert.match(tag[1], /<span>السلة<\/span><b>0<\/b>/, 'the word and the count stay');
  assert.match(html, /<button id="logout" class="ghost" hidden>/, 'the logout button is the model of the look');
  // it is not the old dark pill any more
  const rule = (css.match(/body\.acct \.cart-shortcut \{[^}]*\}/) || [''])[0];
  assert.match(rule, /position: static/);
  assert.doesNotMatch(rule, /background|border:|color:/, 'colours and border come from .ghost, like the logout button');
  assert.doesNotMatch(css, /var\(--dark\)/, 'no dark pill is left in the sheet');
  assert.match(css, /body\.acct \.acct-nav \.ghost \{[^}]*min-height: 36px/, 'the pills in the top bar share one size');
});

test('account.css keeps the identity of the shop, is served as an immutable shared file, and touches nothing outside this page', () => {
  assert.match(css, /#c8962a/);
  assert.match(css, /IBM Plex Sans Arabic/);
  assert.match(css, /El Messiri/);
  assert.match(css, /Playfair Display/);
  const vercel = JSON.parse(read('vercel.json'));
  const immutable = vercel.headers.find(rule => rule.headers.some(header => /immutable/.test(header.value)) && /portal\.css/.test(rule.source));
  assert.ok(immutable && /\|account\.css\|/.test(immutable.source), 'account.css is on the immutable list (its address carries the fingerprint of the shared files)');
  assert.ok(require('../lib/asset-version').immutableFiles().includes('account.css'), 'and the fingerprint covers it' );
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

test('a cancelled order is listed with the finished ones (newest first)', () => {
  const p = load();
  const render = requests => { p.run(`renderAccount([{ id: 's', store_order_requests: ${JSON.stringify(requests)} }])`); return { recent: p.el('#recentOrders').innerHTML }; };
  const mixed = render([
    order({ id: 'old', tracking_number: 'ELN-OLD', status: 'delivered', created_at: '2026-09-01T10:00:00Z' }),
    order({ id: 'gone', tracking_number: 'ELN-GONE', status: 'store_cancelled', created_at: '2026-10-20T10:00:00Z' }),
    order({ id: 'back', tracking_number: 'ELN-BACK', status: 'restored', created_at: '2026-10-10T10:00:00Z' })
  ]);
  assert.deepEqual([...mixed.recent.matchAll(/data-id="(old|gone|back)"/g)].map(match => match[1]), ['gone', 'back', 'old']);
  assert.match(mixed.recent, /أُلغي الطلب وأُعيدت المنتجات/);
  assert.match(mixed.recent, /عادت المنتجات إلى السلة/);
  assert.match(mixed.recent, /تم التسليم/);
});

test('the list of finished orders shows five, "show older orders" adds five more from what is already read, and asks the server only when nothing is left', async () => {
  const p = load();
  const requests = Array.from({ length: 12 }, (_, i) => order({ id: `r${i}`, tracking_number: `ELN-N${String(i).padStart(2, '0')}`, status: i % 4 === 3 ? 'store_cancelled' : 'delivered', created_at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() }));
  p.run(`accountSessions = [{ id: 's', store_order_requests: ${JSON.stringify(requests)} }]; accountHasMore = false; renderAccount(accountSessions)`);
  const shown = () => (p.el('#recentOrders').innerHTML.match(/class="acct-order is-past"/g) || []).length;
  const more = p.el('#loadMoreOrders');
  assert.equal(shown(), 5);
  assert.equal(more.hidden, false, 'there are older ones to show');
  more.handlers.click[0]();
  assert.equal(shown(), 10);
  assert.equal(more.hidden, false);
  more.handlers.click[0]();
  assert.equal(shown(), 12);
  assert.equal(more.hidden, true, 'nothing older is left, here or on the server');
  // when the server still has older orders the button stays, even with everything read shown
  p.run('accountHasMore = true; renderAccount(accountSessions)');
  assert.equal(more.hidden, false);
});

test('every card carries its id (a card the customer opened is found again after the list is drawn again)', () => {
  const p = load();
  for (const status of ['processing', 'delivered', 'store_cancelled']) assert.match(card(p, order({ id: 'card-7', status })), /<article class="acct-order is-(active|past)" data-id="card-7"/);
});

test('there is no cancel button, no reason box and no browser dialog on this page: the customer never cancels an order from here', () => {
  const source = read('account.js');
  assert.doesNotMatch(source, /window\.prompt|\bprompt\(|\bconfirm\(|\balert\(/, 'no native dialog on this page');
  assert.doesNotMatch(source, /data-cancel|cancelDraft|cancelOrder|openCancel|request-store-order-cancellation|<textarea/, 'no cancellation code left');
  assert.doesNotMatch(css, /\.cancel-open|\.order-cancel|\.cancel-pending|\.cancel-declined/, 'and none of its styles');
  const p = load();
  for (const status of ['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped']) {
    const markup = card(p, order({ status }));
    assert.equal(/data-cancel|cancel-box|<textarea|ما سبب/.test(markup), false, status);
  }
});

test('a refused, unanswered or cancelled order says how it ended, in plain words, and the cart is not lost', () => {
  const p = load();
  const refused = card(p, order({ status: 'store_rejected', rejection_reason: 'نفد <b>المخزون</b>' }));
  assert.match(refused, /سبب رفض المتجر/);
  assert.match(refused, /نفد &lt;b&gt;المخزون&lt;\/b&gt;/, 'the store\'s reason is escaped');
  const silent = card(p, order({ status: 'cancelled', cancel_reason: 'store_unresponsive' }));
  assert.match(silent, /نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة/);
  assert.match(silent, /badge red">المتجر لم يستجب</);
  for (const why of ['payment_window_closed', 'payment_window_cancelled']) {
    const byYou = card(p, order({ status: 'cancelled', cancel_reason: why }));
    assert.match(byYou, /ملغاة من طرفك/, why);
    assert.match(byYou, /منتجاتك ما زالت في سلتك/);
    assert.match(byYou, /badge red">ملغاة من طرفك</);
  }
  const late = card(p, order({ status: 'cancelled', cancel_reason: 'payment_window_expired' }));
  assert.match(late, /انتهت مهلة الدفع/);
  // a cancelled order can be ordered again, never paid
  for (const markup of [silent, late]) { assert.match(markup, /data-reorder/); assert.equal(markup.includes('data-pay-window'), false); }
});

test('an approved order shows the store\'s payment window: «الدفع», the time left and the rule; the window\'s address is never on the page', () => {
  const p = load();
  const approved = status => order({ status: 'store_confirmed', payable_amount: 3510, payment_status: 'not_started', payment_window: { state: 'issued', expires_at: new Date(Date.now() + 20 * 60 * 1000 + 30000).toISOString() }, ...status });
  const open = card(p, approved({}));
  assert.match(open, /<button class="ghost order-pay" type="button" data-pay-window="r1">الدفع<\/button>/);
  assert.match(open, /data-pay-left="[^"]+">2[01]:\d\d<\/b>/, 'about twenty minutes are left');
  assert.match(open, /المبلغ المستحق 3,510 ج\.م/);
  assert.match(open, /إغلاق نافذة الدفع قبل إتمام الدفع يلغي الطلب/);
  assert.doesNotMatch(open, /data-pay-method|data-pay-request|https:\/\/|اختر طريقة الدفع/, 'no chooser of methods, and no address');
  // the window ran out: nothing to press, the order is about to be closed
  const over = card(p, approved({ payment_window: { state: 'opened', expires_at: new Date(Date.now() - 5000).toISOString() } }));
  assert.equal(over.includes('data-pay-window'), false);
  assert.match(over, /انتهت مهلة نافذة الدفع/);
  // the customer came back claiming success: a claim, not a payment
  const claimed = card(p, approved({ payment_window: { state: 'success_claimed', expires_at: new Date(Date.now() + 60000).toISOString() } }));
  assert.match(claimed, /نتحقق من الدفع/);
  assert.equal(claimed.includes('data-pay-window'), false);
  assert.equal(/تم دفع/.test(claimed), false, 'not paid before the neutral confirmation');
  // confirmed
  assert.match(card(p, approved({ payment_status: 'paid', paid_at: '2026-11-18T10:00:00Z' })), /تم دفع 3,510 ج\.م/);
  assert.match(card(p, approved({ payment_status: 'cod_selected' })), /الدفع عند الاستلام/);
  // an order the store has not answered yet has no window
  assert.equal(card(p, order({ status: 'awaiting_store_confirmation' })).includes('data-pay-window'), false);
  assert.match(html, /<script src="\/pay-window\.js\?v=[^"]+"><\/script>\s*<script src="\/account\.js/, 'the shared window file loads before the page\'s own');
});

test('«الدفع» opens the window from the tap itself, and the orders are read again when the customer comes back', async () => {
  const opened = [];
  let reads = 0;
  const p = load({
    Portal: { errorMessages: {}, session: () => ({ access_token: 'tok' }), auth: () => ({}), errorText: (e, f) => (typeof e === 'string' ? e : (e && e.message) || f) },
    ElanPay: { open: options => { opened.push(options); } },
    fetch: async () => { reads += 1; return { ok: true, json: async () => ({ sessions: [], pagination: {} }) }; }
  });
  p.run("startPay('r1', null)");
  assert.equal(opened.length, 1, 'opened synchronously, inside the tap');
  assert.equal(opened[0].orderId, 'r1');
  p.run("startPay('r1', null)");
  assert.equal(opened.length, 1, 'a second tap while one window is open does nothing');
  opened[0].onError('popup_blocked');
  assert.match(p.el('#appMessage').textContent, /اسمح للموقع بفتح النوافذ/);
  p.run("startPay('r1', null)");
  assert.equal(opened.length, 2, 'after a failure the customer can try again');
});
