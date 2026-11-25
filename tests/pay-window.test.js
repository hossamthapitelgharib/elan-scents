// pay-window.js and payment-return.js: the customer's side of the MERCHANT'S payment window (step 6 of docs/purchase-flow-final.ar.md).
// Both real files run in a VM with a scripted popup, a fake clock and a scripted server; no network, no real customer.
// What is proved: the window is RESERVED first (inside the tap, with a waiting text) and pointed at the merchant afterwards, by itself, when the merchant has
// approved; a window Élan itself closes is never read as the customer shutting it; the customer's way back is heard on postMessage AND on a BroadcastChannel; only an https address is used; closing the
// window for real is reported as "closed" (the server cancels the order); a window that only LOOKS closed right after the merchant's page loads
// (a page that cuts its link to the opener) is not taken as the customer closing it; the return page's report is what tells the opener, which then
// asks the server for the state; success claimed by the browser is a claim, a failed payment reports nothing and cancels nothing, and a failed report keeps
// the return page open instead of closing it; the return page always shows the way back to Élan Scents and to «طلباتي».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const payWindow = read('pay-window.js');
const returnJs = read('payment-return.js');

const ORDER = '11111111-2222-4333-8444-555555555555';
const ORIGIN = 'https://shop.example.invalid';

function popup() {
  const win = { closed: false, closeCalls: 0, hrefs: [], document: { title: '', documentElement: {}, body: { style: {}, textContent: '' } }, close() { this.closeCalls += 1; this.closed = true; } };
  Object.defineProperty(win, 'location', { value: { set href(v) { win.hrefs.push(v); } } });
  return win;
}

function payEnv({ openResult, routes = {} } = {}) {
  const calls = [], listeners = {}, intervals = [], order = [], channels = [];
  const win = popup();
  const context = {
    console, JSON, Date: { now: () => context.__now }, Math, Object, Promise, Array, String, Error, encodeURIComponent,
    __now: 1000000,
    localStorage: { getItem: (k) => (k === 'elan_auth_session' ? JSON.stringify({ access_token: 'tok' }) : null) },
    location: { origin: ORIGIN },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, alive: true }); return intervals.length; },
    clearInterval: (id) => { if (intervals[id - 1]) intervals[id - 1].alive = false; },
    addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type) => { delete listeners[type]; },
    BroadcastChannel: function (name) { const ch = { name, closed: false, onmessage: null, close() { this.closed = true; } }; channels.push(ch); return ch; },
    open: (url, name, features) => { order.push('open'); calls.push({ kind: 'window.open', url, name, features }); return openResult === null ? null : win; },
    fetch: async (url, options) => {
      order.push('fetch');
      const body = JSON.parse(options.body);
      calls.push({ kind: 'fetch', url, body, headers: options.headers });
      const route = routes[body.action];
      const r = typeof route === 'function' ? await route(body) : route;
      return { ok: true, status: 200, json: async () => r };
    }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(payWindow, context, { filename: 'pay-window.js' });
  const tick = async (ms) => { context.__now += ms; for (const i of intervals.slice()) if (i.alive) await i.fn(); await new Promise((r) => setImmediate(r)); };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r)); };
  return { context, calls, win, listeners, channels, tick, settle, order, intervals, pay: () => context.ElanPay };
}

const open = { open: { ok: true, state: 'opened', url: 'https://pay.example.invalid/checkout/abc' } };

test('the window is opened empty first, inside the tap, and only then pointed at the merchant\'s https address', async () => {
  const env = payEnv({ routes: open });
  env.pay().open({ orderId: ORDER, onState() {}, onError() {} });
  assert.deepEqual(env.order.slice(0, 2), ['open', 'fetch'], 'the browser window comes before any request, or it would be blocked');
  assert.equal(env.calls[0].url, 'about:blank');
  assert.equal(env.calls[0].name, 'elan_pay');
  assert.doesNotMatch(env.calls[0].features, /noopener|noreferrer/, 'the opener link is kept, so the return page can tell this page');
  await env.settle();
  assert.deepEqual(env.calls[1].body, { orderId: ORDER, action: 'open' });
  assert.equal(env.calls[1].headers.Authorization, 'Bearer tok');
  assert.deepEqual(env.win.hrefs, ['https://pay.example.invalid/checkout/abc']);
});

