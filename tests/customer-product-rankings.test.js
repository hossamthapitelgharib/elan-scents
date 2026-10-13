const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'customer-product-rankings'));
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, query, rpcResult) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input); calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (url.includes('/profiles?')) return response([{ id: adminId, role }]);
    if (url.endsWith('/rpc/customer_product_ranking')) return response(rpcResult);
    throw new Error(`unexpected ${url}`);
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query }, res);
  return { res: res.out, calls };
}

test('ranking API returns server-paged full product snapshots only to platform admins', async () => {
  const snapshot = { id: 'perfume-1', name: 'Rose', brand: { name: 'Élan' }, selectedSize: { label: '100 ml' }, selectedOffer: { price: 1250 } };
  const { res, calls } = await run('platform_admin', { actor: 'guest', period: 'month', eventType: 'cart_add', limit: '20', offset: '40' }, { records: [{ product: snapshot, operations: '48', people: '21', hidden: 'not-forwarded' }], total: 65, hasMore: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, { ok: true, actorType: 'guest', period: 'month', eventType: 'cart_add', limit: 20, offset: 40, total: 65, hasMore: true, records: [{ product: snapshot, operations: 48, people: 21 }] });
  const rpc = calls.find(call => call.url.endsWith('/rpc/customer_product_ranking'));
  assert.equal(rpc.options.headers.Authorization, 'Bearer service-key');
  assert.deepEqual(JSON.parse(rpc.options.body), { p_actor_type: 'guest', p_period: 'month', p_event_type: 'cart_add', p_limit: 20, p_offset: 40 });
});

test('ranking API rejects non-admins and malformed scope or paging without running the RPC', async () => {
  const denied = await run('customer', { actor: 'guest' }, {});
  assert.equal(denied.res.status, 403);
  assert.equal(denied.calls.some(call => call.url.endsWith('/rpc/customer_product_ranking')), false);

  for (const query of [{ actor: 'visitor' }, { period: 'all' }, { eventType: 'checkout' }, { limit: '101' }, { offset: '-1' }]) {
    const { res, calls } = await run('platform_admin', query, {});
    assert.equal(res.status, 400);
    assert.equal(calls.some(call => call.url.endsWith('/rpc/customer_product_ranking')), false);
  }
});

test('database ranking pages sort operations descending with deterministic tie-breakers', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261013112836_customer_product_rankings.sql'), 'utf8');
  assert.match(migration, /order by sum\(a\.event_count\) desc,\s*count\(distinct a\.visitor_hash\) desc,\s*a\.product_id asc/i);
  assert.match(migration, /order by count\(\*\) desc,\s*count\(distinct e\.user_id\) desc,\s*e\.product_id asc/i);
  assert.equal((migration.match(/limit p_limit offset p_offset/gi) || []).length, 2);
});
