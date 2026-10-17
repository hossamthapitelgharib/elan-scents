const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../railway/editor-data.js');

const SB = 'https://sb.example.test';

async function run({ body, token = 'good', role = 'platform_admin', tables = {}, race = null }) {
  const savedEnv = {};
  for (const [key, value] of Object.entries({ SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: 'service-test' })) {
    savedEnv[key] = process.env[key]; process.env[key] = value;
  }
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/auth/v1/user') return response(token === 'good' ? 200 : 401, token === 'good' ? { id: 'user-1' } : {});
    if (url.pathname === '/rest/v1/profiles') return response(200, [{ id: 'user-1', role }]);
    const table = url.pathname.split('/').pop();
    const rows = tables[table] || [];
    if (options.method === 'POST') {
      const row = JSON.parse(options.body)[0];
      const conflict = url.searchParams.get('on_conflict');
      const found = rows.find((record) => record[conflict] === row[conflict]);
      if (race && race.table === table) {
        tables[table] = rows.concat(race.record);
        return response(201, []);
      }
      if (found) return response(201, []);
      const inserted = { id: table + '-new', ...row };
      tables[table] = rows.concat(inserted);
      return response(201, [inserted]);
    }
    if (options.method && options.method !== 'GET') return response(405, {});
    const fieldEntry = Array.from(url.searchParams.entries()).find(([, value]) => value.startsWith('eq.'));
    let result = rows;
    if (fieldEntry) {
      const [field, value] = fieldEntry;
      result = rows.filter((record) => String(record[field]) === value.slice(3));
    }
    return response(200, result);
  };
  function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
  const res = { statusCode: 0, headers: {}, body: null, status(code) { this.statusCode = code; return this; }, setHeader(key, value) { this.headers[key] = value; return this; }, json(value) { this.body = value; return this; } };
  try { await handler({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body }, res); }
  finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  return { res, calls };
}

test('catalog create requires an authenticated platform administrator', async () => {
  for (const options of [{ token: '' }, { token: 'bad' }, { role: 'store_admin' }]) {
    const result = await run({ body: { action: 'catalog.create', kind: 'brand', name: 'New brand' }, ...options });
    assert.ok(result.res.statusCode === 401 || result.res.statusCode === 403);
    assert.equal(result.calls.some((call) => call.url.pathname.startsWith('/rest/v1/brands')), false);
  }
});

test('catalog create rejects unknown types, blank names, control characters and oversized names', async () => {
  for (const [kind, name] of [['unknown', 'Name'], ['brand', '   '], ['store', 'a\nname'], ['note', 'x'.repeat(121)]]) {
    const result = await run({ body: { action: 'catalog.create', kind, name } });
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.calls.some((call) => call.options.method === 'POST'), false);
  }
});

test('existing catalog names are matched case-insensitively without inserting duplicates', async () => {
  const tables = { brands: [{ id: 'brand-1', name: 'Maison Élan', slug: 'maison-elan' }] };
  const result = await run({ body: { action: 'catalog.create', kind: 'brand', name: '  MAISON   ÉLAN  ' }, tables });
  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body.created, false);
  assert.equal(result.res.body.record.id, 'brand-1');
  assert.equal(result.calls.some((call) => call.options.method === 'POST'), false);
});

test('new entities use only their real schema fields and database unique keys', async () => {
  const cases = [
    ['brand', 'brands', 'slug', { is_active: true }],
    ['store', 'stores', 'slug', { status: 'inactive' }],
    ['occasion', 'occasions', 'name', {}],
    ['note', 'aromatic_notes', 'name', {}]
  ];
  for (const [kind, table, conflict, extra] of cases) {
    const result = await run({ body: { action: 'catalog.create', kind, name: 'اسم جديد' }, tables: {} });
    assert.equal(result.res.statusCode, 200, JSON.stringify(result.res.body));
    assert.equal(result.res.body.created, true);
    const post = result.calls.find((call) => call.url.pathname === '/rest/v1/' + table && call.options.method === 'POST');
    assert.ok(post, table);
    assert.equal(post.url.searchParams.get('on_conflict'), conflict);
    assert.equal(post.options.headers.Prefer, 'resolution=ignore-duplicates,return=representation');
    const row = JSON.parse(post.options.body)[0];
    assert.equal(row.name, 'اسم جديد');
    assert.deepEqual(Object.keys(row).sort(), ['name', ...Object.keys(extra), ...(conflict === 'slug' ? ['slug'] : [])].sort());
    for (const [key, value] of Object.entries(extra)) assert.equal(row[key], value);
    assert.equal(Object.hasOwn(row, 'store_id'), false);
    assert.equal(Object.hasOwn(row, 'website_url'), false);
  }
});

test('concurrent create resolves the winning row only when its canonical name matches', async () => {
  const winner = { id: 'occasion-winner', name: 'هدية' };
  const tables = { occasions: [] };
  const same = await run({ body: { action: 'catalog.create', kind: 'occasion', name: 'هدية' }, tables, race: { table: 'occasions', record: winner } });
  assert.equal(same.res.statusCode, 200);
  assert.equal(same.res.body.created, false);
  assert.equal(same.res.body.record.id, 'occasion-winner');

  const conflictTables = { brands: [] };
  const slug = 'musk';
  const conflict = await run({ body: { action: 'catalog.create', kind: 'brand', name: 'Musk' }, tables: conflictTables, race: { table: 'brands', record: { id: 'unrelated', name: 'Other', slug } } });
  assert.equal(conflict.res.statusCode, 409);
  assert.equal(conflict.res.body.error, 'catalog_identity_conflict');
});
