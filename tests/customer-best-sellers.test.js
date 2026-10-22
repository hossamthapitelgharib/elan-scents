const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'customer-best-sellers'));
const root = path.join(__dirname, '..');
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const savedEnv = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].map(key => [key, process.env[key]]));
const savedFetch = global.fetch;
test.after(() => { global.fetch = savedFetch; for (const [key, value] of Object.entries(savedEnv)) value === undefined ? delete process.env[key] : process.env[key] = value; });
function response(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out = { headers: {} }; return { out, status(value) { out.status = value; return this; }, setHeader(key, value) { out.headers[key] = value; return this; }, json(body) { out.body = body; return this; } }; }
async function run(role, query, rpcResult, rpcStatus = 200) {
  process.env.SUPABASE_URL = 'https://test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = String(input); calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return response({ id: adminId });
    if (url.includes('/profiles?')) return response([{ id: adminId, role }]);
    if (url.endsWith('/rpc/platform_registered_customer_best_sellers')) return response(rpcResult, rpcStatus);
    throw new Error(`unexpected ${url}`);
  };
  const res = recorder();
  await handler({ method: 'GET', headers: { authorization: 'Bearer admin-token' }, query }, res);
  return { res: res.out, calls };
}

const report = {
  period: 'all', fromDate: null, toDate: '2026-10-16', limit: 50, offset: 0,
  total: '1', hasMore: false,
  records: [{ rank: '1', product: { id: 'perfume-id', name: 'Rose', brand_name: 'Élan', slug: 'rose', private: 'discard' }, unitsSold: '12', purchases: '8', storeCount: '3', sizeBreakdown: [{ size: '50 مل', units: '4' }, { size: '100 مل', units: '8' }], hidden: 'discard' }],
  audit: { registeredUnits: '15', eligiblePurchases: '8', eligibleUnits: '12', rankedUnits: '12', unlinkedEligibleUnits: '0', unlinkedEligibleLines: '0', reversedUnits: '2', excludedCancelledUnits: '1', excludedInProgressUnits: '0', excludedReviewOrMismatchUnits: '0', excludedOtherUnits: '0', ownerConflictUnits: '0', unregisteredUnitsExcluded: '0', returnsAndRefundsTracked: true, raw_payload: 'discard' }
};

test('best-seller API returns only sanitized paginated metrics to platform admins', async () => {
  const { res, calls } = await run('platform_admin', { period: 'all', limit: '50', offset: '0' }, report);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, {
    ok: true, period: 'all', fromDate: null, toDate: '2026-10-16', limit: 50, offset: 0, total: 1, hasMore: false,
    records: [{ rank: 1, product: { id: 'perfume-id', name: 'Rose', brand_name: 'Élan', slug: 'rose' }, unitsSold: 12, purchases: 8, storeCount: 3, sizeBreakdown: [{ size: '50 مل', units: 4 }, { size: '100 مل', units: 8 }] }],
    audit: { registeredUnits: 15, eligiblePurchases: 8, eligibleUnits: 12, rankedUnits: 12, unlinkedEligibleUnits: 0, unlinkedEligibleLines: 0, reversedUnits: 2, excludedCancelledUnits: 1, excludedInProgressUnits: 0, excludedReviewOrMismatchUnits: 0, excludedOtherUnits: 0, ownerConflictUnits: 0, unregisteredUnitsExcluded: 0, returnsAndRefundsTracked: true }
  });
  const rpc = calls.find(call => call.url.endsWith('/rpc/platform_registered_customer_best_sellers'));
  assert.ok(rpc);
  assert.equal(rpc.options.headers.Authorization, 'Bearer service-key');
  assert.deepEqual(JSON.parse(rpc.options.body), { p_period: 'all', p_limit: 50, p_offset: 0 });
});

test('best-seller API rejects non-admins and invalid filters or pages before calling the database', async () => {
  const denied = await run('customer', { period: 'all' }, report);
  assert.equal(denied.res.status, 403);
  assert.equal(denied.calls.some(call => call.url.endsWith('/rpc/platform_registered_customer_best_sellers')), false);
  for (const query of [{ period: 'forever' }, { limit: '101' }, { offset: '-1' }]) {
    const { res, calls } = await run('platform_admin', query, report);
    assert.equal(res.status, 400);
    assert.equal(calls.some(call => call.url.endsWith('/rpc/platform_registered_customer_best_sellers')), false);
  }
});

test('best-seller API hides database errors and rejects unsupported methods', async () => {
  const { res } = await run('platform_admin', {}, { message: 'raw database detail' }, 500);
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { ok: false, error: 'best_sellers_unavailable' });
  const methodRes = recorder();
  await handler({ method: 'POST', headers: {}, query: {} }, methodRes);
  assert.equal(methodRes.out.status, 405);
});

