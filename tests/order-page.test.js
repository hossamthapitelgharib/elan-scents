// The storefront's order page (order-page.js), steps 2 to 6 of docs/purchase-flow-final.ar.md. The real file runs in a VM with a small page
// stub, a fake clock for its timers and a scripted server; no network, no real customer.
// It checks: what the page shows (the order's own tracking number, the store, the lines numbered in the database's order, shipping decided by the
// store, the account's details as fields the customer can edit with name and email locked), that «موافق» saves those details to «حسابي» first and
// only then sends the order (the store, a draft-bound retry key, the total shown and the draft: nothing else), that a bad field or a failed save
// stops everything, that "إلغاء" throws the edits away and saves nothing, what each answer of the store looks like (waiting, refused with its reason,
// no answer, approved with no Élan countdown, cancelled by closing the window, verifying, confirmed), that the payment window is opened from the
// click itself, and that nothing from the catalog or the store reaches the page unescaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const core = read('app-core.js');
const orderPage = read('order-page.js');
const coreLines = core.split('\n');
const coreLine = (prefix) => { const found = coreLines.filter((l) => l.startsWith(prefix)); assert.equal(found.length, 1, prefix); return found[0]; };
const ACCT_START = '/* ===== «حسابي»', ACCT_END = '/* ===== end of «حسابي» ===== */';
const ACCT_BLOCK = core.slice(core.indexOf(ACCT_START), core.indexOf(ACCT_END) + ACCT_END.length);
const CORE_SOURCE = [coreLine('function esc('), coreLine('function authUserId'), coreLine('function authHeaders'), coreLine('var ORDER_UI='), coreLine('var ORDER_ERRORS='), coreLine('function orderErrorKey('), ACCT_BLOCK].join('\n');
const ACCT_REST = 'https://project.example.invalid/rest/v1/customer_details';
const ACCT_ROW = { user_id: 'user-1', full_name: 'احمد محمد علي حسن', phone: '01012345678', governorate: 'القاهرة', city: 'مدينة نصر', address: 'شارع التحرير', building_no: '5', floor_no: '3', apartment_no: '7',
  ship_same: true, ship_governorate: 'القاهرة', ship_city: 'مدينة نصر', ship_address: 'شارع التحرير', ship_building_no: '5', recipient_name: 'سارة', recipient_phone: '01100000000', delivery_notes: 'الدور الثالث' };
const FIELD_NAMES = ['full_name', 'phone', 'email', 'governorate', 'city', 'address', 'building_no', 'floor_no', 'apartment_no', 'address_lat', 'address_lng', 'ship_same', 'ship_governorate', 'ship_city', 'ship_address',
  'ship_building_no', 'ship_floor_no', 'ship_apartment_no', 'ship_lat', 'ship_lng', 'recipient_name', 'recipient_phone', 'delivery_notes'];

// a stand-in for the details form: the controls the page reads and writes, with the errors it puts under them
function makeForm(row, email) {
  const elements = [], errors = [], form = { elements, errors, focused: '' };
  for (const name of FIELD_NAMES) {
    const el = name === 'ship_same' ? { name, type: 'checkbox', checked: row.ship_same !== false } : { name, type: 'text', value: name === 'email' ? email : row[name] == null ? '' : String(row[name]) };
    el.focus = () => { form.focused = name; };
    el.closest = () => ({ appendChild: (node) => errors.push({ field: name, text: node.textContent }), querySelector: () => null });
    elements.push(el); elements[name] = el;
  }
  form.querySelectorAll = () => [];
  return form;
}

const STORE_ID = 'c0ffee00-0000-4000-8000-000000000001';
const DRAFT = { ok: true, draftId: '11111111-2222-4333-8444-555555555555', trackingNumber: 'ELN-20261118-000321', expiresAt: '2099-01-01T00:00:00Z' };
const SP_A = '0a000000-0000-4000-8000-00000000000a';
const SP_B = '5b000000-0000-4000-8000-00000000000b';
const SP_C = 'f0000000-0000-4000-8000-00000000000c';

function cartRows(extra = {}) {
  // deliberately NOT in byte order of the store product id
  return [
    { c: { sid: 'size-c', q: 1 }, p: { name: 'Third', brand: 'Brand', sz: '50 ml' }, b: { store: 'Afnan Egypt', storeId: STORE_ID, storeProductId: SP_C, price: 300, cur: 'EGP', stock: 5 } },
    { c: { sid: 'size-a', q: 2 }, p: { name: 'First', brand: 'Brand', sz: '100 ml' }, b: { store: 'Afnan Egypt', storeId: STORE_ID, storeProductId: SP_A, price: 150.5, cur: 'EGP', stock: 2 }, ...extra },
    { c: { sid: 'size-b', q: 1 }, p: { name: 'Second', brand: 'Other', sz: '' }, b: { store: 'Afnan Egypt', storeId: STORE_ID, storeProductId: SP_B, price: 80, cur: 'EGP', stock: null } }
  ];
}