test('an address that is not https is never loaded into the window', async () => {
  for (const url of ['http://pay.example.invalid/x', 'javascript:alert(1)', 'data:text/html,x', '//pay.example.invalid']) {
    const env = payEnv({ routes: { open: { ok: true, state: 'opened', url } } });
    let error = null;
    env.pay().open({ orderId: ORDER, onState() {}, onError: (k) => { error = k; } });
    await env.settle();
    assert.deepEqual(env.win.hrefs, [], url);
    assert.equal(error, 'window_unavailable', url);
    assert.equal(env.win.closed, true, 'the empty window is closed');
  }
});

test('a blocked window is reported and nothing is requested', async () => {
  const env = payEnv({ openResult: null, routes: open });
  let error = null;
  env.pay().open({ orderId: ORDER, onState() {}, onError: (k) => { error = k; } });
  await env.settle();
  assert.equal(error, 'popup_blocked');
  assert.equal(env.calls.filter((c) => c.kind === 'fetch').length, 0);
});

test('when the server will not open the window the empty window is closed and the error is passed on', async () => {
  const env = payEnv({ routes: { open: { ok: false, error: 'window_unavailable' } } });
  let error = null;
  env.pay().open({ orderId: ORDER, onState() {}, onError: (k) => { error = k; } });
  await env.settle();
  assert.equal(error, 'window_unavailable');
  assert.equal(env.win.closed, true);
});

test('an order that is already cancelled comes back as its state, not as an error', async () => {
  const env = payEnv({ routes: { open: { ok: true, state: 'cancelled', cancelReason: 'payment_window_expired' } } });
  let got = null;
  env.pay().open({ orderId: ORDER, onState: (s) => { got = s; }, onError() { assert.fail('not an error'); } });
  await env.settle();
  assert.equal(got.state, 'cancelled');
  assert.equal(env.win.closed, true);
});

test('the customer closing the window for real is reported as "closed" once (the server cancels the order)', async () => {
  const env = payEnv({ routes: { ...open, return: { ok: true, state: 'cancelled', cancelReason: 'payment_window_closed' } } });
  let got = null;
  env.pay().open({ orderId: ORDER, onState: (s) => { got = s; }, onError() {} });
  await env.settle();
  await env.tick(60000); // long after the merchant's page was loaded
  env.win.closed = true;
  await env.tick(500);
  await env.tick(500);
  await env.settle();
  const reports = env.calls.filter((c) => c.kind === 'fetch' && c.body.action === 'return');
  assert.equal(reports.length, 1, 'reported once');
  assert.equal(reports[0].body.outcome, 'closed');
  assert.equal(got.state, 'cancelled');
});

test('a window that only looks closed right after the merchant\'s page loaded is not reported as closed', async () => {
  const env = payEnv({ routes: { ...open, return: { ok: true, state: 'cancelled' } } });
  env.pay().open({ orderId: ORDER, onState() { assert.fail('no verdict from a detached window'); }, onError() {} });
  await env.settle();
  await env.tick(500);
  env.win.closed = true; // what a page that cuts the opener link looks like to this page
  await env.tick(500);
  await env.settle();
  assert.equal(env.calls.some((c) => c.kind === 'fetch' && c.body.action === 'return'), false);
});

test('the return page tells the opener: it closes the window and asks the server for the state, and never reports "closed" afterwards', async () => {
  const env = payEnv({ routes: { ...open, state: { ok: true, status: 'store_confirmed', window: { state: 'success_claimed' } } } });
  let got = null;
  env.pay().open({ orderId: ORDER, onState: (s) => { got = s; }, onError() {} });
  await env.settle();
  env.listeners.message({ origin: ORIGIN, data: { elan: 'pay-return', orderId: ORDER, outcome: 'success' } });
  await env.settle();
  assert.equal(env.win.closeCalls >= 1, true);
  assert.equal(got.status, 'store_confirmed');
  await env.tick(60000);
  assert.equal(env.calls.some((c) => c.kind === 'fetch' && c.body.action === 'return'), false, 'the customer did not close the window, the return page did');
});

