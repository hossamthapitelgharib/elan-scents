const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'dashboard-orders'));

function recorder() { const out = {}; return { out, status(n) { out.status = n; return this; }, setHeader(name, value) { (out.headers = out.headers || {})[name] = value; return this; }, json(body) { out.body = body; return this; } }; }
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const storeId = 'f6ab1d8d-1087-4112-8976-1210d1ec8c55';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });

/* A fake Supabase: the caller's role, and what the order table answers (rows, status, content-range). */
function fake(role, { rows = [], status = 200, range = null, body } = {}) {
  process.env.SUPABASE_URL = 'https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const reads = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: adminId }), { status: 200 });
    if (url.pathname === '/rest/v1/profiles') return new Response(JSON.stringify([{ id: adminId, role }]), { status: 200 });
    if (url.pathname === '/rest/v1/store_order_requests') {
      reads.push({ params: url.searchParams, headers: options.headers });
      const headers = { 'Content-Type': 'application/json' };
      if (range) headers['content-range'] = range;
      return new Response(body !== undefined ? body : JSON.stringify(rows), { status, headers });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  return reads;
}
async function call(query = {}, method = 'GET') { const res = recorder(); await handler({ method, query, headers: { authorization: 'Bearer token' } }, res); return res.out; }

test('only a platform admin may read the orders; nothing is read for anyone else', async () => {
  for (const role of ['customer', 'store_admin']) {
    const reads = fake(role);
    assert.equal((await call()).status, 403, role);
    assert.equal(reads.length, 0);
  }
  global.fetch = async () => { throw new Error('no request without a token'); };
  const res = recorder();
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  assert.equal(res.out.status, 401);
  const reads = fake('platform_admin');
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await call({}, method)).status, 405, method);
  assert.equal(reads.length, 0);
});

test('with no filter it reads the newest 100 with an exact count, using the service key, and is never cached', async () => {
  const reads = fake('platform_admin', { rows: [{ id: 'r1' }], range: '0-0/1' });
  const out = await call();
  assert.equal(out.status, 200);
  assert.equal(out.headers['Cache-Control'], 'no-store');
  const { params, headers } = reads[0];
  assert.equal(params.get('order'), 'created_at.desc,id.desc');
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('offset'), '0');
  assert.equal(params.has('and'), false);
  assert.equal(headers.Prefer, 'count=exact');
  assert.equal(headers.Authorization, 'Bearer service-key');
  assert.deepEqual({ ...out.body.pagination }, { limit: 100, offset: 0, total: 1, hasMore: false });
});

test('status, reconciliation, store and tracking filters become exact column filters', async () => {
  const reads = fake('platform_admin');
  await call({ status: 'needs_review', matchStatus: 'mismatched', storeId, tracking: 'ELN-2026 (x),*%' });
  const { params } = reads[0];
  assert.equal(params.get('status'), 'eq.needs_review');
  assert.equal(params.get('reconciliation_status'), 'eq.mismatched');
  assert.equal(params.get('store_id'), `eq.${storeId}`);
  assert.equal(params.get('tracking_number'), 'ilike.*ELN-2026 x*', 'filter syntax is stripped from the tracking text');
});

test('the search box looks in the tracking numbers, the customer name and the phone, with plain text only', async () => {
  const reads = fake('platform_admin');
  await call({ q: '  أحمد, (محمد)*%  ' });
  const and = reads[0].params.get('and');
  assert.equal(and, '(or(tracking_number.ilike.*أحمد محمد*,checkout_tracking_number.ilike.*أحمد محمد*,customer_name.ilike.*أحمد محمد*,customer_phone.ilike.*أحمد محمد*))');
  const empty = fake('platform_admin');
  await call({ q: '(),*%' });
  assert.equal(empty[0].params.has('and'), false, 'a search of only symbols is no search');
  const long = fake('platform_admin');
  await call({ q: 'a'.repeat(500) });
  assert.ok(long[0].params.get('and').includes(`*${'a'.repeat(60)}*`) && !long[0].params.get('and').includes('a'.repeat(61)), 'the text is cut to 60 characters');
});

test('the date range, the attention filter and the search can be used together', async () => {
  const reads = fake('platform_admin');
  await call({ from: '2026-10-01', to: '2026-10-30T12:00:00Z', attention: '1', q: '0100' });
  const { params } = reads[0];
  assert.equal(params.get('created_at'), 'gte.2026-10-01');
  assert.equal(params.get('and'), '(created_at.lt.2026-10-30T12:00:00Z,or(status.eq.needs_review,reconciliation_status.eq.mismatched),or(tracking_number.ilike.*0100*,checkout_tracking_number.ilike.*0100*,customer_name.ilike.*0100*,customer_phone.ilike.*0100*))');
  assert.equal(params.has('or'), false, 'no second top-level or that would replace the first');
});

test('every bad filter is refused with its own code before the database is read', async () => {
  const reads = fake('platform_admin');
  const cases = [
    [{ status: 'nope' }, 'invalid_status'], [{ status: ['completed', 'shipped'] }, 'invalid_status'],
    [{ matchStatus: 'nope' }, 'invalid_match_status'], [{ storeId: 'not-a-uuid' }, 'invalid_store_id'],
    [{ from: '2026-10-01),or(id.gt.0' }, 'invalid_date'], [{ to: 'tomorrow' }, 'invalid_date'], [{ to: '2026-10-01),or(id.gt.0,x.eq.1' }, 'invalid_date'],
    [{ limit: '0' }, 'invalid_page'], [{ limit: '101' }, 'invalid_page'], [{ offset: '-1' }, 'invalid_page'], [{ offset: 'abc' }, 'invalid_page']
  ];
  for (const [query, error] of cases) {
    const out = await call(query);
    assert.equal(out.status, 400, JSON.stringify(query));
    assert.equal(out.body.error, error, JSON.stringify(query));
  }
  assert.equal(reads.length, 0);
});

test('a date with a time zone offset is accepted', async () => {
  const reads = fake('platform_admin');
  assert.equal((await call({ from: '2026-10-01T08:30:00+03:00', to: '2026-10-02 08:30' })).status, 200);
  assert.equal(reads[0].params.get('created_at'), 'gte.2026-10-01T08:30:00+03:00');
});

test('the page says if there is another one, from the exact total when the database gives it', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }));
  fake('platform_admin', { rows, range: '0-99/250' });
  let out = await call({ limit: '100', offset: '0' });
  assert.deepEqual({ ...out.body.pagination }, { limit: 100, offset: 0, total: 250, hasMore: true });
  fake('platform_admin', { rows: rows.slice(0, 50), range: '200-249/250' });
  out = await call({ limit: '100', offset: '200' });
  assert.equal(out.body.pagination.hasMore, false);
  fake('platform_admin', { rows, range: '0-99/*' });
  out = await call({ limit: '100' });
  assert.equal(out.body.pagination.total, null);
  assert.equal(out.body.pagination.hasMore, true, 'a full page and an unknown total means there may be more');
});

test('a database failure is a 502 with a stable code and no database text', async () => {
  fake('platform_admin', { status: 500, body: JSON.stringify({ message: 'relation does not exist', code: '42P01' }) });
  let out = await call();
  assert.equal(out.status, 502);
  assert.equal(out.body.error, 'store_order_read_failed');
  assert.ok(!JSON.stringify(out.body).includes('relation'));
  fake('platform_admin', { body: 'not json' });
  out = await call();
  assert.equal(out.status, 502);
  fake('platform_admin', { body: JSON.stringify({ not: 'a list' }) });
  assert.equal((await call()).status, 502);
});
