const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const textResponse = (data, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function responseRecorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader() { return this; }, json(body) { out.body = body; return this; }, end() { out.ended = true; return this; } }; }
async function invoke(handler, req) { const res = responseRecorder(); await handler(req, res); return res.out; }
function baseRequest(method = 'GET', extra = {}) { return { method, headers: { authorization: 'Bearer test-token', ...(extra.headers || {}) }, query: {}, ...extra }; }

const api = name => require(path.join(root, 'api', name));
const lib = name => require(path.join(root, 'lib', name));

test('all JavaScript files pass syntax validation', () => {
  for (const file of fs.readdirSync(root).filter(x => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(root, file)]);
  for (const directory of ['api', 'lib']) for (const file of fs.readdirSync(path.join(root, directory)).filter(x => x.endsWith('.js'))) execFileSync(process.execPath, ['--check', path.join(root, directory, file)]);
});

test('main menu routes طلباتي to the customer dashboard', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const corePath = path.join(root, 'app-core.js');
  const core = fs.existsSync(corePath) ? fs.readFileSync(corePath, 'utf8') : '';
  const account = fs.readFileSync(path.join(root, 'account.html'), 'utf8');
  assert.match(`${app}\n${core}`, /i==10\?'<a href="\/account\.html">/);
  assert.match(account, /id="loginForm"/);
  assert.match(account, /src="\/account\.js(?:\?v=[^"]+)?"/);
  assert.match(account, /id="activeOrders"/);
  assert.match(account, /id="recentOrders"/);
  assert.match(account, /id="archiveForm"/);
});

test('frontend order persistence uses the authenticated Supabase identity', () => {
  const core = fs.readFileSync(path.join(root, 'app-core.js'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261010014304_harden_order_user_binding.sql'), 'utf8');
  assert.match(core, /function authUserId\(\)\{return AUTH&&AUTH\.user&&AUTH\.user\.id\|\|''\}/);
  assert.match(core, /Authorization:'Bearer '\+\(AUTH&&AUTH\.access_token\|\|SB\.key\)/);
  assert.match(core, /\/rpc\/create_checkout_session/);
  assert.match(core, /\/rpc\/create_store_order_request/);
  assert.match(migration, /v_user uuid := auth\.uid\(\)/);
  assert.match(migration, /c\.id = v_checkout_session_id and c\.user_id = v_user_id/);
});

test('create-store-order validates login and splits one checkout across stores', async () => {
  const handler = lib('create-store-order');
  const calls = [];
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  global.fetch = async (url, options = {}) => { calls.push({ url, options }); if (url.endsWith('/create_checkout_session')) return textResponse({ id: 'session-1' }); if (url.endsWith('/create_store_order_request')) return textResponse({ id: `request-${calls.length}`, status: 'awaiting_store_confirmation' }); throw new Error(`unexpected ${url}`); };
  const body = { customer: { name: 'عميل', phone: '01000000000', address: 'عنوان' }, items: [
    { storeId: 'store-a', storeName: 'A', productSizeId: 'size-a', name: 'عطر A', quantity: 1, unitPrice: 100, total: 100 },
    { storeId: 'store-b', storeName: 'B', productSizeId: 'size-b', name: 'عطر B', quantity: 2, unitPrice: 200, total: 400 },
  ] };
  const result = await invoke(handler, { method: 'POST', headers: { authorization: 'Bearer customer' }, body });
  assert.equal(result.status, 201); assert.equal(result.body.ok, true); assert.equal(result.body.stores.length, 2); assert.equal(result.body.stores[0].storeId, 'store-a'); assert.equal(result.body.stores[1].storeId, 'store-b');
  assert.equal(calls.filter(x => x.url.endsWith('/create_store_order_request')).length, 2);
  const unauthorized = await invoke(handler, { method: 'POST', headers: {}, body }); assert.equal(unauthorized.status, 401);
});

test('store status API normalizes and reconciles completed webhook events', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; process.env.STORE_ORDER_WEBHOOK_SECRET = 'secret';
  const status = api('store-order-status'); let rpcPayload;
  global.fetch = async (url, options) => { rpcPayload = JSON.parse(options.body); return jsonResponse({ trackingNumber: 'T-1', status: 'completed', matched: true, mismatches: [] }); };
  const payload = { trackingNumber: 'T-1', customer: { name: 'عميل', phone: '010', address: 'عنوان' }, items: [{ productSizeId: 'p1', quantity: 1 }], subtotal: 100, status: 'confirmed' };
  const result = await invoke(status, { method: 'POST', headers: { 'x-store-webhook-secret': 'secret' }, body: payload }); assert.equal(result.status, 200); assert.equal(result.body.matched, true); assert.equal(rpcPayload.p_payload.trackingNumber, 'T-1');
  const done = await invoke(status, { method: 'POST', headers: { 'x-store-webhook-secret': 'secret' }, body: { ...payload, status: 'completed' } }); assert.equal(done.status, 200); assert.equal(rpcPayload.p_payload.status, 'completed');
  const badSecret = await invoke(status, { method: 'POST', headers: { 'x-store-webhook-secret': 'wrong' }, body: payload }); assert.equal(badSecret.status, 401);
});

test('cancellation API returns the tracking number and restoration token', async () => {
  const handler = api('store-order-cancelled'); delete process.env.STORE_ORDER_WEBHOOK_SECRET; process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  let sent; global.fetch = async (_url, options) => { sent = JSON.parse(options.body); return jsonResponse({ trackingNumber: 'T-2', checkoutTrackingNumber: 'C-1', status: 'store_cancelled', matched: true, mismatches: [], restoreToken: 'restore-1', items: [{ productSizeId: 'p1', quantity: 1 }] }); };
  const result = await invoke(handler, { method: 'POST', headers: {}, body: { trackingNumber: 'T-2', items: [{ productSizeId: 'p1', quantity: 1 }] } });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'store_cancelled'); assert.equal(result.body.restoreToken, 'restore-1'); assert.equal(sent.p_payload.status, 'store_cancelled');
});