test('a message from another origin, another order or another kind is ignored', async () => {
  const env = payEnv({ routes: { ...open, state: { ok: true } } });
  let got = null;
  env.pay().open({ orderId: ORDER, onState: (s) => { got = s; }, onError() {} });
  await env.settle();
  for (const message of [{ origin: 'https://evil.example.invalid', data: { elan: 'pay-return', orderId: ORDER } }, { origin: ORIGIN, data: { elan: 'pay-return', orderId: 'other' } }, { origin: ORIGIN, data: { elan: 'other', orderId: ORDER } }, { origin: ORIGIN, data: null }]) {
    env.listeners.message(message);
  }
  await env.settle();
  assert.equal(got, null);
  assert.equal(env.calls.some((c) => c.kind === 'fetch' && c.body.action === 'state'), false);
});

test('reserve() opens the empty window inside the tap with a waiting text and asks the server nothing; follow() points it at the merchant later', async () => {
  const env = payEnv({ routes: open });
  const handle = env.pay().reserve({ text: 'جارٍ تجهيز نافذة الدفع…', dir: 'rtl' });
  assert.ok(handle, 'the window is reserved');
  assert.deepEqual(env.order, ['open'], 'nothing is requested until the merchant answers');
  assert.equal(env.win.document.body.textContent, 'جارٍ تجهيز نافذة الدفع…');
  assert.equal(env.win.document.documentElement.dir, 'rtl');
  await env.settle();
  assert.deepEqual(env.win.hrefs, [], 'the merchant is not loaded yet');
  handle.follow({ orderId: ORDER, onState() {}, onError() {} });
  await env.settle();
  assert.deepEqual(env.calls.filter((c) => c.kind === 'fetch').map((c) => c.body.action), ['open']);
  assert.deepEqual(env.win.hrefs, ['https://pay.example.invalid/checkout/abc']);
  handle.follow({ orderId: ORDER, onState() {}, onError() {} });
  await env.settle();
  assert.equal(env.calls.filter((c) => c.kind === 'fetch').length, 1, 'following twice asks once');
});

test('a browser that refuses the reservation gives null (the order page then offers its one button)', () => {
  const env = payEnv({ openResult: null, routes: open });
  assert.equal(env.pay().reserve({ text: 'x' }), null);
  assert.equal(env.calls.filter((c) => c.kind === 'fetch').length, 0);
});

test('the customer shut the waiting window before the merchant answered: no request, no cancellation, just "window_closed_early"', async () => {
  const env = payEnv({ routes: { ...open, return: { ok: true, state: 'cancelled' } } });
  const handle = env.pay().reserve({ text: 'x' });
  env.win.closed = true;
  let error = null;
  handle.follow({ orderId: ORDER, onState() { assert.fail('no verdict'); }, onError: (k) => { error = k; } });
  await env.settle();
  await env.tick(1000);
  assert.equal(error, 'window_closed_early');
  assert.equal(env.calls.filter((c) => c.kind === 'fetch').length, 0, 'nothing was shown, so nothing is cancelled');
});

test('a window that Élan itself closes (order refused, paid, page left) is never reported as the customer shutting it', async () => {
  const env = payEnv({ routes: { ...open, return: { ok: true, state: 'cancelled' } } });
  const handle = env.pay().reserve({ text: 'x' });
  handle.follow({ orderId: ORDER, onState() { assert.fail('no verdict'); }, onError() {} });
  await env.settle();
  await env.tick(60000);
  handle.close();
  assert.equal(env.win.closed, true);
  await env.tick(500);
  await env.tick(500);
  await env.settle();
  assert.equal(env.calls.some((c) => c.kind === 'fetch' && c.body.action === 'return'), false);
  assert.equal(env.channels.every((c) => c.closed), true, 'the broadcast listener is released too');
  assert.equal(env.listeners.message, undefined, 'and the message listener');
});