function setup({ rows = cartRows(), routes = {}, auth = { access_token: 'tok', user: { id: 'user-1', email: 'buyer@example.invalid' } }, flush = true, acct = ACCT_ROW } = {}) {
  const calls = [], timers = [], sheetCalls = [], opened = [], listeners = {};
  const box = { hidden: true, textContent: '' };
  const form = makeForm(acct, 'buyer@example.invalid');
  const sheetB = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, querySelector: (s) => (s === '.op-error' ? box : s === '[data-op-form]' ? form : null), querySelectorAll: () => [] };
  const sheetEl = { hidden: true, dataset: {} };
  const context = {
    console, JSON, Date, Math, String, Number, Promise, Error, TypeError, Array, Object, encodeURIComponent, Intl,
    lang: 'ar', AUTH: auth, ST: [['Afnan Egypt', 'x', STORE_ID]], isFinite, RegExp, SB: { url: 'https://project.example.invalid', key: 'anon-key' }, LB: { ar: { notin: 'x' }, en: { notin: 'x' } }, PENDING_STORE: '',
    closeSheet: () => {}, showOrderForm: () => {},
    cartGroups: () => ({ [STORE_ID]: rows }),
    sheetX: () => '<button data-close></button>',
    sheet: (k) => { sheetCalls.push(k); sheetEl.dataset.kind = k; },
    toast: () => {}, loadData: () => calls.push({ url: 'loadData' }),
    reconcileCart: () => false, cartFlush: async () => { calls.push({ url: 'flush' }); return flush; },
    cartQty: (spec, keep) => { calls.push({ url: 'cartQty', spec }); if (typeof keep === 'function') keep(); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: context.__now + (ms || 0), alive: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].alive = false; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: ms, at: context.__now + ms, alive: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].alive = false; },
    __now: 0,
    document: {
      body: { classList: { add() {} } },
      createElement: () => ({ setAttribute() {}, remove() {}, textContent: '', className: '' }),
      getElementById: (id) => (id === 'sheet' ? sheetEl : id === 'sheetB' ? sheetB : null),
      addEventListener: (type, fn) => { listeners[type] = fn; }
    },
    ElanPay: { open: (options) => { opened.push(options); return { close() {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const key = String(url).startsWith(ACCT_REST) ? (options.method === 'POST' ? 'acct:save' : 'acct:load') : String(url);
      const defaults = { 'acct:load': { body: [acct] }, 'acct:save': { body: [] } };
      const route = routes[key] || defaults[key];
      if (!route) throw new Error('unexpected request ' + url);
      const r = typeof route === 'function' ? await route(options, calls.filter((c) => c.url === String(url)).length) : route;
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CORE_SOURCE, context);
  context.acctWithin = (p) => p; // the real helper races a timer; the page's own fake clock must stay free of it
  context.openAccount = (next, edit) => { calls.push({ url: 'openAccount', next, edit }); }; // only the call is checked, not the sheet it draws
  vm.runInContext(orderPage, context, { filename: 'order-page.js' });
  const click = (attrs) => {
    // a click on an element that sits inside the thing carrying the given data attribute
    const target = { closest: (sel) => { const m = /^\[data-([a-z-]+)\]$/.exec(sel); const key = m && m[1]; return key && Object.prototype.hasOwnProperty.call(attrs, key) ? { dataset: { opQ: attrs[key] } } : null; } };
    listeners.click({ target, preventDefault() {} });
  };
  // run every due timer once (a slice of fake time)
  const advance = async (ms) => {
    context.__now += ms;
    for (const t of timers.slice()) { if (t.alive && t.at <= context.__now) { if (t.every) t.at += t.every; else t.alive = false; await t.fn(); } }
    await new Promise((r) => setImmediate(r));
  };
  const flushAsync = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  return { context, calls, timers, sheetCalls, opened, box, form, sheetB, sheetEl, click, advance, flushAsync, html: () => sheetB.innerHTML, page: () => context.ElanOrderPage };
}

const draftOk = { '/api/order-draft': { body: DRAFT } };
const state = (over) => ({ ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, status: 'awaiting_store_confirmation', paymentStatus: 'not_started', cancelReason: null, failureReason: null, delivery: { state: 'pending', attempts: 1, maxAttempts: 6 }, window: null, ...over });

async function opened(extra = {}) {
  const env = setup(extra);
  env.page().show(STORE_ID);
  await env.flushAsync();
  return env;
}

test('opening the page reserves a draft for this store and shows the order exactly as it will be', async () => {
  const env = await opened({ routes: draftOk });
  const draftCall = env.calls.find((c) => c.url === '/api/order-draft');
  assert.ok(draftCall, 'the draft is reserved first');
  assert.equal(draftCall.options.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(draftCall.options.body), { storeId: STORE_ID }, 'only the store is sent');
  assert.equal(env.sheetEl.hidden, false);
  assert.equal(env.sheetEl.dataset.kind, 'order');
  const html = env.html();
  assert.ok(html.includes(DRAFT.trackingNumber), "the order's own number is on the page");
  assert.ok(html.includes('Afnan Egypt'), 'the store is shown by name, never by id');
  assert.doesNotMatch(html, new RegExp('>[^<]*' + STORE_ID), 'the store id is never shown as text');
  assert.match(html, /data-op-time/, 'the date and time are on the page and kept current');
  assert.ok(html.includes('يحدده المتجر في نافذة الدفع'), 'the shipping is decided by the store inside its payment window');
  assert.doesNotMatch(html, /يُحدَّد لاحقًا/, 'no "later": the store does it in the window');
  assert.ok(env.calls.some((c) => c.url.startsWith(ACCT_REST) && !c.options.method), '«حسابي» is read again every time the page opens');
  assert.match(html, /<form class="acct-form op-form" data-op-form novalidate>/, 'the details are a form the customer can edit');
  assert.doesNotMatch(html, /data-acct-form|data-acct-edit/, 'it is not the «حسابي» sheet and does not send the customer there');
  assert.match(html, /name="phone"[^>]*value="01012345678"/, 'the saved phone is in its field');
  assert.match(html, /name="recipient_name"[^>]*value="سارة"/, 'the other recipient is in its fields');
  assert.match(html, /name="full_name"[^>]*value="احمد محمد علي حسن"[^>]*readonly/, 'the name is locked');
  assert.match(html, /name="email"[^>]*readonly[^>]*value="buyer@example.invalid"/, 'the email is locked');
  assert.match(html, /<textarea name="delivery_notes"[^>]*>الدور الثالث<\/textarea>/, 'the delivery notes are editable');
  assert.match(html, /name="ship_same" checked/, 'the shipping address follows the address');
  assert.match(html, /data-op-approve[^>]*>موافق</);
  assert.match(html, /data-op-cancel[^>]*>إلغاء</);
});

test('the lines carry the numbers the database gives them: the tracking number, then -01, -02 ..., in byte order of the store product id', async () => {
  const env = await opened({ routes: draftOk });
  const numbers = [...env.html().matchAll(/<span class="op-no"[^>]*>([^<]+)<\/span><div class="op-name"><b>([^<]+)<\/b>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(numbers, [[DRAFT.trackingNumber + '-01', 'First'], [DRAFT.trackingNumber + '-02', 'Second'], [DRAFT.trackingNumber + '-03', 'Third']]);
  // the totals: 2 x 150.5 + 80 + 300 = 681 (before shipping)
  assert.ok(env.html().includes('681 ج.م'), 'the total is the sum of the lines');
  assert.ok(env.html().includes('301 ج.م'), 'a line total is price times quantity');
});

test('only the quantity can be changed, within the stock, and it goes through the cart', async () => {
  const env = await opened({ routes: draftOk });
  // First has stock 2 and quantity 2: "+" is disabled; "-" is available. Second has quantity 1: "-" is disabled.
  assert.match(env.html(), /data-op-q="size-a\|1"[^>]*disabled/);
  assert.doesNotMatch(env.html(), /data-op-q="size-a\|-1"[^>]*disabled/);
  assert.match(env.html(), /data-op-q="size-b\|-1"[^>]*disabled/);
  env.click({ 'op-q': 'size-a|-1' });
  const q = env.calls.find((c) => c.url === 'cartQty');
  assert.equal(q.spec, 'size-a|-1');
});

test('a hostile product, store or account value never reaches the page as markup', async () => {
  const bad = '<img src=x onerror=alert(1)>"\'&';
  const rows = cartRows();
  rows[1].p.name = bad; rows[1].p.brand = bad; rows[1].b.store = bad;
  const hostile = { ...ACCT_ROW, full_name: bad, phone: bad, city: bad, address: bad, ship_address: bad, building_no: bad, recipient_name: bad, recipient_phone: bad, delivery_notes: bad };
  const env = await opened({ rows, acct: hostile, routes: draftOk });
  assert.doesNotMatch(env.html(), /<img/i);
  assert.ok(env.html().includes('&lt;img'), 'it is shown, as text');
  assert.doesNotMatch(env.html(), /value="[^"]*"[^>]*onerror/i, 'a quote in a value cannot open a new attribute');
});

test('«إلغاء» goes back to the cart and places nothing; the draft is not an order', async () => {
  const env = await opened({ routes: draftOk });
  env.click({ 'op-cancel': '' });
  assert.equal(env.sheetCalls.at(-1), 'cart');
  assert.equal(env.calls.some((c) => c.url === '/api/place-store-order'), false);
  assert.equal(env.calls.some((c) => c.url === '/api/customer-order-review'), false);
});

test('a store that is not connected gets "غير متاح حاليًا" and no order button', async () => {
  const env = await opened({ routes: { '/api/order-draft': { status: 409, body: { ok: false, error: 'store_not_connected' } } } });
  assert.ok(env.html().includes('غير متاح حاليًا'));
  assert.doesNotMatch(env.html(), /data-op-approve/);
  assert.match(env.html(), /data-back-cart/, 'the cart is one tap away and was not touched');
});

test('without a sign-in nothing is requested and the customer is told so', async () => {
  const env = await opened({ auth: null, routes: {} });
  assert.equal(env.calls.length, 0);
  assert.ok(env.html().includes(env.context.ORDER_UI.ar.eAuth));
});

test('«موافق» saves the details to «حسابي», then the cart, then sends only the store, a key bound to the draft, the total shown and the draft', async () => {
  const placed = { ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, state: state() };
  const env = await opened({ routes: { ...draftOk, '/api/place-store-order': { body: placed }, '/api/customer-order-review': { body: state() } } });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  const names = env.calls.map((c) => (c.url.startsWith(ACCT_REST) && c.options.method === 'POST' ? 'acct:save' : c.url));
  assert.ok(names.includes('acct:save'), 'the details are saved to «حسابي»');
  assert.ok(names.indexOf('acct:save') < names.indexOf('flush') && names.indexOf('flush') < names.indexOf('/api/place-store-order'), '«حسابي» first, then the cart, then the order');
  const sent = JSON.parse(env.calls.find((c) => c.url === '/api/place-store-order').options.body).payload;
  assert.deepEqual(sent, { storeId: STORE_ID, idempotencyKey: 'd-11111111222243338444555555555555', expectedSubtotal: 681, draftId: DRAFT.draftId });
  for (const forbidden of ['customer', 'items', 'lines', 'unitPrice', 'currency', 'trackingNumber', 'shipping']) assert.equal(forbidden in sent, false, `the browser does not send ${forbidden}`);
  assert.ok(env.html().includes('جارٍ إرسال طلبك إلى المتجر'), 'now waiting for the store');
  assert.match(env.html(), /المحاولة 1 من 6/);
  assert.doesNotMatch(env.html(), /data-op-approve|data-op-cancel/, 'no customer cancel button once the order is placed');
});

test('the customer can edit the details here; they are saved to «حسابي» only at «موافق», and the order is then built from them', async () => {
  const placedBody = { ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, state: state() };
  const env = await opened({ routes: { ...draftOk, '/api/place-store-order': { body: placedBody }, '/api/customer-order-review': { body: state() } } });
  env.form.elements.phone.value = '٠١٠٩٩٩٩٨٨٨٨';
  env.form.elements.recipient_name.value = 'منى سيد';
  env.form.elements.delivery_notes.value = 'اتصل قبل الوصول';
  assert.equal(env.calls.some((c) => c.url.startsWith(ACCT_REST) && c.options.method === 'POST'), false, 'typing writes nothing');
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  const save = env.calls.find((c) => c.url.startsWith(ACCT_REST) && c.options.method === 'POST');
  assert.ok(save.url.endsWith('?on_conflict=user_id'));
  assert.equal(save.options.headers.Authorization, 'Bearer tok', 'saved with the customer\'s own token');
  const body = JSON.parse(save.options.body);
  assert.equal(body.user_id, 'user-1');
  assert.equal(body.phone, '01099998888', 'Arabic digits are normalised like in «حسابي»');
  assert.equal(body.recipient_name, 'منى سيد');
  assert.equal(body.delivery_notes, 'اتصل قبل الوصول');
  assert.equal(body.full_name, 'احمد محمد علي حسن', 'the name is the account\'s');
  const sent = JSON.parse(env.calls.find((c) => c.url === '/api/place-store-order').options.body).payload;
  for (const forbidden of ['phone', 'recipient_name', 'delivery_notes', 'address']) assert.equal(forbidden in sent, false, `the order request carries no ${forbidden}: the server reads the saved account`);
});

test('what the customer typed survives a change of quantity (the page redraws) and is shown again', async () => {
  const env = await opened({ routes: draftOk });
  env.form.elements.phone.value = '01155554444';
  env.form.elements.ship_same.checked = false;
  env.form.elements.ship_city.value = 'المعادي';
  env.click({ 'op-q': 'size-a|-1' });
  await env.flushAsync();
  assert.match(env.html(), /name="phone"[^>]*value="01155554444"/, 'the edited phone is still there');
  assert.doesNotMatch(env.html(), /name="ship_same" checked/, 'the unticked box is still unticked');
  assert.match(env.html(), /name="ship_city"[^>]*value="المعادي"/);
  assert.equal(env.calls.some((c) => c.url.startsWith(ACCT_REST) && c.options.method === 'POST'), false, 'still nothing saved');
});

test('«إلغاء» throws the edits away: nothing is saved, nothing is sent, and the next visit shows «حسابي» as it was', async () => {
  const env = await opened({ routes: draftOk });
  env.form.elements.phone.value = '01155554444';
  env.click({ 'op-cancel': '' });
  assert.equal(env.sheetCalls.at(-1), 'cart');
  assert.equal(env.page().state().edits, null, 'the edits are gone');
  assert.equal(env.calls.some((c) => c.url.startsWith(ACCT_REST) && c.options.method === 'POST'), false, 'no write to «حسابي»');
  env.form.elements.phone.value = '01012345678';
  env.page().show(STORE_ID);
  await env.flushAsync();
  assert.match(env.html(), /name="phone"[^>]*value="01012345678"/, 'the old phone, not the discarded one');
});

test('what was saved in «حسابي» is what the page shows: it is read again each time, so a change made there shows up here', async () => {
  const env = await opened({ routes: draftOk });
  assert.match(env.html(), /name="phone"[^>]*value="01012345678"/);
  env.context.ACCT = { ...ACCT_ROW, phone: '01222223333', recipient_name: 'هدى' };
  const env2 = await opened({ routes: draftOk, acct: { ...ACCT_ROW, phone: '01222223333', recipient_name: 'هدى' } });
  assert.match(env2.html(), /name="phone"[^>]*value="01222223333"/);
  assert.match(env2.html(), /name="recipient_name"[^>]*value="هدى"/);
});

test('a wrong detail stops «موافق» before anything is saved or sent, says which one, and keeps what was typed', async () => {
  const cases = [['phone', '12345', 'ePhone'], ['city', 'ا', 'eCity'], ['address', 'abc', 'eAddr'], ['building_no', '', 'eBld'], ['governorate', 'مدينة وهمية', 'eGov']];
  for (const [field, value, key] of cases) {
    const env = await opened({ routes: draftOk });
    env.form.elements[field].value = value;
    env.form.elements.delivery_notes.value = 'اتصل بي';
    env.click({ 'op-approve': '' });
    await env.flushAsync();
    assert.equal(env.form.errors.length, 1, field);
    assert.deepEqual(env.form.errors[0], { field, text: vm.runInContext(`ACCT_UI.ar.${key}`, env.context) }, field);
    assert.equal(env.form.focused, field, 'the wrong field takes the focus');
    assert.equal(env.calls.some((c) => (c.url.startsWith(ACCT_REST) && c.options.method === 'POST') || c.url === 'flush' || c.url === '/api/place-store-order'), false, `${field}: nothing saved, nothing sent`);
    assert.equal(env.form.elements.delivery_notes.value, 'اتصل بي', 'what the customer typed is untouched');
  }
});

test('when the details cannot be saved the order is not sent, the page stays, and the reason is told', async () => {
  const cases = [[{ status: 500, body: {} }, 'eSave'], [{ status: 401, body: {} }, 'eAuth'], [async () => { throw new TypeError('offline'); }, 'eNet']];
  for (const [route, key] of cases) {
    const env = await opened({ routes: { ...draftOk, 'acct:save': route, '/api/place-store-order': { body: { ok: true } } } });
    env.click({ 'op-approve': '' });
    await env.flushAsync();
    assert.equal(env.calls.some((c) => c.url === 'flush' || c.url === '/api/place-store-order'), false, `${key}: nothing goes to the store`);
    assert.equal(env.box.textContent, vm.runInContext(`ACCT_UI.ar.${key}`, env.context), key);
    assert.equal(env.box.hidden, false);
    assert.match(env.html(), /data-op-approve/, 'the page is still there and can be tried again');
    assert.equal(env.page().state().busy, false, 'the buttons are free again');
  }
});

test('an account that is not complete (or cannot be read) does not open an empty order page', async () => {
  const incomplete = await opened({ acct: { ...ACCT_ROW, address: '' }, routes: draftOk });
  assert.deepEqual(incomplete.calls.find((c) => c.url === 'openAccount'), { url: 'openAccount', next: STORE_ID, edit: true }, 'the customer is sent to «حسابي» to complete it');
  assert.doesNotMatch(incomplete.html(), /data-op-approve/);
  const unreadable = await opened({ routes: { ...draftOk, 'acct:load': { status: 500, body: {} } } });
  assert.doesNotMatch(unreadable.html(), /data-op-approve/, 'no page built on details that could not be read');
  assert.match(unreadable.html(), /data-op-retry/);
});

test('a second tap while the order is being sent sends nothing more', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await opened({ routes: { ...draftOk, '/api/place-store-order': async () => { await gate; return { body: { ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, state: state() } }; } } });
  env.click({ 'op-approve': '' });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  release();
  await env.flushAsync();
  assert.equal(env.calls.filter((c) => c.url === '/api/place-store-order').length, 1);
});

test('a refusal of the order keeps the page, shows the clear message and keeps the cart', async () => {
  const cases = [['price_changed', 'ePrice'], ['stock_unavailable', 'eStock'], ['account_incomplete', 'eAcct'], ['cart_empty', 'eEmpty'], ['unauthorized', 'eAuth'], ['order_rate_limited', 'eMany'], ['something_else', 'eGen']];
  for (const [error, key] of cases) {
    const env = await opened({ routes: { ...draftOk, '/api/place-store-order': { status: 400, body: { ok: false, error } } } });
    env.click({ 'op-approve': '' });
    await env.flushAsync();
    assert.equal(env.box.textContent, env.context.ORDER_UI.ar[key], error);
    assert.equal(env.box.hidden, false);
    assert.match(env.html(), /data-op-approve/, 'the page is still there');
    assert.equal(env.calls.some((c) => c.url === 'loadData'), key === 'ePrice' || key === 'eStock', 'prices and stock are reloaded after a price or stock refusal');
  }
});

test('an expired order page says so and keeps the cart; the customer refreshes it', async () => {
  const env = await opened({ routes: { ...draftOk, '/api/place-store-order': { status: 409, body: { ok: false, error: 'order_page_expired' } } } });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  assert.equal(env.box.textContent, env.page().strings.ar.eExpired);
});

test('when the cart cannot be saved to the account the order is not sent', async () => {
  const env = await opened({ flush: false, routes: { ...draftOk, '/api/place-store-order': { body: { ok: true } } } });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  assert.equal(env.calls.some((c) => c.url === '/api/place-store-order'), false);
  assert.equal(env.box.textContent, env.context.ORDER_UI.ar.eNet);
});

async function placed(answer, extra = {}) {
  const review = { ...extra.review };
  const env = await opened({
    routes: {
      ...draftOk,
      '/api/place-store-order': { body: { ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, state: state() } },
      '/api/customer-order-review': async () => ({ body: typeof answer === 'function' ? answer() : answer })
    }
  });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  return { env, review };
}

test('the page polls the order every few seconds while the store has not answered', async () => {
  const { env } = await placed(state({ delivery: { state: 'sending', attempts: 2, maxAttempts: 6 } }));
  const before = env.calls.filter((c) => c.url === '/api/customer-order-review').length;
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.calls.filter((c) => c.url === '/api/customer-order-review').length > before, 'a poll was made');
  const poll = env.calls.filter((c) => c.url === '/api/customer-order-review').at(-1);
  assert.deepEqual(JSON.parse(poll.options.body), { orderId: 'order-1' });
  assert.match(env.html(), /المحاولة 2 من 6/);
});

test('the store refused: its reason is shown (escaped) and the products are still in the cart', async () => {
  const { env } = await placed(state({ status: 'store_rejected', failureReason: 'نفد <b>المخزون</b>' }));
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.html().includes('اعتذر المتجر عن تنفيذ طلبك'));
  assert.ok(env.html().includes('نفد &lt;b&gt;المخزون&lt;/b&gt;'));
  assert.ok(env.html().includes('منتجاتك ما زالت في سلتك'));
  assert.match(env.html(), /data-back-cart/);
  assert.equal(env.timers.filter((t) => t.alive && !t.every).length, 0, 'polling stops at a final answer');
});

test('the store never answered: the exact apology, and the cart is kept', async () => {
  const { env } = await placed(state({ status: 'cancelled', cancelReason: 'store_unresponsive' }));
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.html().includes('نعتذر عن تنفيذ طلبك في الوقت الحالي، برجاء إعادة المحاولة بعد ساعة'));
});

