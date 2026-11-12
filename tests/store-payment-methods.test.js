// /api/store-payment-methods (phase 2): a store manages the payment methods it offers inside the Elan experience.
// Page addresses and public labels only (a card is paid on the merchant's own page, so no card data and no secret is ever stored),
// a store admin reaches only its own store, nothing is deleted (a method is switched off), and the platform admin names the store.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'store-payment-methods'));

const userId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeA = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const storeB = 'e7bc2e9e-2198-4223-9287-2321e2fd9d66';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map((key) => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [k, v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; });

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function recorder() { const out = { headers: {} }; return { out, status(v) { out.status = v; return this; }, setHeader(k, v) { out.headers[k] = v; return this; }, json(b) { out.body = b; return this; } }; }
async function call({ role = 'store_admin', method = 'POST', body, query, memberships = [{ store_id: storeA }], database } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response({ id: userId });
    if (url.pathname === '/rest/v1/profiles') return response([{ id: userId, role }]);
    if (url.pathname === '/rest/v1/store_accounts') return response(memberships);
    if (url.pathname === '/rest/v1/store_payment_methods') return database ? database(url, options) : response(method === 'GET' ? [] : [{ id: 'm1', ...JSON.parse(options.body || '{}') }]);
    throw new Error(`unexpected ${url.pathname}`);
  };
  const res = recorder();
  await handler({ method, body, query, headers: { authorization: 'Bearer test-token' } }, res);
  return { res: res.out, writes: calls.filter((c) => c.url.pathname === '/rest/v1/store_payment_methods' && c.options.method && c.options.method !== 'GET'), calls };
}
const COD = { kind: 'cod', labelAr: 'الدفع عند الاستلام' };
const CARD = { kind: 'card', labelAr: 'بطاقة', provider: 'paymob', redirectUrl: 'https://pay.example.com/checkout' };

test('a store admin with a single store adds methods to that store; the row is always written for the store the account belongs to', async () => {
  const { res, writes } = await call({ body: { ...COD, storeId: storeA } });
  assert.equal(res.status, 200);
  const row = JSON.parse(writes[0].options.body);
  assert.equal(row.store_id, storeA);
  assert.equal(row.kind, 'cod');
  assert.equal(row.mode, 'none');
  assert.equal(row.redirect_url, null);
  const card = await call({ body: CARD });
  assert.equal(JSON.parse(card.writes[0].options.body).redirect_url, 'https://pay.example.com/checkout');
});

test('a store admin can not reach another store, and the platform admin must name the store', async () => {
  const other = await call({ body: { ...COD, storeId: storeB } });
  assert.equal(other.res.status, 403);
  assert.equal(other.writes.length, 0);
  const many = await call({ body: COD, memberships: [{ store_id: storeA }, { store_id: storeB }] });
  assert.equal(many.res.status, 400);
  assert.equal(many.res.body.error, 'store_required');
  const platform = await call({ role: 'platform_admin', body: COD });
  assert.equal(platform.res.status, 400);
  const named = await call({ role: 'platform_admin', body: { ...COD, storeId: storeB } });
  assert.equal(named.res.status, 200);
  assert.equal(JSON.parse(named.writes[0].options.body).store_id, storeB);
  assert.equal((await call({ role: 'customer', body: COD })).res.status, 403);
});

test('a card is paid on a merchant page: https only, no card data, no secret, cash on delivery has no page', async () => {
  const bad = [
    [{ ...CARD, redirectUrl: 'http://pay.example.com' }, 'invalid_payment_page'],
    [{ ...CARD, redirectUrl: 'javascript:alert(1)' }, 'invalid_payment_page'],
    [{ ...CARD, redirectUrl: 'https://user:pw@pay.example.com' }, 'invalid_payment_page'],
    [{ ...CARD, redirectUrl: '' }, 'invalid_payment_page'],
    [{ ...CARD, mode: 'none' }, 'online_method_needs_page'],
    [{ ...COD, redirectUrl: 'https://pay.example.com' }, 'cod_has_no_payment_page'],
    [{ ...COD, mode: 'redirect' }, 'cod_has_no_payment_page'],
    [{ ...CARD, hostedConfig: { apiSecret: 'x' } }, 'hosted_config_must_be_public'],
    [{ ...CARD, hostedConfig: { cardNumber: '4111' } }, 'hosted_config_must_be_public'],
    [{ ...CARD, hostedConfig: { a: 1 } }, 'invalid_hosted_config'],
    [{ ...CARD, kind: 'bitcoin' }, 'invalid_kind'],
    [{ ...CARD, labelAr: '' }, 'label_required'],
    [{ ...CARD, labelAr: 'x'.repeat(81) }, 'label_required']
  ];
  for (const [body, error] of bad) {
    const { res, writes } = await call({ body });
    assert.equal(res.status, 400, error);
    assert.equal(res.body.error, error);
    assert.equal(writes.length, 0, 'nothing is written for a refused method');
  }
});

test('a method is changed only inside the store, switched off instead of deleted, and the list shows only that store', async () => {
  const methodId = 'a1111111-1111-4111-8111-111111111111';
  const { res, writes } = await call({ body: { ...COD, id: methodId, enabled: false } });
  assert.equal(res.status, 200);
  assert.equal(writes[0].options.method, 'PATCH');
  assert.equal(writes[0].url.searchParams.get('store_id'), `eq.${storeA}`, 'the id alone never selects a row of another store');
  assert.equal(JSON.parse(writes[0].options.body).enabled, false);
  assert.equal((await call({ method: 'DELETE' })).res.status, 405);
  const list = await call({ method: 'GET', query: {}, database: async () => response([{ id: 'm1' }]) });
  assert.equal(list.res.status, 200);
  assert.equal(list.res.body.storeId, storeA);
  const listed = list.calls.find((c) => c.url.pathname === '/rest/v1/store_payment_methods');
  assert.equal(listed.url.searchParams.get('store_id'), `eq.${storeA}`);
});

test('the database refusing a method is a 422 with a plain name, never a raw error', async () => {
  const { res } = await call({ body: CARD, database: async () => response({ code: '23514', message: 'new row violates check constraint "store_payment_methods_hosted_is_public"' }, 400) });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'invalid_payment_method');
  const down = await call({ body: CARD, database: async () => response({ code: 'XX000', message: 'internal detail' }, 500) });
  assert.equal(down.res.status, 502);
  assert.doesNotMatch(JSON.stringify(down.res.body), /internal detail/);
});
