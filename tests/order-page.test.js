// The storefront's order page (order-page.js), steps 2 to 6 of docs/purchase-flow-final.ar.md. The real file runs in a VM with a small page
// stub, a fake clock for its timers and a scripted server; no network, no real customer.
// It checks: what the page shows (the order's own tracking number, the store, the lines numbered in the database's order, shipping "later",
// the account's details with name and email locked), what "موافق" sends (the store, a draft-bound retry key, the total shown and the draft: nothing
// else), that "إلغاء" only goes back to the cart, what each answer of the store looks like (waiting, refused with its reason, no answer,
// approved with the countdown, cancelled by closing the window, verifying, confirmed), that the payment window is opened from the click itself,
// and that nothing from the catalog or the store reaches the page unescaped.
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
const CORE_SOURCE = [coreLine('function esc('), coreLine('var ORDER_UI='), coreLine('var ORDER_ERRORS='), coreLine('function orderErrorKey(')].join('\n');

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

function setup({ rows = cartRows(), routes = {}, auth = { access_token: 'tok', user: { email: 'buyer@example.invalid' } }, flush = true } = {}) {
  const calls = [], timers = [], sheetCalls = [], opened = [], listeners = {};
  const box = { hidden: true, textContent: '' };
  const sheetB = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, querySelector: (s) => (s === '.op-error' ? box : null), querySelectorAll: () => [] };
  const sheetEl = { hidden: true, dataset: {} };
  const context = {
    console, JSON, Date, Math, String, Number, Promise, Error, TypeError, Array, Object, encodeURIComponent, Intl,
    lang: 'ar', AUTH: auth, ST: [['Afnan Egypt', 'x', STORE_ID]],
    cartGroups: () => ({ [STORE_ID]: rows }),
    sheetX: () => '<button data-close></button>',
    sheet: (k) => { sheetCalls.push(k); sheetEl.dataset.kind = k; },
    toast: () => {}, loadData: () => calls.push({ url: 'loadData' }),
    reconcileCart: () => false, cartFlush: async () => { calls.push({ url: 'flush' }); return flush; },
    cartQty: (spec, keep) => { calls.push({ url: 'cartQty', spec }); if (typeof keep === 'function') keep(); },
    acctMine: () => ({ full_name: 'احمد محمد علي حسن', phone: '01012345678', recipient_name: 'سارة', recipient_phone: '01100000000', delivery_notes: 'الدور الثالث' }),
    acctOrderPrefill: () => ({ name: 'احمد محمد علي حسن', phone: '01012345678', address: 'القاهرة، مدينة نصر، شارع التحرير، مبنى 5\nhttps://maps.example.invalid/x' }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, at: context.__now + (ms || 0), alive: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].alive = false; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, every: ms, at: context.__now + ms, alive: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].alive = false; },
    __now: 0,
    document: {
      body: { classList: { add() {} } },
      getElementById: (id) => (id === 'sheet' ? sheetEl : id === 'sheetB' ? sheetB : null),
      addEventListener: (type, fn) => { listeners[type] = fn; }
    },
    ElanPay: { open: (options) => { opened.push(options); return { close() {} }; } },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const route = routes[String(url)];
      if (!route) throw new Error('unexpected request ' + url);
      const r = typeof route === 'function' ? await route(options, calls.filter((c) => c.url === String(url)).length) : route;
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(CORE_SOURCE, context);
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
  return { context, calls, timers, sheetCalls, opened, box, sheetB, sheetEl, click, advance, flushAsync, html: () => sheetB.innerHTML, page: () => context.ElanOrderPage };
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
  assert.ok(html.includes('يُحدَّد لاحقًا'), 'the shipping is "set later"');
  assert.ok(html.includes('buyer@example.invalid') && html.includes('احمد محمد علي حسن'), 'the account name and email are shown');
  assert.match(html, /class="op-lock"/, 'name and email are marked locked');
  assert.ok(html.includes('سارة - 01100000000'), 'the other recipient is shown');
  assert.ok(!html.includes('maps.example.invalid'), 'only the first line of the address is shown, never the map link');
  assert.doesNotMatch(html, /<input|<textarea|<select/, 'nothing to type: the customer details are changed in «حسابي»');
  assert.match(html, /data-acct-edit="[^"]*"/);
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
  const env = await opened({ rows, routes: draftOk });
  env.context.acctMine = () => ({ full_name: bad, phone: bad, recipient_name: bad, recipient_phone: bad, delivery_notes: bad });
  env.page().show(STORE_ID);
  await env.flushAsync();
  assert.doesNotMatch(env.html(), /<img/i);
  assert.ok(env.html().includes('&lt;img'), 'it is shown, as text');
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