test('closing the payment window cancels: "تم إلغاء المعاملة برغبة العميل", the cart is kept, and a cancelled order is never reopened', async () => {
  for (const why of ['payment_window_closed', 'payment_window_cancelled']) {
    const { env } = await placed(state({ status: 'cancelled', cancelReason: why }));
    await env.advance(3000);
    await env.flushAsync();
    assert.ok(env.html().includes('تم إلغاء المعاملة برغبة العميل'), why);
    assert.ok(env.html().includes('منتجاتك ما زالت في سلتك'));
    assert.doesNotMatch(env.html(), /data-op-pay/, 'no way to pay a cancelled order');
  }
  const { env: expired } = await placed(state({ status: 'cancelled', cancelReason: 'payment_window_expired' }));
  await expired.advance(3000);
  await expired.flushAsync();
  assert.ok(expired.html().includes('انتهت نافذة الدفع لدى المتجر'));
  assert.ok(!expired.html().includes('برغبة العميل'), 'the store ending its own window is not the customer\'s wish');
});

test('approved: the store accepted, there is no Élan countdown and «الدفع» opens the payment window from the click itself', async () => {
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued' } }));
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.html().includes('قبل المتجر طلبك'));
  assert.ok(env.html().includes('المتجر هو من يحدد ما في النافذة'), 'the window, its methods, its shipping cost, its total and its duration are the store\'s');
  assert.doesNotMatch(env.html(), /data-op-count|\d\d:\d\d|الوقت المتبقي|Time left/, 'no countdown of ours');
  assert.ok(env.html().includes('إغلاق نافذة الدفع قبل إتمام الدفع يلغي الطلب'));
  assert.doesNotMatch(env.html(), /data-op-cancel/, 'no cancel button for the customer');
  env.click({ 'op-pay': '' });
  assert.equal(env.opened.length, 1, 'the window is opened synchronously inside the click');
  assert.equal(env.opened[0].orderId, 'order-1');
  assert.ok(env.html().includes('نافذة الدفع مفتوحة'));
  assert.doesNotMatch(env.html(), /data-op-pay/, 'no second window while one is open');
});

