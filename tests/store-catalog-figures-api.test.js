// POST /api/store-catalog-figures: the door through which a linked store reports the figures behind the four store rankings.
// The database side (validation, upsert, who may call the function) is tested in tests/store-catalog-figures-ingest.test.sql;
// here the Worker/Node handler is checked: only a store that proved itself with its own secret gets through, only for itself,
// nothing reaches the database before that, and a store never sees a raw database error.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const handler = require(path.join(root, 'api', 'store-catalog-figures'));
const { STORE_ID_HEADER } = require(path.join(root, 'lib', 'store-webhook-auth'));
const { digest } = require(path.join(root, 'lib', 'store-webhook-signature'));

const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const STORE_NO_SECRET = '33333333-3333-4333-8333-333333333333';
const STORE_UNKNOWN = '44444444-4444-4444-8444-444444444444';
const STORE_DISABLED = '55555555-5555-4555-8555-555555555555';
const SECRETS = { [STORE_A]: 'unit-test-secret-a-0123', [STORE_B]: 'unit-test-secret-b-0123', [STORE_NO_SECRET]: '', [STORE_DISABLED]: 'unit-test-secret-disabled' };
const DISABLED = new Set([STORE_DISABLED]);
const SERVICE_KEY = 'service-key-must-never-be-echoed';

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
test.beforeEach(() => { process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED = '0'; });

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { out.headers[name.toLowerCase()] = value; return this; }, json(body) { out.body = body; return this; }, end() { return this; } }; }
async function call(req) { const res = recorder(); await handler(req, res); return res.out; }

function installDatabase({ rpc } = {}) {
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const entry = { pathname: url.pathname, params: url.searchParams, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
    calls.push(entry);
    if (url.pathname === '/rest/v1/store_integrations') {
      const id = (url.searchParams.get('store_id') || '').replace(/^eq\./, '');
      const secret = SECRETS[id];
      return jsonResponse(secret === undefined ? [] : [{ webhook_secret: secret, enabled: !DISABLED.has(id) }]);
    }
    if (url.pathname === '/rest/v1/rpc/ingest_store_catalog_figures') {
      return rpc ? rpc(entry) : jsonResponse({ store_id: entry.body.p_store_id, offers: entry.body.p_figures.length, best_sellers: entry.body.p_figures.length, most_viewed: 0, most_searched: 0, ratings: 0, skipped_older_than_stored: 0 });
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  };
  return calls;
}
const rpcCalls = (calls) => calls.filter((c) => c.pathname.startsWith('/rest/v1/rpc/'));

let ipCounter = 0;
const nextIp = () => { ipCounter += 1; return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };
function report({ storeId = STORE_A, secret = SECRETS[STORE_A], body = { figures: [{ product_size_id: 'size-1', units_sold: 3 }] }, headers = {}, method = 'POST' } = {}) {
  const out = { 'x-real-ip': nextIp(), ...headers };
  if (storeId !== null) out[STORE_ID_HEADER] = storeId;
  if (secret !== null) out['x-store-webhook-secret'] = secret;
  return { method, headers: out, body };
}

test('a store that proved itself with its own secret reports its figures; the database call carries ONLY the authenticated store', async () => {
  const calls = installDatabase();
  const figures = [{ store_product_id: 'offer-1', units_sold: 12, views_count: 340 }, { product_size_id: 'size-2', average_rating: 4.6, ratings_count: 31 }];
  const out = await call(report({ body: { storeId: STORE_B, store_id: STORE_B, figures } }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, offers: 2, bestSellers: 2, mostViewed: 0, mostSearched: 0, ratings: 0, skippedOlderThanStored: 0 });
  const rpc = rpcCalls(calls);
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].body, { p_store_id: STORE_A, p_figures: figures }, 'the store id written in the body is ignored');
  assert.equal(rpc[0].headers.Authorization, `Bearer ${SERVICE_KEY}`, 'the call to the database is made by the server');
  assert.doesNotMatch(JSON.stringify(out.body), new RegExp(SERVICE_KEY));
});

test('nothing reaches the database for a request that did not prove itself: no store header, wrong / missing / empty / disabled / unknown', async () => {
  const cases = [
    ['no store header', report({ storeId: null })],
    ['not a uuid', report({ storeId: 'store-a' })],
    ['wrong secret', report({ secret: 'not-the-secret-at-all' })],
    ['no secret', report({ secret: null })],
    ['the other store\'s secret', report({ secret: SECRETS[STORE_B] })],
    ['a store without a secret', report({ storeId: STORE_NO_SECRET, secret: '' })],
    ['a switched-off integration', report({ storeId: STORE_DISABLED, secret: SECRETS[STORE_DISABLED] })],
    ['an unknown store', report({ storeId: STORE_UNKNOWN, secret: 'whatever-secret-value' })],
  ];
  for (const [label, req] of cases) {
    const calls = installDatabase();
    const out = await call(req);
    assert.equal(out.status, 401, label);
    assert.deepEqual(out.body, { ok: false, error: 'invalid_webhook_secret' }, `${label}: one answer for every failure`);
    assert.equal(rpcCalls(calls).length, 0, `${label}: the ingestion was not called`);
  }
});