test('the way back is heard on the BroadcastChannel too (a merchant page that cut the opener link): the server is asked, the window closed, the outcome passed on', async () => {
  const env = payEnv({ routes: { ...open, state: { ok: true, status: 'store_confirmed', window: { state: 'opened' } } } });
  let got = null;
  env.pay().open({ orderId: ORDER, onState: (s) => { got = s; }, onError() {} });
  await env.settle();
  assert.equal(env.channels.length, 1);
  assert.equal(env.channels[0].name, 'elan-pay-return');
  env.channels[0].onmessage({ data: { elan: 'pay-return', orderId: 'someone-else', outcome: 'success' } });
  await env.settle();
  assert.equal(got, null, 'another order is ignored');
  env.channels[0].onmessage({ data: { elan: 'pay-return', orderId: ORDER, outcome: 'failed' } });
  await env.settle();
  assert.equal(env.win.closeCalls >= 1, true);
  assert.equal(got.status, 'store_confirmed');
  assert.equal(got.returned, 'failed', 'the page learns how the customer came back, but the order itself is read from the server');
  assert.equal(env.calls.some((c) => c.kind === 'fetch' && c.body.action === 'return'), false, 'a failed payment is not reported as anything');
});

test('pay-window.js has no inline handler, stores nothing and holds no secret', () => {
  assert.doesNotMatch(payWindow, /onclick=|<script|innerHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(payWindow, /localStorage\.setItem|sessionStorage|indexedDB/, 'only the signed-in session is read');
  const code = payWindow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /card|cvv|iban|secret|api[_-]?key/i, 'no payment detail, no key');
});

// ---------- the page the merchant's window returns to ----------
function returnEnv({ search, token = 'tok', opener = true, replies = [] } = {}) {
  const els = {}, calls = [], posted = [], broadcast = [], listeners = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: false, textContent: '', addEventListener: (t, fn) => { listeners[id + ':' + t] = fn; } });
  const win = { closed: false };
  const context = {
    console, JSON, Promise, Error, String, Math, URLSearchParams, encodeURIComponent,
    BroadcastChannel: function (name) { return { name, postMessage: (m) => broadcast.push({ name, m }), close() {} }; },
    location: { search, origin: ORIGIN },
    document: { getElementById: el },
    localStorage: { getItem: (k) => (k === 'elan_auth_session' && token ? JSON.stringify({ access_token: token }) : null) },
    setTimeout: (fn) => { fn(); return 0; },
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body), headers: options.headers }); const r = replies.shift() || { status: 200, body: { ok: true } }; if (r === 'throw') throw new TypeError('offline'); return { ok: r.status < 400, status: r.status, json: async () => r.body }; },
    close: () => { context.closed = true; },
    closed: false
  };
  context.window = context;
  context.opener = opener ? { closed: false, postMessage: (m, origin) => posted.push({ m, origin }) } : null;
  vm.createContext(context);
  vm.runInContext(returnJs, context, { filename: 'payment-return.js' });
  const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
  return { context, els, calls, posted, broadcast, listeners, settle, win };
}

test('success in the merchant\'s window is recorded as a CLAIM, the opener is told, and the window closes itself', async () => {
  const env = returnEnv({ search: `?o=${ORDER}&r=success` });
  await env.settle();
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].body, { orderId: ORDER, action: 'return', outcome: 'success' });
  assert.equal(env.calls[0].headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(JSON.stringify(env.posted)), [{ m: { elan: 'pay-return', orderId: ORDER, outcome: 'success' }, origin: ORIGIN }], 'only to this site\'s own origin');
  assert.equal(env.context.closed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(env.broadcast)), [{ name: 'elan-pay-return', m: { elan: 'pay-return', orderId: ORDER, outcome: 'success' } }], 'and on the channel, for a window whose opener link was cut');
  assert.equal(env.els.prHome.hidden, false, 'the way back to Élan Scents is always shown');
  assert.equal(env.els.prOrders.hidden, false);
  assert.doesNotMatch(env.els.prTitle.textContent, /تم الدفع|مدفوع/, 'the page does not call it paid');
});

test('cancel or a shut window is reported (the server cancels the order) and says it in the customer\'s words', async () => {
  for (const result of ['cancel', 'closed']) {
    const env = returnEnv({ search: `?o=${ORDER}&r=${result}` });
    await env.settle();
    assert.equal(env.calls[0].body.outcome, result);
    assert.equal(env.posted.length, 1);
    assert.equal(env.els.prTitle.textContent, 'تم إلغاء المعاملة برغبة العميل');
    assert.match(env.els.prText.textContent, /سلتك/, 'the cart is kept');
  }
});