test('a window the browser blocked is explained, and the customer can press «الدفع» again', async () => {
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued' } }));
  await env.advance(3000);
  await env.flushAsync();
  env.click({ 'op-pay': '' });
  env.opened[0].onError('popup_blocked');
  assert.ok(env.html().includes('اسمح للموقع بفتح النوافذ'));
  assert.match(env.html(), /data-op-pay/);
});

test('the customer came back from the window claiming success: the page says "verifying" and does not call the order paid', async () => {
  let phase = 0;
  const { env } = await placed(() => (phase === 0 ? state({ status: 'store_confirmed', delivery: null, window: { state: 'issued' } }) : state({ status: 'store_confirmed', delivery: null, window: { state: 'success_claimed' } })));
  await env.advance(3000);
  await env.flushAsync();
  env.click({ 'op-pay': '' });
  phase = 1;
  env.opened[0].onState({ state: 'success_claimed' });
  await env.flushAsync();
  assert.ok(env.html().includes('نؤكد طريقة الدفع'));
  assert.doesNotMatch(env.html(), /تم تأكيد طلبك/, 'a browser return proves nothing');
  assert.equal(env.timers.some((t) => t.alive && !t.every), true, 'it keeps polling for the neutral confirmation');
});

test('a payment the neutral confirmation proved (or cash on delivery) is shown as confirmed', async () => {
  for (const paymentStatus of ['paid', 'cod_selected']) {
    const { env } = await placed(state({ status: 'store_confirmed', paymentStatus, delivery: null, window: { state: 'success_claimed' } }));
    await env.advance(3000);
    await env.flushAsync();
    assert.ok(env.html().includes('تم تأكيد طلبك'), paymentStatus);
    assert.match(env.html(), /href="\/account\.html"/);
  }
});