test('«موافق» saves the cart, then sends only the store, a key bound to the draft, the total shown and the draft', async () => {
  const placed = { ok: true, id: 'order-1', trackingNumber: DRAFT.trackingNumber, state: state() };
  const env = await opened({ routes: { ...draftOk, '/api/place-store-order': { body: placed }, '/api/customer-order-review': { body: state() } } });
  env.click({ 'op-approve': '' });
  await env.flushAsync();
  const names = env.calls.map((c) => c.url);
  assert.ok(names.indexOf('flush') > -1 && names.indexOf('flush') < names.indexOf('/api/place-store-order'), 'the cart is saved before the order is sent');
  const sent = JSON.parse(env.calls.find((c) => c.url === '/api/place-store-order').options.body).payload;
  assert.deepEqual(sent, { storeId: STORE_ID, idempotencyKey: 'd-11111111222243338444555555555555', expectedSubtotal: 681, draftId: DRAFT.draftId });
  for (const forbidden of ['customer', 'items', 'lines', 'unitPrice', 'currency', 'trackingNumber', 'shipping']) assert.equal(forbidden in sent, false, `the browser does not send ${forbidden}`);
  assert.ok(env.html().includes('جارٍ إرسال طلبك إلى المتجر'), 'now waiting for the store');
  assert.match(env.html(), /المحاولة 1 من 6/);
  assert.doesNotMatch(env.html(), /data-op-approve|data-op-cancel/, 'no customer cancel button once the order is placed');
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

test('closing the payment window cancels: "ملغاة من طرفك", the cart is kept, and a cancelled order is never reopened', async () => {
  for (const why of ['payment_window_closed', 'payment_window_cancelled']) {
    const { env } = await placed(state({ status: 'cancelled', cancelReason: why }));
    await env.advance(3000);
    await env.flushAsync();
    assert.ok(env.html().includes('ملغاة من طرفك'), why);
    assert.ok(env.html().includes('منتجاتك ما زالت في سلتك'));
    assert.doesNotMatch(env.html(), /data-op-pay/, 'no way to pay a cancelled order');
  }
  const { env: expired } = await placed(state({ status: 'cancelled', cancelReason: 'payment_window_expired' }));
  await expired.advance(3000);
  await expired.flushAsync();
  assert.ok(expired.html().includes('انتهت مهلة الدفع'));
});

test('approved: the store accepted, the countdown runs and «الدفع» opens the payment window from the click itself', async () => {
  const left = new Date(Date.now() + 25 * 60 * 1000 + 30 * 1000).toISOString();
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued', expiresAt: left } }));
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.html().includes('قبل المتجر طلبك'));
  assert.match(env.html(), /data-op-count[^>]*>2[45]:\d\d</, 'about 25 minutes are left');
  assert.ok(env.html().includes('إغلاق نافذة الدفع قبل إتمام الدفع يلغي الطلب'));
  assert.doesNotMatch(env.html(), /data-op-cancel/, 'no cancel button for the customer');
  env.click({ 'op-pay': '' });
  assert.equal(env.opened.length, 1, 'the window is opened synchronously inside the click');
  assert.equal(env.opened[0].orderId, 'order-1');
  assert.ok(env.html().includes('نافذة الدفع مفتوحة'));
  assert.doesNotMatch(env.html(), /data-op-pay/, 'no second window while one is open');
});

test('a window the browser blocked is explained, and the customer can press «الدفع» again', async () => {
  const left = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued', expiresAt: left } }));
  await env.advance(3000);
  await env.flushAsync();
  env.click({ 'op-pay': '' });
  env.opened[0].onError('popup_blocked');
  assert.ok(env.html().includes('اسمح للموقع بفتح النوافذ'));
  assert.match(env.html(), /data-op-pay/);
});

test('the customer came back from the window claiming success: the page says "verifying" and does not call the order paid', async () => {
  const left = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  let phase = 0;
  const { env } = await placed(() => (phase === 0 ? state({ status: 'store_confirmed', delivery: null, window: { state: 'issued', expiresAt: left } }) : state({ status: 'store_confirmed', delivery: null, window: { state: 'success_claimed', expiresAt: left } })));
  await env.advance(3000);
  await env.flushAsync();
  env.click({ 'op-pay': '' });
  phase = 1;
  env.opened[0].onState({ state: 'success_claimed' });
  await env.flushAsync();
  assert.ok(env.html().includes('نتحقق من الدفع'));
  assert.doesNotMatch(env.html(), /تم تأكيد طلبك/, 'a browser return proves nothing');
  assert.equal(env.timers.some((t) => t.alive && !t.every), true, 'it keeps polling for the neutral confirmation');
});

test('a payment the neutral confirmation proved (or cash on delivery) is shown as confirmed', async () => {
  for (const paymentStatus of ['paid', 'cod_selected']) {
    const { env } = await placed(state({ status: 'store_confirmed', paymentStatus, delivery: null, window: { state: 'success_claimed', expiresAt: new Date(Date.now() + 60000).toISOString() } }));
    await env.advance(3000);
    await env.flushAsync();
    assert.ok(env.html().includes('تم تأكيد طلبك'), paymentStatus);
    assert.match(env.html(), /href="\/account\.html"/);
  }
});

test('when the countdown reaches zero the page stops offering the window and waits for the order to be closed', async () => {
  const { env } = await placed(state({ status: 'store_confirmed', delivery: null, window: { state: 'issued', expiresAt: new Date(Date.now() - 1000).toISOString() } }));
  await env.advance(3000);
  await env.flushAsync();
  assert.ok(env.html().includes('انتهت المهلة'));
  assert.doesNotMatch(env.html(), /data-op-pay/);
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