test('only POST; OPTIONS answers the preflight without touching anything', async () => {
  const calls = installDatabase();
  assert.equal((await call(report({ method: 'GET' }))).status, 405);
  assert.equal((await call(report({ method: 'PUT' }))).status, 405);
  const pre = await call(report({ method: 'OPTIONS' }));
  assert.equal(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /X-Store-Id/i);
  assert.equal(calls.length, 0);
});

test('the report must be an array of at most 1000 offers; anything else is refused before the database', async () => {
  for (const body of [null, {}, { figures: 'x' }, { figures: { a: 1 } }, { figures: null }]) {
    const calls = installDatabase();
    const out = await call(report({ body }));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, 'figures_must_be_an_array');
    assert.equal(rpcCalls(calls).length, 0);
  }
  const calls = installDatabase();
  const out = await call(report({ body: { figures: Array.from({ length: 1001 }, () => ({ product_size_id: 's', units_sold: 1 })) } }));
  assert.equal(out.status, 400);
  assert.deepEqual(out.body, { ok: false, error: 'too_many_figures', max: 1000 });
  assert.equal(rpcCalls(calls).length, 0);
  const ok = await call(report({ body: { figures: Array.from({ length: 1000 }, () => ({ product_size_id: 's', units_sold: 1 })) } }));
  assert.equal(ok.status, 200, '1000 is allowed');
});

test('the store is told what is wrong with ITS report, in the database\'s own validation words, and nothing else the database says', async () => {
  const refuse = (message, code = '22023', status = 400) => ({ rpc: () => jsonResponse({ code, message, details: 'internal detail', hint: 'internal hint' }, status) });
  for (const message of ['item 2: units_sold must be a whole number from 0 to 2000000000', 'item 1: this store has no such offer', 'item 3: average_rating and ratings_count go together', 'at most 1000 offers per call', 'p_figures must be a JSON array of objects']) {
    installDatabase(refuse(message));
    const out = await call(report());
    assert.equal(out.status, 422, message);
    assert.deepEqual(out.body, { ok: false, error: 'invalid_figures', message });
  }
  // a database error that is not one of those messages never reaches the store
  for (const [code, message, status] of [['22023', 'unknown store', 400], ['42501', 'permission denied for function ingest_store_catalog_figures', 403], ['XX000', 'something internal: password=hunter2', 500], ['22023', 'item 2: ' + 'x'.repeat(400), 400]]) {
    installDatabase(refuse(message, code, status));
    const out = await call(report());
    assert.ok([400, 502].includes(out.status), `${code}: ${out.status}`);
    assert.equal(out.body.error, 'supabase_update_failed');
    assert.doesNotMatch(JSON.stringify(out.body), /hunter2|permission denied|internal|unknown store|xxxx/, 'no raw database text');
  }
  // our own credentials failing is never reported as the store's mistake
  installDatabase({ rpc: () => jsonResponse({ message: 'JWT expired' }, 401) });
  assert.equal((await call(report())).status, 502);
  // a network failure
  installDatabase({ rpc: () => { throw new TypeError('fetch failed'); } });
  const down = await call(report());
  assert.equal(down.status, 502);
  assert.equal(down.body.error, 'catalog_figures_processing_failed');
});

test('when signatures are required an unsigned report is refused and a correctly signed one is accepted', async () => {
  process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED = '1';
  try {
    const calls = installDatabase();
    const body = { figures: [{ product_size_id: 'size-1', units_sold: 3 }] };
    const unsigned = await call(report({ body }));
    assert.equal(unsigned.status, 401);
    assert.equal(rpcCalls(calls).length, 0);
    const timestamp = String(Math.floor(Date.now() / 1000)), eventId = crypto.randomUUID();
    const signature = digest(SECRETS[STORE_A], timestamp, eventId, body);
    const signed = await call(report({ body, headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-id': eventId, 'x-webhook-signature': signature } }));
    assert.equal(signed.status, 200);
    const forged = await call(report({ body: { figures: [{ product_size_id: 'size-1', units_sold: 999999 }] }, headers: { 'x-webhook-timestamp': timestamp, 'x-webhook-id': eventId, 'x-webhook-signature': signature } }));
    assert.equal(forged.status, 401, 'a signature does not cover a different body');
  } finally { delete process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED; }
});

test('the catalog webhook requires a signature by default when no environment value is configured', async () => {
  delete process.env.STORE_WEBHOOK_SIGNATURE_REQUIRED;
  const calls = installDatabase();
  const result = await call(report());
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'invalid_webhook_signature');
  assert.equal(rpcCalls(calls).length, 0);
});

test('the handler is registered for the Worker bundle and has no shared-secret path', () => {
  const registry = require(path.join(root, 'cloudflare', 'api-registry.js'));
  assert.equal(typeof registry.api['store-catalog-figures'], 'function');
  assert.equal(registry.api['store-catalog-figures'](), handler);
  const source = require('node:fs').readFileSync(path.join(root, 'api', 'store-catalog-figures.js'), 'utf8');
  assert.doesNotMatch(source, /checkSecret|STORE_ORDER_WEBHOOK_SECRET|LEGACY_WEBHOOK/, 'a figure always belongs to one store, which must prove itself with its own secret');
});
