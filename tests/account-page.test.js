// The customer orders page (account.html + account.js): the password-reset flow, the reorder button and the refresh
// rhythm. account.js runs here in a stub page (no real browser, no real customer, no key): the stub records what the
// page asks the network and the storage to do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'account.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'account.js'), 'utf8');
const SIZE_A = '3f2f7d1e-6a58-4a38-9d0c-0c1f7d3a9b11';
const SIZE_B = '7c1d9a40-2b8e-4f55-8a31-5e6f4d2c1b22';

function element(hidden = false) {
  const handlers = {};
  return {
    hidden, textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, handlers,
    classList: { add() {}, remove() {}, toggle() {} },
    elements: { email: { value: '', focus() {} }, password: { value: '' }, confirm: { value: '' } },
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelector() { return element(); }, closest() { return null; }, reset() {}, focus() {}
  };
}

function page({ hash = '', session = null, cart = [], responder } = {}) {
  const elements = new Map();
  const store = new Map(cart.length ? [['elan_cart', JSON.stringify(cart)]] : []);
  const writes = [], calls = [], timers = [], timerFns = [], replaced = [];
  const docHandlers = {};
  const document = {
    hidden: false,
    // An element starts hidden when account.html says so, exactly as in the browser.
    querySelector(selector) {
      if (!elements.has(selector)) {
        const id = /^#([\w-]+)$/.exec(selector);
        elements.set(selector, element(Boolean(id && new RegExp(`id="${id[1]}"[^>]*\\shidden`).test(html))));
      }
      return elements.get(selector);
    },
    addEventListener(type, handler) { (docHandlers[type] = docHandlers[type] || []).push(handler); }
  };
  const context = {
    document, console, URLSearchParams, URL, Date, Math, Number, String, JSON, Set, Array, Object, Promise, Error, encodeURIComponent, isNaN,
    window: {},
    localStorage: { getItem: key => (store.has(key) ? store.get(key) : null), setItem(key, value) { writes.push(key); store.set(key, String(value)); }, removeItem(key) { store.delete(key); } },
    location: { hash, pathname: '/account.html', search: '', origin: 'https://shop.example.invalid', href: '' },
    history: { replaceState(_s, _t, url) { replaced.push(url); } },
    Portal: {
      errorMessages: { weak_password: 'weak' }, session: () => session, auth: () => ({ Authorization: 'Bearer customer-token' }),
      errorText: (error, fallback) => (error && error.message) || String(error || fallback), login: async () => {}
    },
    setTimeout(fn, ms) { timers.push(ms); timerFns.push(fn); return timers.length; },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url) === '/api/config') return new Response(JSON.stringify({ url: 'https://project.supabase.example.invalid', key: 'public-anon-key' }), { status: 200 });
      if (responder) { const answer = await responder(String(url), options); if (answer) return answer; }
      return new Response('{}', { status: 200 });
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'account.js' });
  const run = code => vm.runInContext(code, context);
  // A click on a button that carries one data attribute, delivered to every click listener of the page (the page uses delegation).
  const click = (attribute, value) => {
    const button = { dataset: { [attribute]: value }, disabled: false };
    const event = { target: { closest: selector => (selector === `[data-${attribute}]` ? button : null) } };
    for (const handler of docHandlers.click || []) handler(event);
    return button;
  };
  return { context, document, elements, store, writes, calls, timers, timerFns, replaced, docHandlers, click, run, el: selector => document.querySelector(selector) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('account.html has every element the page script drives, with no inline script or handler', () => {
  for (const id of ['forgotLink', 'resetForm', 'newPasswordForm', 'refreshOrders', 'lastUpdated', 'loginForm']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline <script>');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'no inline event handler');
  assert.match(html, /id="newPasswordForm"[^>]*hidden/);
  assert.match(html, /id="resetForm"[^>]*hidden/);
  assert.match(html.match(/id="newPasswordForm"[\s\S]*?<\/form>/)[0], /minlength="8"/);
});

test('a recovery link opens the new-password form and is removed from the address bar at once', async () => {
  const p = page({ hash: '#access_token=one-time-token&type=recovery&expires_in=3600' });
  assert.deepEqual(p.replaced, ['/account.html']);
  assert.equal(p.el('#newPasswordForm').hidden, false);
  assert.equal(p.el('#loginForm').hidden, true);
  assert.equal(p.el('.auth-links').hidden, true);
  assert.equal(p.writes.length, 0, 'the recovery token is never stored');
});

test('the new password is sent with the one-time token, needs the confirmation to match, and does not sign the customer in', async () => {
  const p = page({ hash: '#access_token=one-time-token&type=recovery' });
  const form = p.el('#newPasswordForm');
  form.elements.password.value = 'a-long-new-password'; form.elements.confirm.value = 'something-else-entirely';
  await form.handlers.submit({ preventDefault() {}, target: form });
  assert.equal(p.calls.some(call => call.url.includes('/auth/v1/user')), false, 'a mismatch sends nothing');
  form.elements.confirm.value = 'a-long-new-password';
  await form.handlers.submit({ preventDefault() {}, target: form });
  await tick();
  const put = p.calls.find(call => call.url.endsWith('/auth/v1/user'));
  assert.equal(put.options.method, 'PUT');
  assert.equal(put.options.headers.Authorization, 'Bearer one-time-token');
  assert.deepEqual(JSON.parse(put.options.body), { password: 'a-long-new-password' });
  assert.equal(p.calls.some(call => call.url.endsWith('/auth/v1/logout')), true, 'the recovery session is ended');
  assert.equal(p.writes.length, 0, 'nothing is stored: the customer logs in with the new password');
  assert.equal(form.hidden, true);
  assert.equal(p.el('#loginForm').hidden, false);
});

test('an expired recovery link shows a message and never opens the password form', () => {
  const p = page({ hash: '#error=access_denied&error_code=otp_expired' });
  assert.equal(p.el('#newPasswordForm').hidden, true);
  assert.equal(p.el('#loginForm').hidden, false);
  assert.equal(p.el('#message').textContent.length > 0, true);
  assert.deepEqual(p.replaced, ['/account.html']);
});

test('forgot-password asks the auth service for a link back to this page and answers the same way for any address', async () => {
  const p = page();
  const form = p.el('#resetForm');
  form.elements.email.value = ' someone@example.invalid ';
  await form.handlers.submit({ preventDefault() {}, target: form });
  await tick();
  const call = p.calls.find(item => item.url.includes('/auth/v1/recover'));
  assert.equal(call.options.method, 'POST');
  assert.equal(call.url.includes(`redirect_to=${encodeURIComponent('https://shop.example.invalid/account.html')}`), true);
  assert.deepEqual(JSON.parse(call.options.body), { email: 'someone@example.invalid' });
  assert.match(p.el('#message').textContent, /إن كان هذا البريد مسجلًا/);
  assert.equal(form.hidden, true);
});

test('the order list refreshes once a minute, backs off while the service fails, and does not poll a hidden tab', async () => {
  let failing = true;
  const orderCalls = [];
  const p = page({ session: { access_token: 't' }, responder: async url => {
    if (!url.startsWith('/api/customer-orders')) return null;
    orderCalls.push(url);
    return failing ? new Response('{"error":"x"}', { status: 502 }) : new Response('{"ok":true,"sessions":[],"pagination":{"total":0,"hasMore":false}}', { status: 200 });
  } });
  const fireTimer = async () => { await p.timerFns.at(-1)(); await tick(); };
  await tick(); await tick(); await tick();
  assert.equal(orderCalls.length, 1, 'the page loads the orders once on open');
  assert.match(orderCalls[0], /limit=100/);
  assert.equal(p.timers.at(-1), 60000);

  // A hidden tab does not poll, but the schedule goes on.
  p.document.hidden = true;
  await fireTimer();
  assert.equal(orderCalls.length, 1);
  assert.equal(p.timers.at(-1), 60000);

  // A visible tab refreshes with a short page; each failure doubles the wait, up to eight minutes.
  p.document.hidden = false;
  const waits = [];
  for (let i = 0; i < 5; i += 1) { await fireTimer(); waits.push(p.timers.at(-1)); }
  assert.deepEqual(waits, [120000, 240000, 480000, 480000, 480000]);
  assert.equal(orderCalls.length, 6);
  assert.match(orderCalls[1], /limit=20/);

  // The first success returns to the one-minute rhythm and stamps the time.
  failing = false;
  await fireTimer();
  assert.equal(p.timers.at(-1), 60000);
  assert.match(p.el('#lastUpdated').textContent, /^آخر تحديث/);
});

test('"order again" merges the order into the saved cart, caps each line at 99 and goes to the store', () => {
  const p = page({ cart: [{ sid: SIZE_A, q: 98 }, { sid: 'other-size', q: 1 }] });
  p.run(`accountSessions = [{ id: 's1', store_order_requests: [{ id: 'r1', tracking_number: 'T', store_order_request_items: [
    { product_name: 'A', product_size_id: '${SIZE_A}', quantity: 5 }, { product_name: 'B', product_size_id: '${SIZE_B}', quantity: 2 }, { product_name: 'Old', product_size_id: null, quantity: 1 } ] }] }]`);
  p.run("reorder('r1')");
  const cart = JSON.parse(p.store.get('elan_cart'));
  assert.deepEqual(cart.find(row => row.sid === SIZE_A), { sid: SIZE_A, q: 98 }, 'an existing line keeps the larger quantity, never the sum');
  assert.deepEqual(cart.find(row => row.sid === SIZE_B), { sid: SIZE_B, q: 2 });
  assert.equal(cart.some(row => row.sid === 'other-size'), true, 'the rest of the cart is kept');
  assert.equal(cart.length, 3, 'a line without a product reference is skipped');
  assert.equal(p.context.location.href, '/');
  const big = page();
  big.run(`accountSessions = [{ id: 's', store_order_requests: [{ id: 'r', store_order_request_items: [{ product_size_id: '${SIZE_A}', quantity: 5000 }] }] }]`);
  big.run("reorder('r')");
  assert.equal(JSON.parse(big.store.get('elan_cart'))[0].q, 99);
});

test('an order with no usable product reference offers no reorder button, and every value in the cards is escaped', () => {
  const p = page();
  const card = p.run(`requestLine({ id: 'r1', tracking_number: '<img src=x onerror=1>', status: 'processing', subtotal: 10, currency: 'EGP', stores: { name: '<b>store</b>' },
    store_order_request_items: [{ product_name: '<script>x</script>', brand_name: '"><i>', size_label: "'", product_size_id: null, quantity: 1, unit_price: 10, line_total: 10, currency: 'EGP' }], store_shipments: [] })`);
  assert.equal(card.includes('data-reorder'), false);
  for (const raw of ['<img', '<script>', '<b>store', '"><i>']) assert.equal(card.includes(raw), false, raw);
  const withButton = p.run(`requestLine({ id: 'r2', tracking_number: 'T', status: 'processing', subtotal: 10, currency: 'EGP', store_order_request_items: [{ product_name: 'A', product_size_id: '${SIZE_A}', quantity: 1, line_total: 10 }], store_shipments: [] })`);
  assert.equal((withButton.match(/data-reorder/g) || []).length, 1);
  assert.equal((withButton.match(/class="shipment-box/g) || []).length, 1, 'the shipment box is shown once, not repeated in the details');
});

const ORDER = (extra = '') => `{ id: 'r1', tracking_number: 'ELN-20261027-123456', subtotal: 10, currency: 'EGP', store_order_request_items: [{ product_name: 'A', product_size_id: '${SIZE_A}', quantity: 1, line_total: 10 }], store_shipments: [] ${extra} }`;

test('the cancellation button shows only while the store has not confirmed, and the note follows what the store did', () => {
  const p = page();
  const card = (status, requests) => p.run(`requestLine(${ORDER(`, status: '${status}', store_order_cancellation_requests: ${JSON.stringify(requests)}`)})`);
  const asked = [{ created_at: '2026-10-27T10:00:00Z' }];
  const awaiting = card('awaiting_store_confirmation', []);
  assert.equal((awaiting.match(/data-cancel="r1"/g) || []).length, 1, 'the button is offered while the order waits for the store');
  assert.equal(awaiting.includes('cancel-pending'), false);
  for (const status of ['store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected']) {
    const html = card(status, []);
    assert.equal(html.includes('data-cancel'), false, `no button once the order is ${status}`);
    assert.equal(html.includes('cancel-box'), false, `no cancellation box for ${status} without a request`);
  }
  const pending = card('awaiting_store_confirmation', asked);
  assert.equal(pending.includes('data-cancel'), false, 'a second request is not offered');
  assert.match(pending, /cancel-pending[\s\S]*بانتظار رده/);
  assert.match(pending, /لن يُلغى الطلب إلا إذا وافق المتجر/);
  assert.match(card('store_rejected', asked), /cancel-accepted[\s\S]*وافق المتجر/);
  assert.match(card('cancelled', asked), /cancel-accepted/);
  for (const status of ['store_confirmed', 'processing', 'shipped', 'delivered']) assert.match(card(status, asked), /cancel-declined[\s\S]*فلم يُلغَ/, status);
  assert.equal(card('store_confirmed', asked).includes('data-cancel'), false);
});

test('the order id in the cancellation button is escaped', () => {
  const p = page();
  const html = p.run(`requestLine({ id: '"><img src=x onerror=1>', tracking_number: 'T', status: 'awaiting_store_confirmation', subtotal: 1, store_order_request_items: [], store_shipments: [] })`);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /data-cancel="&quot;&gt;&lt;img/);
});

test('asking to cancel sends the reason to the database function with the customer token, then refreshes the list', async () => {
  const orderCalls = [];
  const p = page({ session: { access_token: 'customer-jwt' }, responder: async (url, options) => {
    if (url.startsWith('/api/customer-orders')) { orderCalls.push(url); return new Response('{"ok":true,"sessions":[],"pagination":{"total":0,"hasMore":false}}', { status: 200 }); }
    if (url.endsWith('/rest/v1/rpc/request_store_order_cancellation')) return new Response('{"requestId":"r1","duplicate":false}', { status: 200 });
    return null;
  } });
  await tick(); await tick(); await tick();
  const before = orderCalls.length;
  p.context.prompt = () => '  غيرت رأيي  ';
  p.run(`accountSessions = [{ id: 's1', store_order_requests: [${ORDER(", status: 'awaiting_store_confirmation'")}] }]`);
  const button = p.click('cancel', 'r1');
  assert.equal(button.disabled, true, 'the button is locked while the request is in flight');
  await tick(); await tick(); await tick(); await tick();
  const call = p.calls.find(item => item.url.endsWith('/rest/v1/rpc/request_store_order_cancellation'));
  assert.ok(call, 'the database function is called');
  assert.equal(call.url.startsWith('https://project.supabase.example.invalid'), true, 'straight to the project the CSP allows, not to another host');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, 'Bearer customer-jwt');
  assert.equal(call.options.headers.apikey, 'public-anon-key');
  assert.deepEqual(JSON.parse(call.options.body), { p_request_id: 'r1', p_reason: 'غيرت رأيي' });
  assert.equal(orderCalls.length > before, true, 'the list is read again so the card shows the waiting note');
  assert.equal(button.disabled, false);
});

test('a blank reason is sent as null, a long one is cut to 500 characters, and closing the box sends nothing', async () => {
  const p = page({ session: { access_token: 't' } });
  await tick(); await tick();
  p.run(`accountSessions = [{ id: 's1', store_order_requests: [${ORDER(", status: 'awaiting_store_confirmation'")}] }]`);
  const bodies = () => p.calls.filter(item => item.url.endsWith('/request_store_order_cancellation')).map(item => JSON.parse(item.options.body));
  p.context.prompt = () => null;
  p.click('cancel', 'r1'); await tick(); await tick();
  assert.equal(bodies().length, 0, 'cancelling the box is not a request');
  p.context.prompt = () => '   ';
  p.click('cancel', 'r1'); await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(bodies()[0], { p_request_id: 'r1', p_reason: null });
  p.context.prompt = () => 'x'.repeat(900);
  p.click('cancel', 'r1'); await tick(); await tick(); await tick(); await tick();
  assert.equal(bodies()[1].p_reason.length, 500);
});

test('a refused request shows the reason in Arabic, refreshes the orders, and nothing is asked for an order that is not waiting', async () => {
  const orderCalls = [];
  const p = page({ session: { access_token: 't' }, responder: async url => {
    if (url.startsWith('/api/customer-orders')) { orderCalls.push(url); return new Response('{"ok":true,"sessions":[],"pagination":{"total":0,"hasMore":false}}', { status: 200 }); }
    if (url.endsWith('/request_store_order_cancellation')) return new Response('{"code":"P0001","message":"Order is no longer waiting for the store"}', { status: 400 });
    return null;
  } });
  await tick(); await tick(); await tick();
  p.run('document.querySelector("#app").hidden = false');
  const before = orderCalls.length;
  p.context.prompt = () => 'x';
  p.run(`accountSessions = [{ id: 's1', store_order_requests: [${ORDER(", status: 'awaiting_store_confirmation'")}, { id: 'r2', status: 'processing', store_order_request_items: [] }, { id: 'r3', status: 'awaiting_store_confirmation', store_order_cancellation_requests: [{ created_at: 'x' }], store_order_request_items: [] }] }]`);
  p.click('cancel', 'r1');
  for (let i = 0; i < 8; i += 1) await tick();
  assert.match(p.el('#appMessage').textContent, /المتجر بدأ في معالجة الطلب/);
  assert.equal(orderCalls.length > before, true, 'the list is refreshed so the card shows the real state');
  const sent = () => p.calls.filter(item => item.url.endsWith('/request_store_order_cancellation')).length;
  const asked = sent();
  p.click('cancel', 'r2'); p.click('cancel', 'r3'); p.click('cancel', 'unknown');
  for (let i = 0; i < 4; i += 1) await tick();
  assert.equal(sent(), asked, 'an order that is not waiting, already asked, or unknown sends nothing');
});

test('without a saved session the cancellation asks to sign in again and sends nothing', async () => {
  const p = page({ session: null });
  p.context.prompt = () => { throw new Error('the box must not open without a session'); };
  p.run(`accountSessions = [{ id: 's1', store_order_requests: [${ORDER(", status: 'awaiting_store_confirmation'")}] }]`);
  p.click('cancel', 'r1');
  await tick(); await tick();
  assert.equal(p.calls.some(item => item.url.includes('request_store_order_cancellation')), false);
});
