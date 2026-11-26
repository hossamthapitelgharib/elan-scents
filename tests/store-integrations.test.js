const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'store-integrations'));

function recorder() {
  const out = {};
  return {
    out,
    status(value) { out.status = value; return this; },
    setHeader(name, value) { (out.headers ||= {})[name] = value; return this; },
    json(body) { out.body = body; return this; },
  };
}
function response(data, status = 200) {
  return new Response(data == null ? '' : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function authenticatedFetch(handlerFetch, role = 'platform_admin') {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/auth/v1/user')) return response({ id: 'admin-user' });
    if (url.pathname.endsWith('/rest/v1/profiles')) return response([{ id: 'admin-user', role }]);
    return handlerFetch(input, options);
  };
}
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.before(() => {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function request(method = 'GET', body) {
  return { method, headers: { authorization: 'Bearer admin-token', host: 'admin.example' }, body };
}

test('store integrations reject requests without an authenticated session before calling Supabase', async () => {
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
  assert.equal(called, false);
});

test('store integrations reject authenticated customers before reading or changing settings', async () => {
  let called = false;
  global.fetch = authenticatedFetch(async () => { called = true; throw new Error('unexpected'); }, 'customer');
  const res = recorder();
  await handler(request(), res);
  assert.equal(res.out.status, 403);
  assert.equal(called, false);
});

test('GET reads the normalized per-store row and returns only masked secrets', async () => {
  const requests = [];
  global.fetch = authenticatedFetch(async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/public_stores') return response([{ id: storeId, name: 'Store A', short_description: 'A store' }]);
    if (url.pathname === '/rest/v1/store_integrations') return response([{
      store_id: storeId, enabled: false, base_url: 'https://store.example', cart_url: 'https://store.example/cart',
      api_base_url: 'https://api.store.example', catalog_endpoint: '/items', api_key: 'TOPSECRETKEY123',
      webhook_secret: 'HOOKSECRETKEY456', notes: 'connected',
    }]);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const res = recorder();
  await handler(request(), res);
  assert.equal(res.out.status, 200);
  const store = res.out.body.stores[0];
  assert.equal(store.id, storeId);
  assert.equal(store.enabled, false);
  assert.equal(store.baseUrl, 'https://store.example');
  assert.equal(store.apiKey, '');
  assert.equal(store.webhookSecret, '');
  assert.equal(store.hasApiKey, true);
  assert.equal(store.hasWebhookSecret, true);
  assert.equal(store.apiKeyMasked, 'TOPS••••Y123');
  assert.equal(store.webhookSecretMasked, 'HOOK••••Y456');
  assert.equal(store.notes, 'connected');
  assert.equal(JSON.stringify(res.out.body).includes('TOPSECRETKEY123'), false);
  assert.equal(JSON.stringify(res.out.body).includes('HOOKSECRETKEY456'), false);
  assert.equal(requests.some(call => call.url.pathname === '/rest/v1/store_integrations'), true);
  assert.ok(requests.every(call => call.options.headers.apikey === 'service-key'));
  assert.equal(res.out.headers['Cache-Control'], 'no-store');
});

test('GET supports legacy site_settings values until they are resaved in normalized rows', async () => {
  global.fetch = authenticatedFetch(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/public_stores') return response([{ id: storeId, name: 'Store A' }]);
    if (url.pathname === '/rest/v1/store_integrations') return response([]);
    if (url.pathname === '/rest/v1/site_settings') return response([{ value: JSON.stringify({ 'Store A': {
      enabled: true, baseUrl: 'https://legacy.example', apiKey: 'LEGACYKEY98765', webhookSecret: 'LEGACYHOOK76543',
    } }) }]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const res = recorder();
  await handler(request(), res);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.body.stores[0].baseUrl, 'https://legacy.example');
  assert.equal(res.out.body.stores[0].hasApiKey, true);
  assert.equal(res.out.body.stores[0].apiKeyMasked, 'LEGA••••8765');
  assert.equal(JSON.stringify(res.out.body).includes('LEGACYKEY98765'), false);
});

test('PUT upserts by store_id and preserves existing secrets when masked inputs are blank', async () => {
  const requests = [];
  global.fetch = authenticatedFetch(async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/stores') return response([{ id: storeId, name: 'Store A' }]);
    if (url.pathname === '/rest/v1/store_integrations' && options.method === 'POST') return response(null, 201);
    if (url.pathname === '/rest/v1/store_integrations') return response([{ store_id: storeId, api_key: 'PRESERVEDAPIKEY', webhook_secret: 'PRESERVEDHOOKSECRET' }]);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname} ${options.method}`);
  });
  const res = recorder();
  await handler(request('PUT', { stores: [{
    name: 'Store A', enabled: false, baseUrl: 'https://new.example', cartUrl: '', apiBaseUrl: '',
    catalogEndpoint: '/products', apiKey: '', webhookSecret: '', notes: 'updated',
  }] }), res);
  assert.equal(res.out.status, 200);
  assert.deepEqual(res.out.body.saved, ['Store A']);
  const save = requests.find(call => call.url.pathname === '/rest/v1/store_integrations' && call.options.method === 'POST');
  assert.ok(save);
  assert.equal(save.url.searchParams.get('on_conflict'), 'store_id');
  assert.equal(save.options.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  const [row] = JSON.parse(save.options.body);
  assert.equal(row.store_id, storeId);
  assert.equal(row.enabled, false);
  assert.equal(row.base_url, 'https://new.example');
  assert.equal(row.api_key, 'PRESERVEDAPIKEY');
  assert.equal(row.webhook_secret, 'PRESERVEDHOOKSECRET');
  assert.equal(row.notes, 'updated');
  assert.equal(requests.some(call => call.url.pathname === '/rest/v1/site_settings' && call.options.method === 'POST'), false);
});

test('PUT rejects unknown stores and oversized values before any upsert', async () => {
  const requests = [];
  global.fetch = authenticatedFetch(async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/stores') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const unknown = recorder();
  await handler(request('PUT', { stores: [{ name: 'Unknown store' }] }), unknown);
  assert.equal(unknown.out.status, 400);
  assert.equal(unknown.out.body.error, 'unknown_store');
  assert.equal(requests.some(call => call.options.method === 'POST'), false);

  const oversized = recorder();
  await handler(request('PUT', { stores: [{ name: 'Store A', notes: 'x'.repeat(10001) }] }), oversized);
  assert.equal(oversized.out.status, 400);
  assert.equal(oversized.out.body.error, 'invalid_store_settings');
});

test('normalized integration migration binds one config to each store and protects credentials', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261014102728_store_integrations_normalized.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.store_integrations/i);
  assert.match(migration, /store_id uuid not null unique references public\.stores\(id\) on delete cascade/i);
  assert.match(migration, /api_key text not null default ''/i);
  assert.match(migration, /webhook_secret text not null default ''/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all privileges[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant all privileges[\s\S]*to service_role/i);
});

// Stage 1 of docs/purchase-flow-correction-plan.ar.md: the address Élan sends this store's signed orders to. With an enabled link and a
// secret of 16 characters or more it makes the store "ready"; any other store has its order button locked.
test('GET shows the order address and whether the store can take an order, never the secret', async () => {
  global.fetch = authenticatedFetch(async input => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/public_stores') return response([{ id: storeId, name: 'Store A' }, { id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'Store B' }, { id: 'a1b2c3d4-0000-4000-8000-000000000003', name: 'Store C' }]);
    if (url.pathname === '/rest/v1/store_integrations') return response([
      { store_id: storeId, enabled: true, order_endpoint: 'https://orders.store-a.com/elan', webhook_secret: 'LONGENOUGHSECRET16', payment_hosts: ['pay.store-a.com'] },
      { store_id: 'a1b2c3d4-0000-4000-8000-000000000002', enabled: true, order_endpoint: 'https://orders.store-b.com/elan', webhook_secret: 'short', payment_hosts: ['pay.store-b.com'] },
      { store_id: 'a1b2c3d4-0000-4000-8000-000000000003', enabled: true, order_endpoint: 'https://orders.store-c.com/elan', webhook_secret: 'LONGENOUGHSECRET16', payment_hosts: [] },
    ]);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const res = recorder();
  await handler(request(), res);
  const [a, b, c] = res.out.body.stores;
  assert.deepEqual([a.orderEndpoint, a.orderReady, a.paymentHosts], ['https://orders.store-a.com/elan', true, ['pay.store-a.com']]);
  assert.deepEqual([b.orderEndpoint, b.orderReady], ['https://orders.store-b.com/elan', false], 'a secret under 16 characters is not enough');
  assert.deepEqual([c.orderReady, c.paymentHosts], [false, []], 'a store with no payment host is not linked, whatever else it has');
  assert.equal(JSON.stringify(res.out.body).includes('LONGENOUGHSECRET16'), false);
});

function putOrderEndpoint(item, existing) {
  const requests = [];
  global.fetch = authenticatedFetch(async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/stores') return response([{ id: storeId, name: 'Store A' }]);
    if (url.pathname === '/rest/v1/store_integrations' && options.method === 'POST') return response(null, 201);
    if (url.pathname === '/rest/v1/store_integrations') return response(existing ? [{ store_id: storeId, ...existing }] : []);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  });
  const res = recorder();
  return handler(request('PUT', { stores: [{ name: 'Store A', ...item }] }), res).then(() => ({ res, requests }));
}
const savedRow = ({ requests }) => JSON.parse(requests.find(call => call.url.pathname === '/rest/v1/store_integrations' && call.options.method === 'POST').options.body)[0];

test('PUT saves an https order address; one that cannot be called safely is refused before anything is written', async () => {
  const ok = await putOrderEndpoint({ orderEndpoint: ' https://orders.store-a.com/elan ' });
  assert.equal(ok.res.out.status, 200);
  assert.equal(savedRow(ok).order_endpoint, 'https://orders.store-a.com/elan');
  for (const bad of ['http://orders.store-a.com/elan', 'https://127.0.0.1/elan', 'https://localhost/elan', 'https://orders.store-a.com:8443/elan', 'https://u:p@orders.store-a.com/elan', 'ftp://orders.store-a.com', 'orders.store-a.com/elan']) {
    const refused = await putOrderEndpoint({ orderEndpoint: bad });
    assert.deepEqual([refused.res.out.status, refused.res.out.body.error], [400, 'invalid_order_endpoint'], bad);
    assert.equal(refused.requests.some(call => call.options.method === 'POST'), false, `${bad}: nothing is written`);
  }
  const long = await putOrderEndpoint({ orderEndpoint: `https://orders.store-a.com/${'a'.repeat(500)}` });
  assert.equal(long.res.out.status, 400);
});

test('PUT keeps the saved order address when the form leaves it out, and removes it when the form sends an empty one', async () => {
  const kept = await putOrderEndpoint({ notes: 'x' }, { order_endpoint: 'https://orders.store-a.com/elan' });
  assert.equal(savedRow(kept).order_endpoint, 'https://orders.store-a.com/elan');
  const removed = await putOrderEndpoint({ orderEndpoint: '' }, { order_endpoint: 'https://orders.store-a.com/elan' });
  assert.equal(savedRow(removed).order_endpoint, null);
  const never = await putOrderEndpoint({});
  assert.equal(savedRow(never).order_endpoint, null);
});

// The hosts a store's payment windows may live on: the same rule as the database's check, so a bad list is refused with a clear answer
// before anything is written, and the form can leave the field out without wiping what is saved.
test('PUT saves the payment hosts clean (lower-case, no duplicates), from a list or from text typed in the form', async () => {
  const typed = await putOrderEndpoint({ paymentHosts: ' Pay.Store-A.com,\n pay2.store-a.com  pay.store-a.com ; ' });
  assert.equal(typed.res.out.status, 200);
  assert.deepEqual(savedRow(typed).payment_hosts, ['pay.store-a.com', 'pay2.store-a.com']);
  const listed = await putOrderEndpoint({ paymentHosts: ['pay.store-a.com'] });
  assert.deepEqual(savedRow(listed).payment_hosts, ['pay.store-a.com']);
  const ten = Array.from({ length: 10 }, (_, i) => `h${i}.store-a.com`);
  assert.deepEqual(savedRow(await putOrderEndpoint({ paymentHosts: ten })).payment_hosts, ten);
});

test('PUT refuses a payment host that is not an exact host name, and writes nothing', async () => {
  const bad = ['https://pay.store-a.com', 'pay.store-a.com/checkout', 'pay.store-a.com:8443', '*.store-a.com', 'pay', 'pay_x.store-a.com', '-a.store-a.com',
               'a..store-a.com', 'pay.store-a.com.', 'user@pay.store-a.com', 'pay.store-a.com?x=1', 'pay\u0645.store-a.com'];
  for (const host of bad) {
    const refused = await putOrderEndpoint({ paymentHosts: host });
    assert.deepEqual([refused.res.out.status, refused.res.out.body.error], [400, 'invalid_payment_hosts'], host);
    assert.equal(refused.requests.some(call => call.options.method === 'POST'), false, `${host}: nothing is written`);
  }
  for (const value of [['ok.store-a.com', 5], [{ host: 'pay.store-a.com' }], 7, true, Array.from({ length: 11 }, (_, i) => `h${i}.store-a.com`), 'a'.repeat(5000)]) {
    const refused = await putOrderEndpoint({ paymentHosts: value });
    assert.equal(refused.res.out.status, 400, JSON.stringify(value).slice(0, 40));
    assert.equal(refused.requests.some(call => call.options.method === 'POST'), false);
  }
});

test('PUT keeps the saved payment hosts when the form leaves them out, and removes them when it sends an empty list', async () => {
  const saved = { payment_hosts: ['pay.store-a.com'] };
  assert.deepEqual(savedRow(await putOrderEndpoint({ notes: 'x' }, saved)).payment_hosts, ['pay.store-a.com']);
  assert.deepEqual(savedRow(await putOrderEndpoint({ paymentHosts: '' }, saved)).payment_hosts, []);
  assert.deepEqual(savedRow(await putOrderEndpoint({ paymentHosts: [] }, saved)).payment_hosts, []);
  assert.deepEqual(savedRow(await putOrderEndpoint({})).payment_hosts, [], 'a store with nothing saved starts with no host');
});

test('the dashboard form carries the payment hosts field and says a host is part of being ready', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.js'), 'utf8');
  assert.match(dashboard, /inputField\('مضيفات نافذة الدفع[^']*', 'paymentHosts', \(store\.paymentHosts \|\| \[\]\)\.join\(', '\)/);
  assert.match(dashboard, /paymentHosts: get\('paymentHosts'\)\.value/);
  assert.match(dashboard, /مضيف نافذة دفع واحد على الأقل/);
  const portal = fs.readFileSync(path.join(__dirname, '..', 'portal.js'), 'utf8');
  assert.match(portal, /invalid_payment_hosts:\s*'/);
});