test('best-seller SQL uses immutable product IDs and auditable registered-sale eligibility with stable descending order', () => {
  const dirs = ['migrations', 'pending'].map(dir => path.join(root, 'supabase', dir));
  const file = dirs.flatMap(dir => fs.existsSync(dir) ? fs.readdirSync(dir) : []).find(name => name.endsWith('_registered_customer_best_sellers.sql'));
  assert.ok(file, 'registered customer best-seller migration exists');
  const migration = fs.readFileSync(dirs.map(dir => path.join(dir, file)).find(candidate => fs.existsSync(candidate)), 'utf8');
  assert.match(migration, /add column if not exists product_id uuid/i);
  assert.match(migration, /product_id, product_name, brand_name, size_label, quantity/i);
  assert.match(migration, /coalesce\(user_id, checkout_user_id\) is not null/i);
  assert.match(migration, /status = 'completed' and reconciliation_status = 'matched'/i);
  assert.match(migration, /status = 'delivered' and reconciliation_status in \('matched','pending'\)/i);
  assert.match(migration, /owner_conflict/i);
  assert.match(migration, /quantity > 0/i);
  assert.match(migration, /order by pt\.units_sold desc,pt\.purchase_count desc,pt\.product_id asc/i);
  assert.match(migration, /'returnsAndRefundsTracked',false/i);
  assert.match(migration, /grant execute on function public\.platform_registered_customer_best_sellers\(text,integer,integer\) to service_role/i);
  assert.equal((migration.match(/with line_scope as materialized/gi) || []).length, 1, 'order lines and quality metrics are computed from one shared scan');
});

// The newest SQL definition of the ranking function across supabase/migrations and supabase/pending.
function latestBestSellerFunction() {
  const entries = ['migrations', 'pending'].map(dir => path.join(root, 'supabase', dir))
    .filter(dir => fs.existsSync(dir))
    .flatMap(dir => fs.readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => ({ name, file: path.join(dir, name) })))
    .sort((a, b) => a.name.localeCompare(b.name));
  const definers = entries.filter(entry => /create or replace function public\.platform_registered_customer_best_sellers\s*\(/i.test(fs.readFileSync(entry.file, 'utf8')));
  assert.ok(definers.length > 0, 'the best-seller function is defined by a migration');
  const latest = definers[definers.length - 1];
  return { name: latest.name, sql: fs.readFileSync(latest.file, 'utf8') };
}

test('every audit field the best-seller API reads is produced by the newest SQL definition of the function', () => {
  const api = fs.readFileSync(path.join(root, 'api', 'customer-best-sellers.js'), 'utf8');
  const keys = [...new Set([...api.matchAll(/result\.audit\.(\w+)/g)].map(match => match[1]))];
  assert.ok(keys.length >= 14, 'the API reads the whole audit contract');
  assert.ok(keys.includes('reversedUnits'), 'the API passes returned and refunded units through');
  const { name, sql } = latestBestSellerFunction();
  for (const key of keys) assert.match(sql, new RegExp(`'${key}'\\s*,`), `${name} must return the audit field ${key}`);
});

test('newest best-seller SQL keeps the ranking rules, tracks returns and reconciles every registered unit', () => {
  const { name, sql } = latestBestSellerFunction();
  assert.match(sql, /coalesce\(user_id,\s*checkout_user_id\) is not null/i, `${name}: registered customers only`);
  assert.match(sql, /status\s*=\s*'completed'\s+and\s+reconciliation_status\s*=\s*'matched'/i, `${name}: completed orders must be matched`);
  assert.match(sql, /status\s*=\s*'delivered'\s+and\s+reconciliation_status\s+in\s*\('matched','pending'\)/i, `${name}: delivered orders`);
  assert.match(sql, /store_order_item_adjustments/i, `${name}: returns and refunds`);
  assert.match(sql, /greatest\(ordered_quantity\s*-\s*reversed_quantity,\s*0\)/i, `${name}: net units`);
  assert.match(sql, /order by pt\.units_sold desc,\s*pt\.purchase_count desc,\s*pt\.product_id/i, `${name}: units, then purchases`);
  assert.match(sql, /sum\(reversed_quantity\) filter \(where not owner_conflict and status_eligible\)/i, `${name}: fully returned lines are counted as reversed`);
  assert.match(sql, /'returnsAndRefundsTracked',\s*true/i, `${name}: returns tracked`);
  assert.match(sql, /grant execute on function public\.platform_registered_customer_best_sellers\(text,integer,integer\) to service_role/i);
  assert.equal((sql.match(/with line_scope as materialized/gi) || []).length, 1, `${name}: one shared scan`);
});

test('registered-customer dashboard exposes the best-seller ranking and audit information only in the registered section', () => {
  const html = fs.readFileSync(path.join(root, 'customers-dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'customers-dashboard.js'), 'utf8');
  assert.match(html, /id="registeredBestSellersTitle">عطور الأكثر مبيعًا/);
  assert.match(html, /id="registeredBestSellersPeriod"/);
  assert.match(html, /id="registeredBestSellersAudit"/);
  assert.match(html, /id="registeredBestSellersTable"/);
  assert.match(html, /يُخصم المرتجع أو المسترد المكتمل من العدد/);
  assert.doesNotMatch(html, /لا توجد حاليًا بيانات موثقة للمرتجعات/, 'returns and refunds are tracked, so the note must not say they are not');
  assert.match(js, /api\/customer-best-sellers/);
  assert.match(js, /data-best-sellers-more/);
  assert.match(js, /excludedReviewOrMismatchUnits/);
  assert.match(js, /audit\.reversedUnits/, 'the audit details list the returned and refunded units');
  assert.match(js, /ensureBestSellers/);
});