test('a payment that FAILED reports nothing and cancels nothing: it only brings the customer back to try again', async () => {
  const env = returnEnv({ search: `?o=${ORDER}&r=failed`, token: '' });
  await env.settle();
  assert.equal(env.calls.length, 0, 'no report: the truth comes from the provider\'s own confirmation');
  assert.equal(env.posted.length, 1);
  assert.equal(env.posted[0].m.outcome, 'failed');
  assert.equal(env.broadcast.length, 1);
  assert.equal(env.els.prTitle.textContent, 'لم تكتمل عملية الدفع');
  assert.equal(env.els.prHome.hidden, false);
});

test('an address that is not a valid return (bad order, unknown result, no sign-in) reports nothing and offers «طلباتي»', async () => {
  for (const [search, token] of [['?o=not-a-uuid&r=success', 'tok'], [`?o=${ORDER}&r=paid`, 'tok'], [`?o=${ORDER}`, 'tok'], ['', 'tok'], [`?o=${ORDER}&r=success`, '']]) {
    const env = returnEnv({ search, token });
    await env.settle();
    assert.equal(env.calls.length, 0, search + '/' + token);
    assert.equal(env.posted.length, 0);
    assert.equal(env.broadcast.length, 0);
    assert.equal(env.els.prOrders.hidden, false, 'the way back to «طلباتي»');
    assert.equal(env.els.prHome.hidden, false, 'and to Élan Scents');
    assert.equal(env.context.closed, false);
  }
});

test('when the report cannot be made the page stays open and retries; it never closes (a closed window would be read as the customer shutting it)', async () => {
  const env = returnEnv({ search: `?o=${ORDER}&r=success`, replies: ['throw', { status: 503, body: null }, 'throw'] });
  await env.settle();
  assert.equal(env.calls.length, 3, 'three tries');
  assert.equal(env.context.closed, false);
  assert.equal(env.posted.length, 0, 'the opener is not told something that was not recorded');
  assert.equal(env.els.prRetry.hidden, false, 'a retry button is offered');
  env.listeners['prRetry:click']();
  await env.settle();
  assert.equal(env.context.closed, true, 'once recorded it closes');
});

test('an order that is already past this step (409) or unknown (404) is a final answer, not a failure', async () => {
  for (const status of [409, 404]) {
    const env = returnEnv({ search: `?o=${ORDER}&r=cancel`, replies: [{ status, body: { ok: false } }] });
    await env.settle();
    assert.equal(env.calls.length, 1, String(status));
    assert.equal(env.posted.length, 1);
  }
});

test('without an opener the page still tells the Élan page (on the channel) and shows the way back to Élan Scents and «طلباتي»', async () => {
  const env = returnEnv({ search: `?o=${ORDER}&r=success`, opener: false });
  await env.settle();
  assert.equal(env.calls.length, 1);
  assert.equal(env.posted.length, 0, 'nothing to post to');
  assert.equal(env.broadcast.length, 1, 'but the channel reaches the Élan page of this browser');
  assert.equal(env.els.prHome.hidden, false);
  assert.equal(env.els.prOrders.hidden, false);
});

test('the return page and its files: no inline script, served as a page under the policy, scripts and style immutable, no index', () => {
  const html = read('payment-return.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)|onclick=|onload=|onsubmit=/i, 'external scripts only');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /src="\/auth-session\.js\?v=/);
  assert.match(html, /src="\/payment-return\.js\?v=/);
  assert.match(html, /href="\/payment-return\.css\?v=/);
  assert.match(html, /id="prHome"[^>]*href="\/"|href="\/" id="prHome"/, 'a visible way back to Élan Scents');
  const vercel = JSON.parse(read('vercel.json'));
  const pageRules = vercel.headers.filter((h) => /\(index\.html\|/.test(h.source));
  assert.ok(pageRules.length >= 2 && pageRules.every((h) => h.source.includes('payment-return.html')), 'both page rules (policy and cache) list the page');
  const immutable = vercel.headers.find((h) => (h.headers || []).some((x) => x.key === 'Cache-Control' && /immutable/.test(x.value)) && /app-core\.js/.test(h.source));
  for (const file of ['pay-window.js', 'order-page.js', 'payment-return.js', 'payment-return.css']) assert.ok(immutable.source.includes(file), file);
  assert.doesNotMatch(returnJs, /onclick=|<script|innerHTML|eval\(/);
  assert.match(read('payment-return.css'), /#c8962a|--gold:#c8962a/i, 'the shop\'s gold');
});
