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
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['DASHBOARD_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.before(() => {
  process.env.DASHBOARD_TOKEN = 'dashboard-secret';
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
});
test.after(() => {
  global.fetch = savedFetch;
  for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
});

function request(method = 'GET', body) {
  return { method, headers: { 'x-dashboard-token': 'dashboard-secret', host: 'admin.example' }, body };
}

test('store integrations reject requests without the dashboard token before calling Supabase', async () => {
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected'); };
  const res = recorder();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.out.status, 401);
  assert.equal(called, false);
});

test('GET reads the normalized per-store row and returns only masked secrets', async () => {
  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/public_stores') return response([{ id: storeId, name: 'Store A', short_description: 'A store' }]);
    if (url.pathname === '/rest/v1/store_integrations') return response([{
      store_id: storeId, enabled: false, base_url: 'https://store.example', cart_url: 'https://store.example/cart',
      api_base_url: 'https://api.store.example', catalog_endpoint: '/items', api_key: 'TOPSECRETKEY123',
      webhook_secret: 'HOOKSECRETKEY456', notes: 'connected',
    }]);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  };
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
});

test('GET supports legacy site_settings values until they are resaved in normalized rows', async () => {
  global.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/rest/v1/public_stores') return response([{ id: storeId, name: 'Store A' }]);
    if (url.pathname === '/rest/v1/store_integrations') return response([]);
    if (url.pathname === '/rest/v1/site_settings') return response([{ value: JSON.stringify({ 'Store A': {
      enabled: true, baseUrl: 'https://legacy.example', apiKey: 'LEGACYKEY98765', webhookSecret: 'LEGACYHOOK76543',
    } }) }]);
    throw new Error(`unexpected ${url.pathname}`);
  };
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
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/stores') return response([{ id: storeId, name: 'Store A' }]);
    if (url.pathname === '/rest/v1/store_integrations' && options.method === 'POST') return response(null, 201);
    if (url.pathname === '/rest/v1/store_integrations') return response([{
      store_id: storeId, api_key: 'PRESERVEDAPIKEY', webhook_secret: 'PRESERVEDHOOKSECRET',
    }]);
    if (url.pathname === '/rest/v1/site_settings') return response([]);
    throw new Error(`unexpected ${url.pathname} ${options.method}`);
  };
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
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)); requests.push({ url, options });
    if (url.pathname === '/rest/v1/stores') return response([]);
    throw new Error(`unexpected ${url.pathname}`);
  };
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