test('restore API is idempotent for a pending restoration', async () => {
  const handler = api('restore-store-order'); process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; let patchCount = 0;
  global.fetch = async (url, options = {}) => { if (options.method === 'PATCH') { patchCount++; return jsonResponse({}, 200); } if (url.includes('store_order_cart_restorations?')) return jsonResponse([{ id: 'r1', request_id: 'q1', tracking_number: 'T-2', status: 'pending', items: [{ productSizeId: 'p1' }] }]); throw new Error(url); };
  const result = await invoke(handler, { method: 'POST', body: { restoreToken: 'restore-1' } }); assert.equal(result.status, 200); assert.equal(result.body.status, 'restored'); assert.equal(patchCount, 1);
});

test('platform, store and customer dashboard APIs enforce their scopes', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.DASHBOARD_TOKEN = 'dashboard-token';
  global.fetch = async (url) => {
    if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (url.includes('/profiles')) return jsonResponse([{ id: 'user-1', role: 'customer' }]);
    if (url.includes('/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]);
    return jsonResponse([{ user_id: 'user-1', tracking_number: 'T-1', store_order_requests: [{ store_order_cart_restorations: [{ status: 'restored' }] }] }]);
  };
  const platform = await invoke(api('dashboard-orders'), { method: 'GET', headers: { 'x-dashboard-token': 'dashboard-token' }, query: {} }); assert.equal(platform.status, 200); assert.equal(platform.body.ok, true);
  const customer = await invoke(api('customer-orders'), baseRequest()); assert.equal(customer.status, 200); assert.equal(customer.body.sessions[0].user_id, 'user-1');
  const store = await invoke(api('store-dashboard-orders'), baseRequest()); assert.equal(store.status, 403);
  delete process.env.DASHBOARD_TOKEN;
});

test('store dashboard and order update require store ownership or platform role', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  const calls = []; global.fetch = async (url, options = {}) => { calls.push({ url, options }); if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'store-user' }); if (url.includes('/profiles')) return jsonResponse([{ id: 'store-user', role: 'store_admin' }]); if (url.includes('/store_accounts')) return jsonResponse([{ store_id: 'store-a' }]); if (url.includes('/store_order_requests?select=id,store_id,tracking_number,status')) return jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: 'store_confirmed' }]); if (options.method === 'PATCH') return jsonResponse([{ id: 'request-1', store_id: 'store-a', tracking_number: 'T-1', status: 'processing' }]); return jsonResponse([{ id: 'request-1', store_id: 'store-a', status: 'processing' }]); };
  const orders = await invoke(api('store-dashboard-orders'), baseRequest()); assert.equal(orders.status, 200); assert.deepEqual(orders.body.stores, ['store-a']);
  const update = await invoke(api('store-order-update'), { method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body: { requestId: 'request-1', status: 'processing' } }); assert.equal(update.status, 200); assert.equal(update.body.ok, true);
  const invalid = await invoke(api('store-order-update'), { method: 'PATCH', headers: { authorization: 'Bearer test-token' }, body: { requestId: 'request-1', status: 'delivered' } }); assert.equal(invalid.status, 409); assert.equal(invalid.body.error, 'invalid_status_transition');
});

test('notification API reads and marks only accessible notifications', async () => {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  global.fetch = async (url, options = {}) => { if (url.includes('/auth/v1/user')) return jsonResponse({ id: 'customer-1' }); if (url.includes('/profiles')) return jsonResponse([{ id: 'customer-1', role: 'customer' }]); if (options.method === 'PATCH') return jsonResponse([{ id: 'n1', is_read: true }]); return jsonResponse([{ id: 'n1', user_id: 'customer-1', type: 'store_cancelled', is_read: false }]); };
  const read = await invoke(api('notifications'), { method: 'GET', headers: { authorization: 'Bearer token' }, query: { unread: '1' } }); assert.equal(read.status, 200); assert.equal(read.body.notifications[0].user_id, 'customer-1');
  const marked = await invoke(api('notifications'), { method: 'PATCH', headers: { authorization: 'Bearer token' }, body: { id: 'n1' } }); assert.equal(marked.status, 200); assert.equal(marked.body.notification.is_read, true);
});

test('customer UI keeps the previous basket identity and mobile entry point', () => {
  const css = fs.readFileSync(path.join(root, 'portal.css'), 'utf8'); const html = fs.readFileSync(path.join(root, 'account.html'), 'utf8');
  assert.match(css, /IBM Plex Sans Arabic/); assert.match(css, /#c8962a/); assert.match(css, /\.cart-shortcut/); assert.match(css, /border-radius:999px/); assert.match(html, /id="cartShortcut"/);
});