test('an old server that still sends an expiry time changes nothing: the page never ends a window by its own clock', async () => {
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued', expiresAt: new Date(Date.now() - 1000).toISOString() } }));
  await env.advance(3000);
  await env.flushAsync();
  await env.advance(60000);
  await env.flushAsync();
  assert.ok(env.html().includes('قبل المتجر طلبك'), 'still the approved view');
  assert.match(env.html(), /data-op-pay/, 'the customer can still open the store\'s window: only the store or the provider ends it');
  assert.doesNotMatch(env.html(), /انتهت المهلة|انتهت مهلة/, 'no "time is up" of ours');
});

test('closing the sheet stops the polling and the clock (the server carries on without the page)', async () => {
  const { env } = await placed(state({ delivery: { state: 'sending', attempts: 1, maxAttempts: 6 } }));
  env.sheetEl.hidden = true;
  const before = env.calls.length;
  await env.advance(10000);
  await env.flushAsync();
  assert.equal(env.calls.length, before, 'no request after the sheet is closed');
});

test('which stores can take an order: only a store the server says is not connected is locked; unknown means "try"', async () => {
  const env = setup({ routes: { '/api/store-order-readiness': { body: { ok: true, stores: { [STORE_ID]: false, other: true } } } } });
  const page = env.page();
  assert.equal(page.ready(STORE_ID), true, 'before the answer arrives the button works');
  page.warm();
  await env.flushAsync();
  assert.equal(page.ready(STORE_ID), false);
  assert.equal(page.ready('other'), true);
  assert.equal(page.ready('never-seen'), true);
  const calls = env.calls.length;
  page.warm();
  await env.flushAsync();
  assert.equal(env.calls.length, calls, 'the answer is reused for a minute');
});

