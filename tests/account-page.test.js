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
  const writes = [], calls = [], timers = [], timerFns = [], intervals = [], replaced = [];
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
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
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
    const button = { dataset: { [attribute.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())]: value }, disabled: false };
    const event = { target: { closest: selector => (selector === `[data-${attribute}]` ? button : null) } };
    for (const handler of docHandlers.click || []) handler(event);
    return button;
  };
  // Typing in the reason box of the card, delivered to the page's input listener (the box keeps what was typed in the page's own state).
  const type = text => { const area = { value: text }; for (const handler of docHandlers.input || []) handler({ target: { closest: selector => (selector === '[data-cancel-reason]' ? area : null) } }); };
  return { context, document, elements, store, writes, calls, timers, timerFns, intervals, replaced, docHandlers, click, type, run, el: selector => document.querySelector(selector) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('account.html has every element the page script drives, with no inline script or handler', () => {
  for (const id of ['forgotLink', 'resetForm', 'newPasswordForm', 'loginForm']) assert.match(html, new RegExp(`id="${id}"`), id);
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

test('forgot-password asks the auth service for a link back to the home page of the shop (where the new-password card opens) and answers the same way for any address', async () => {
  const p = page();
  const form = p.el('#resetForm');
  form.elements.email.value = ' someone@example.invalid ';
  await form.handlers.submit({ preventDefault() {}, target: form });
  await tick();
  const call = p.calls.find(item => item.url.includes('/auth/v1/recover'));
  assert.equal(call.options.method, 'POST');
  assert.equal(call.url.includes(`redirect_to=${encodeURIComponent('https://shop.example.invalid/')}`), true);
  assert.deepEqual(JSON.parse(call.options.body), { email: 'someone@example.invalid' });
  assert.match(p.el('#message').textContent, /إن كان هذا البريد مسجلًا/);
  assert.equal(form.hidden, true);
});

test('forgot-password carries the "are you a person" token for its own form, and sends nothing when the check cannot finish', async () => {
  const p = page();
  const boxes = [];
  p.context.ElanTurnstile = {
    token: async box => { boxes.push(box); return 'reset-token'; },
    body: (object, token) => { if (token) object.gotrue_meta_security = { captcha_token: token }; return object; }
  };
  const form = p.el('#resetForm');
  form.elements.email.value = 'someone@example.invalid';
  await form.handlers.submit({ preventDefault() {}, target: form });
  await tick();
  assert.equal(boxes[0], form);
  const call = p.calls.find(item => item.url.includes('/auth/v1/recover'));
  assert.deepEqual(JSON.parse(call.options.body), { email: 'someone@example.invalid', gotrue_meta_security: { captcha_token: 'reset-token' } });

  const q = page();
  q.context.ElanTurnstile = { token: async () => { const e = new Error('لم يكتمل التحقق الأمني. حاول مرة أخرى.'); e.code = 'captcha_failed'; throw e; }, body: object => object };
  const again = q.el('#resetForm');
  again.hidden = false; // the customer opened it with "forgot your password?"
  again.elements.email.value = 'someone@example.invalid';
  await again.handlers.submit({ preventDefault() {}, target: again });
  await tick();
  assert.equal(q.calls.some(item => item.url.includes('/auth/v1/recover')), false, 'no link is requested without the check');
  assert.match(q.el('#message').textContent, /التحقق الأمني/);
  assert.equal(again.hidden, false, 'the form stays open so the customer can try again');
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

  // The first success returns to the one-minute rhythm.
  failing = false;
  await fireTimer();
  assert.equal(p.timers.at(-1), 60000);
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

test('«طلباتي» has no cancel control and never calls the retired cancellation API: the customer cannot cancel, the store answers by itself', async () => {
  const p = page({ session: { access_token: 'customer-jwt' } });
  await tick(); await tick();
  for (const status of ['awaiting_store_confirmation', 'store_confirmed', 'processing', 'shipped', 'delivered', 'store_rejected', 'cancelled']) {
    const card = p.run(`requestLine(${ORDER(`, status: '${status}'`)})`);
    assert.doesNotMatch(card, /data-cancel|cancel-box|<textarea/, `no cancel control for ${status}`);
  }
  assert.equal(p.calls.some(item => item.url.includes('request-store-order-cancellation')), false);
});

test('an order the store accepted shows the payment button with a live countdown; pressing it opens the merchant window through ElanPay once, and the list is read again after', async () => {
  const opened = [];
  const p = page({ session: { access_token: 'customer-jwt' } });
  p.context.ElanPay = { open: options => { opened.push(options); } };
  await tick(); await tick();
  const expires = new Date(Date.now() + 25 * 60 * 1000).toISOString();
  const card = p.run(`requestLine(${ORDER(`, status: 'store_confirmed', payment_status: 'not_started', payable_amount: 10, payment_window: { state: 'opened', expires_at: '${expires}' }`)})`);
  assert.match(card, /data-pay-window="r1"/);
  assert.match(card, /data-pay-left="[^"]+"/);
  assert.doesNotMatch(card, /https?:\/\/[^"' ]*pay/i, 'the card never carries the merchant address');
  const button = p.click('pay-window', 'r1');
  assert.equal(button.disabled, true, 'locked while the window is open');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].orderId, 'r1');
  p.click('pay-window', 'r1');
  assert.equal(opened.length, 1, 'a second press while the window is open opens nothing');
  const reads = p.calls.filter(item => item.url.startsWith('/api/customer-orders')).length;
  opened[0].onState({ state: 'cancelled' });
  await tick(); await tick(); await tick();
  assert.equal(button.disabled, false);
  assert.equal(p.calls.filter(item => item.url.startsWith('/api/customer-orders')).length > reads, true, 'the orders are read again to show what the window did');
});

test('a window the browser could not open is explained in Arabic, with the cart and the order untouched', async () => {
  const p = page({ session: { access_token: 'customer-jwt' } });
  p.context.ElanPay = { open: options => options.onError('popup_blocked') };
  await tick(); await tick();
  p.run('document.querySelector("#app").hidden = false');
  p.click('pay-window', 'r1');
  assert.match(p.el('#appMessage').textContent, /اسمح للموقع بفتح النوافذ/, 'the message says what to do, right away');
});

test('the one-second countdown only moves text; at zero it reads the orders again, and never while the tab is hidden', async () => {
  const p = page({ session: { access_token: 'customer-jwt' } });
  await tick(); await tick();
  assert.equal(p.intervals.length, 1);
  assert.equal(p.intervals[0].ms, 1000);
  const counter = { dataset: { payLeft: new Date(Date.now() - 1000).toISOString() }, textContent: 'x' };
  p.context.document.querySelectorAll = selector => (selector === '[data-pay-left]' ? [counter] : []);
  const reads = () => p.calls.filter(item => item.url.startsWith('/api/customer-orders')).length;
  const before = reads();
  p.context.document.hidden = true;
  p.intervals[0].fn();
  await tick(); await tick();
  assert.equal(reads(), before, 'nothing is asked while the tab is hidden');
  p.context.document.hidden = false;
  p.intervals[0].fn();
  await tick(); await tick();
  assert.equal(reads() > before, true, 'at zero the orders are read again');
  assert.equal(counter.textContent, '00:00');
});