test('the cart button says "غير متاح حاليًا" and is disabled for a store that is not connected', () => {
  const cartHTML = coreLine('function cartHTML(');
  assert.match(cartHTML, /closed=!!\(window\.ElanOrderPage&&!ElanOrderPage\.ready\(items\[0\]\.b\.storeId\)\)/);
  assert.match(cartHTML, /\(closed\?u\.notNow:u\.execute\+' <span>→<\/span>'\)/);
  assert.match(cartHTML, /if\(window\.ElanOrderPage\)ElanOrderPage\.warm\(\)/);
});

test('the page has no inline handler, writes nothing to browser storage and never builds a number of its own', () => {
  assert.doesNotMatch(orderPage, /onclick=|onsubmit=|onchange=|<script/i);
  assert.doesNotMatch(orderPage, /localStorage|sessionStorage|indexedDB/, 'no copy of the order or the customer in the browser');
  assert.doesNotMatch(orderPage, /Math\.random|Date\.now\(\)\.toString/, 'the order number comes from the server');
  assert.doesNotMatch(orderPage, /confirm-store-order-purchase|customer_confirmed|request-store-order-cancellation|customer-order-payment/, 'no retired call');
  assert.match(orderPage, /document\.addEventListener\('click'/);
  assert.doesNotMatch(orderPage, /data-op-count|function clock|function remaining|function countText|timeUp/, 'no countdown or time limit of ours');
  // every place that puts server or catalog text into markup goes through esc()
  for (const m of orderPage.matchAll(/\+ (s\.failureReason|s\.trackingNumber|name|trk|x\.p\.name|x\.p\.brand|msg|text|title)\b/g)) {
    const around = orderPage.slice(Math.max(0, m.index - 12), m.index + m[0].length + 2);
    assert.match(around, /esc\(/, 'escaped: ' + m[0]);
  }
});

test('every message of the order page exists in Arabic and in English, with the same keys', () => {
  const env = setup({});
  const ar = Object.keys(env.page().strings.ar).sort();
  const en = Object.keys(env.page().strings.en).sort();
  assert.deepEqual(ar, en);
  for (const key of ['notNow', 'notNowWhy']) for (const l of ['ar', 'en']) assert.ok(vm.runInContext(`ORDER_UI.${l}.${key}`, env.context), `${l}.${key}`);
});

test('the sheet code of app-core hands «تنفيذ الطلب» to the order page and has no order form of its own any more', () => {
  assert.match(coreLine('function showOrderForm('), /ElanOrderPage\.show\(store\)/);
  assert.doesNotMatch(core, /sendStoreOrder|orderFormHTML|orderRows|data-store-order-form/);
  assert.match(coreLine('function cartQty('), /^function cartQty\(s,keep\)\{.*saveCart\(\);if\(typeof keep=='function'\)keep\(\);else sheet\('cart'\)\}$/);
  const html = read('index.html');
  assert.ok(html.indexOf('/pay-window.js') > -1 && html.indexOf('/pay-window.js') < html.indexOf('/order-page.js'), 'the shared window file loads first');
});
